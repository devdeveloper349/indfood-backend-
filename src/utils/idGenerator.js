const crypto = require('crypto');

/**
 * Delivery Partner Permanent ID Generator
 * Generates an official, permanent, random alphanumeric ID
 * once KYC verification is officially approved by Admin.
 * Format: INDF-RD-XXXXX (e.g., INDF-RD-74921)
 */
function generatePermanentRiderId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let randomPart = '';
  const randomBytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) {
    randomPart += chars[randomBytes[i] % chars.length];
  }
  return `INDF-RD-${randomPart}`;
}

/**
 * Unique Order Reference Generator
 * Format: ORD-XXDDDD (e.g., ORD-734821)
 * The last 4 digits are always numeric so they double as a clean Zomato-style pickup token!
 */
function generateOrderId() {
  const prefix = Math.floor(10 + Math.random() * 90);
  const code = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${prefix}${code}`;
}

/**
 * 4-digit Pickup & Delivery Token generator
 */
function generateDeliveryOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

module.exports = {
  generatePermanentRiderId,
  generateOrderId,
  generateDeliveryOtp
};
