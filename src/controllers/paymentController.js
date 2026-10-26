const crypto = require('crypto');
const { readDb, writeDb } = require('../models/db');
require('dotenv').config();

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
 * Verifies Razorpay payment signature
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
    const order = db.orders.find(o => o.orderId === orderId || o.razorpayOrderId === razorpay_order_id);
    if (order) {
      order.paymentStatus = 'PAID';
      order.razorpayPaymentId = razorpay_payment_id;
      writeDb(db);
    }

    return res.json({
      success: true,
      message: 'Payment verified successfully! Money secured in Owner Razorpay account.',
      paymentId: razorpay_payment_id
    });
  } catch (error) {
    console.error('Payment verify error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  getRazorpayKey,
  verifyPayment
};
