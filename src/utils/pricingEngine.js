/**
 * INDFood Dynamic Pricing & Commission Engine
 */

require('dotenv').config();

const BASE_RIDER_PAY = parseFloat(process.env.BASE_RIDER_PAY || '20.00');
const BASE_RIDER_KM = parseFloat(process.env.BASE_RIDER_KM || '2.0');
const PER_KM_RIDER_RATE = parseFloat(process.env.PER_KM_RIDER_RATE || '10.15');

const BASE_CUSTOMER_DELIVERY_FEE = parseFloat(process.env.BASE_CUSTOMER_DELIVERY_FEE || '30.00');
const PER_KM_CUSTOMER_DELIVERY_FEE = parseFloat(process.env.PER_KM_CUSTOMER_DELIVERY_FEE || '12.50');

const DEFAULT_PLATFORM_FEE = parseFloat(process.env.DEFAULT_PLATFORM_FEE || '8.00');
const DEFAULT_COMMISSION_PERCENT = parseFloat(process.env.DEFAULT_RESTAURANT_COMMISSION_PERCENT || '15');

/**
 * Calculates Rider Payout based on real GPS distance & traffic delay
 * Guaranteed minimum: ₹20.00 for up to 2 km
 * Realistic decimal outputs: e.g., 4.9 km -> ₹49.69, 6.0 km -> ₹60.98
 */
function calculateRiderPayout(distanceKm, trafficMinutes = 0, isRainSurge = false) {
  let payout = 0;
  const dist = Math.max(0.1, parseFloat(distanceKm));

  if (dist <= BASE_RIDER_KM) {
    // Up to 2.0 KM: ₹20.00 base + subtle meter variance
    const microVar = ((dist * 100) % 9) * 0.15;
    payout = BASE_RIDER_PAY + microVar;
  } else {
    // Beyond 2.0 KM: Base ₹20 + ₹10.15/km
    const extraKm = dist - BASE_RIDER_KM;
    payout = BASE_RIDER_PAY + (extraKm * PER_KM_RIDER_RATE);
  }

  // Add traffic delay micro-bonus (₹0.50/min if more than 5 min)
  if (trafficMinutes > 5) {
    payout += (trafficMinutes - 5) * 0.50;
  }

  // Rain or bad weather surge
  if (isRainSurge) {
    payout += 18.00;
  }

  // Return formatted to two decimal points
  return Math.round(payout * 100) / 100;
}

/**
 * Calculates Customer Delivery Fee
 * Generates an owner delivery margin while remaining competitive
 */
function calculateCustomerDeliveryFee(distanceKm, isRainSurge = false) {
  const dist = Math.max(0.1, parseFloat(distanceKm));
  let fee = 0;

  if (dist <= BASE_RIDER_KM) {
    fee = BASE_CUSTOMER_DELIVERY_FEE;
  } else {
    const extraKm = dist - BASE_RIDER_KM;
    fee = BASE_CUSTOMER_DELIVERY_FEE + (extraKm * PER_KM_CUSTOMER_DELIVERY_FEE);
  }

  if (isRainSurge) {
    fee += 20.00;
  }

  return Math.round(fee * 100) / 100;
}

/**
 * Calculates the full order financial split
 */
function calculateOrderFinancials({
  foodTotal,
  distanceKm,
  trafficMinutes = 0,
  commissionPercent = DEFAULT_COMMISSION_PERCENT,
  platformFee = DEFAULT_PLATFORM_FEE,
  isRainSurge = false
}) {
  const foodAmt = parseFloat(foodTotal);
  const riderPayout = calculateRiderPayout(distanceKm, trafficMinutes, isRainSurge);
  const deliveryFee = calculateCustomerDeliveryFee(distanceKm, isRainSurge);
  
  // Commission from restaurant on food total
  const ownerCommission = Math.round((foodAmt * (commissionPercent / 100)) * 100) / 100;
  const restaurantEarning = Math.round((foodAmt - ownerCommission) * 100) / 100;

  // Delivery Margin (Customer Delivery Fee - Rider Payout)
  const deliveryMargin = Math.round((deliveryFee - riderPayout) * 100) / 100;

  // Total amount customer pays
  const customerTotalPaid = Math.round((foodAmt + deliveryFee + platformFee) * 100) / 100;

  // Total Owner Net Profit on this order
  const ownerNetProfit = Math.round((ownerCommission + platformFee + deliveryMargin) * 100) / 100;

  return {
    foodTotal: foodAmt,
    distanceKm,
    deliveryFee,
    platformFee,
    customerTotalPaid,
    riderPayout,
    restaurantEarning,
    ownerCommission,
    deliveryMargin,
    ownerNetProfit
  };
}

module.exports = {
  calculateRiderPayout,
  calculateCustomerDeliveryFee,
  calculateOrderFinancials
};
