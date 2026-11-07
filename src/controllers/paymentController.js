const crypto = require('crypto');
const { readDb, writeDb } = require('../models/db');
require('dotenv').config();

function sanitizeOrder(order) {
  if (!order || typeof order !== 'object') return order;
  const clone = { ...order };
  delete clone.deliveryOtp;
  return clone;
}

/**
 * Returns public Key ID for Android apps
 */
function getRazorpayKey(req, res) {
  res.json({
    success: true,
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_TqxS4IwcLyKe3t'
  });
}

/**
 * Verifies Razorpay payment signature with strict Idempotency & Lifecycle Status Protection
 * Guarding against:
 * 1) Duplicate / Replay payment verification calls
 * 2) Reversing PREPARING, ON_THE_WAY, DELIVERED orders back to PLACED
 * 3) Reversing CANCELLED orders back to PLACED
 * 4) Duplicate merchant notifications & duplicate wallet credits
 */
function verifyPayment(req, res) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Incomplete payment credentials' });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET || '42zBkhYMQAsU6aRgsQMM1d45';
    const body = razorpay_order_id + '|' + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature! Fraud warning.' });
    }

    const db = readDb();
    const order = (db.orders || []).find(o => o.orderId === orderId || (o.razorpayOrderId && o.razorpayOrderId === razorpay_order_id));
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // --- IDEMPOTENCY & STATUS INTEGRITY GUARDS ---

    // 1. Exact Duplicate Payment ID (Idempotent 200 OK)
    if (order.paymentStatus === 'PAID' && order.razorpayPaymentId === razorpay_payment_id) {
      return res.json({
        success: true,
        isDuplicate: true,
        message: 'Payment already verified and recorded for this order.',
        paymentId: razorpay_payment_id,
        order
      });
    }

    // 2. Conflicting Payment ID on already-paid order (Reject Replay Attack)
    if (order.paymentStatus === 'PAID' && order.razorpayPaymentId && order.razorpayPaymentId !== razorpay_payment_id) {
      return res.status(409).json({
        success: false,
        message: 'Order is already paid under a different transaction ID. Duplicate payment rejected.',
        order: sanitizeOrder(order)
      });
    }

    // 3. Status Guard: Order was already CANCELLED
    if (order.orderStatus === 'CANCELLED') {
      order.paymentStatus = 'REFUND_PENDING';
      order.cancelledPaymentId = razorpay_payment_id;
      writeDb(db);
      return res.status(400).json({
        success: false,
        message: 'Order was cancelled before payment confirmation. Status preserved as CANCELLED; flagged for refund.',
        order: sanitizeOrder(order)
      });
    }

    // 4. Status Guard: Order is already in active or terminal stage
    // (Never revert PREPARING, ACCEPTED, ON_THE_WAY, DELIVERED back to PLACED)
    const POST_PLACED_STATUSES = [
      'PLACED',
      'ACCEPTED',
      'PREPARING',
      'READY_FOR_PICKUP',
      'ACCEPTED_BY_RIDER',
      'AT_RESTAURANT',
      'HANDED_OVER',
      'ON_THE_WAY',
      'OUT_FOR_DELIVERY',
      'DELIVERED'
    ];

    if (POST_PLACED_STATUSES.includes(order.orderStatus)) {
      order.paymentStatus = 'PAID';
      if (!order.razorpayPaymentId) {
        order.razorpayPaymentId = razorpay_payment_id;
      }
      writeDb(db);

      return res.json({
        success: true,
        message: `Payment confirmed. Active order status '${order.orderStatus}' strictly preserved.`,
        paymentId: razorpay_payment_id,
        order
      });
    }

    // 5. Initial Transition for Unpaid Order (PENDING_PAYMENT / PAYMENT_PENDING -> PLACED)
    order.paymentStatus = 'PAID';
    order.orderStatus = 'PLACED';
    order.razorpayPaymentId = razorpay_payment_id;
    order.paidAt = new Date().toISOString();
    writeDb(db);

    if (req.io) {
      const publicOrder = sanitizeOrder(order);
      req.io.emit('new_order_restaurant', publicOrder);
      req.io.emit('global_order_update', publicOrder);
    }

    return res.json({
      success: true,
      message: 'Payment verified successfully! Money secured in Owner Razorpay account.',
      paymentId: razorpay_payment_id,
      order
    });
  } catch (error) {
    console.error('Payment verify error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Razorpay Webhook Handler with Cryptographic Signature Verification
 * Safely processes delayed / async Razorpay webhooks (payment.captured, order.paid)
 */
function handleRazorpayWebhook(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || '';
    if (!webhookSecret) {
      return res.status(500).json({ success: false, message: 'Webhook secret is not configured' });
    }

    if (!signature) {
      return res.status(400).json({ success: false, message: 'Missing X-Razorpay-Signature header' });
    }

    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const event = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const eventType = event.event;

    if (eventType === 'payment.captured' || eventType === 'order.paid') {
      const paymentEntity = event.payload && event.payload.payment && event.payload.payment.entity;
      const paymentId = paymentEntity ? paymentEntity.id : null;
      const rzpOrderId = paymentEntity ? paymentEntity.order_id : null;
      const orderId = paymentEntity && paymentEntity.notes ? paymentEntity.notes.orderId : null;

      if (paymentId) {
        const db = readDb();
        const order = (db.orders || []).find(o => (orderId && o.orderId === orderId) || (rzpOrderId && o.razorpayOrderId === rzpOrderId));
        if (order) {
          // Exact duplicate check
          if (order.paymentStatus === 'PAID' && order.razorpayPaymentId === paymentId) {
            return res.json({ success: true, message: 'Webhook already processed for this payment' });
          }

          // Status protection
          const POST_PLACED_STATUSES = [
            'PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
            'ACCEPTED_BY_RIDER', 'AT_RESTAURANT', 'HANDED_OVER',
            'ON_THE_WAY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'
          ];

          if (POST_PLACED_STATUSES.includes(order.orderStatus)) {
            // Keep status intact, only ensure payment status is recorded
            order.paymentStatus = 'PAID';
            if (!order.razorpayPaymentId) order.razorpayPaymentId = paymentId;
            writeDb(db);
            return res.json({ success: true, message: `Status preserved as ${order.orderStatus}; payment recorded.` });
          }

          // Initial transition
          order.paymentStatus = 'PAID';
          order.orderStatus = 'PLACED';
          order.razorpayPaymentId = paymentId;
          order.paidAt = new Date().toISOString();
          writeDb(db);

          if (req.io) {
            const publicOrder = sanitizeOrder(order);
            req.io.emit('new_order_restaurant', publicOrder);
            req.io.emit('global_order_update', publicOrder);
          }
        }
      }
    }

    return res.json({ success: true, message: 'Webhook processed' });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  getRazorpayKey,
  verifyPayment,
  handleRazorpayWebhook
};
