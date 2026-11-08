const crypto = require('crypto');
const razorpay = require('../config/razorpay');
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
 * Verifies Razorpay payment with strict cryptographic verification,
 * direct Razorpay server-side payment entity fetch, amount/orderId matching,
 * and Idempotency & Lifecycle Status Protection.
 */
async function verifyPayment(req, res) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Incomplete payment credentials' });
    }

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required for verification' });
    }

    // 1. Strict HMAC-SHA256 signature verification (B.1)
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({ success: false, message: 'Server configuration error: Razorpay secret not configured' });
    }
    const body = razorpay_order_id + '|' + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature! Fraud warning.' });
    }

    // Lookup local order in DB
    const db = readDb();
    const order = (db.orders || []).find(o => o.orderId === orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // 2. Enforce strict matching between local order's razorpayOrderId and verification order ID (B.2)
    if (!order.razorpayOrderId) {
      return res.status(400).json({
        success: false,
        message: 'Local order has no Razorpay order registered.'
      });
    }
    if (order.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        message: `Razorpay Order ID mismatch: Submitted '${razorpay_order_id}' does not match registered order '${order.razorpayOrderId}'`
      });
    }

    // --- IDEMPOTENCY & STATUS INTEGRITY GUARDS (B.6) ---

    // A. Exact Duplicate Payment ID on already-paid order (Idempotent 200 OK)
    if (order.paymentStatus === 'PAID' && order.razorpayPaymentId === razorpay_payment_id) {
      return res.json({
        success: true,
        isDuplicate: true,
        message: 'Payment already verified and recorded for this order.',
        paymentId: razorpay_payment_id,
        order: sanitizeOrder(order)
      });
    }

    // B. Conflicting Payment ID on already-paid order (Reject Replay Attack)
    if (order.paymentStatus === 'PAID' && order.razorpayPaymentId && order.razorpayPaymentId !== razorpay_payment_id) {
      return res.status(409).json({
        success: false,
        message: 'Order is already paid under a different transaction ID. Duplicate payment rejected.',
        order: sanitizeOrder(order)
      });
    }

    // C. Status Guard: Order was already CANCELLED
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

    // 3. Fetch actual payment details from Razorpay using server-side API (B.3)
    let paymentRecord = null;
    try {
      paymentRecord = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (fetchErr) {
      const errMsg = fetchErr.error ? fetchErr.error.description : fetchErr.message;
      return res.status(400).json({
        success: false,
        message: `Failed to fetch payment details from Razorpay: ${errMsg}`
      });
    }

    if (!paymentRecord) {
      return res.status(400).json({ success: false, message: 'Unable to retrieve payment record from Razorpay.' });
    }

    // 4. Verify all critical attributes (B.4 & B.5)

    // a. Payment ID matches submitted payment ID
    if (paymentRecord.id !== razorpay_payment_id) {
      return res.status(400).json({
        success: false,
        message: `Payment ID mismatch: Razorpay payment id '${paymentRecord.id}' does not match '${razorpay_payment_id}'`
      });
    }

    // b. Razorpay Order ID matches local order
    if (paymentRecord.order_id !== order.razorpayOrderId) {
      return res.status(400).json({
        success: false,
        message: `Razorpay Order ID mismatch: Razorpay payment is linked to '${paymentRecord.order_id}', but expected '${order.razorpayOrderId}'`
      });
    }

    // c. Actual payment amount matches expected order amount in paise
    const expectedAmountPaise = Math.round(order.financials.customerTotalPaid * 100);
    if (parseInt(paymentRecord.amount, 10) !== expectedAmountPaise) {
      return res.status(400).json({
        success: false,
        message: `Payment amount mismatch: Expected ₹${(expectedAmountPaise / 100).toFixed(2)} (${expectedAmountPaise} paise), but Razorpay captured ₹${(paymentRecord.amount / 100).toFixed(2)} (${paymentRecord.amount} paise)`
      });
    }

    // d. Currency matches INR
    if (paymentRecord.currency !== 'INR') {
      return res.status(400).json({
        success: false,
        message: `Payment currency mismatch: Expected INR, got '${paymentRecord.currency}'`
      });
    }

    // e. Payment status is captured before marking order PAID
    if (paymentRecord.status !== 'captured') {
      return res.status(400).json({
        success: false,
        message: `Payment is not in captured status. Current Razorpay status: '${paymentRecord.status}'`
      });
    }

    // 5. Status Guards for Active Stages: Never revert active stages back to PLACED
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
        order: sanitizeOrder(order)
      });
    }

    // Initial Transition for Unpaid Order (PENDING_PAYMENT / PAYMENT_PENDING -> PLACED)
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
      order: sanitizeOrder(order)
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
