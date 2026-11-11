const crypto = require('crypto');

/**
 * Delivery Partner Permanent ID Generator
 * Generates an official, permanent, random ID tied to rider's name + random numbers (total 10-12 chars)
 * Example: devraj683992
 */
function generatePermanentRiderId(riderName) {
  const cleanName = (riderName || 'rider')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase()
    .slice(0, 6) || 'rider';
  const digitsNeeded = Math.max(4, 12 - cleanName.length);
  const min = Math.pow(10, digitsNeeded - 1);
  const max = Math.pow(10, digitsNeeded) - 1;
  const randomNum = Math.floor(min + Math.random() * (max - min + 1));
  return `${cleanName}${randomNum}`;
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
 * 12-digit numeric Unique INDFood Order ID
 * Format: 12 numeric digits (e.g., 172611451234)
 * Prefixed with 'IND' for display: IND172611451234
 */
function generateInd12DigitId() {
  const tsPart = Date.now().toString().slice(-8);
  const rndPart = crypto.randomInt(1000, 10000).toString();
  return `${tsPart}${rndPart}`;
}

/**
 * 4-digit Cryptographically Secure Delivery OTP generator (1000-9999)
 */
function generateDeliveryOtp() {
  return crypto.randomInt(1000, 10000).toString();
}

module.exports = {
  generatePermanentRiderId,
  generateOrderId,
  generateInd12DigitId,
  generateDeliveryOtp
};
