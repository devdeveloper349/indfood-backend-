const Razorpay = require('razorpay');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const key_id = process.env.RAZORPAY_KEY_ID || 'rzp_live_TqxS4IwcLyKe3t';
const key_secret = process.env.RAZORPAY_KEY_SECRET || '42zBkhYMQAsU6aRgsQMM1d45';

const razorpayInstance = new Razorpay({
  key_id,
  key_secret,
});

module.exports = razorpayInstance;
