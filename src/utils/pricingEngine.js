/**
 * INDFood Dynamic Pricing & Commission Engine
 */

require('dotenv').config();
const { readDb } = require('../models/db');

function getSettings() {
  try {
    const db = readDb();
    if (db && db.settings) {
      return db.settings;
    }
  } catch (e) {}

  return {
    businessName: process.env.BUSINESS_NAME || 'INDFood',
    businessUpiId: process.env.BUSINESS_UPI_ID || '9174782706@ybl',
    riderPerKmRate: parseFloat(process.env.PER_KM_RIDER_RATE || '12.00'),
    riderIncentiveBonus: 15.00,
    riderIncentiveActive: true,
    riderMinBasePay: 0.00,
    defaultRestaurantCommission: parseFloat(process.env.DEFAULT_RESTAURANT_COMMISSION_PERCENT || '15'),
    defaultPlatformFee: parseFloat(process.env.DEFAULT_PLATFORM_FEE || '8.00'),
    customerBaseDeliveryFee: parseFloat(process.env.BASE_CUSTOMER_DELIVERY_FEE || '30.00'),
    customerPerKmDeliveryFee: parseFloat(process.env.PER_KM_CUSTOMER_DELIVERY_FEE || '12.50')
  };
}

/**
 * Calculates Rider Payout based on real GPS distance & traffic delay
 * User Requirement:
 * - Admin sets per-kilometer rate (e.g. ₹12/km).
 * - Multiplies with distance: e.g. 2 km = ₹24, 5 km = ₹60 dynamically.
 * - Admin sets incentive bonus (e.g. ₹15).
 * - Total Rider Payout = (Distance * PerKmRate) + (Incentive Bonus if active).
 */
function calculateRiderPayout(
  distanceKm,
  trafficMinutes = 0,
  isRainSurge = false,
  customPerKm = null,
  customIncentive = null,
  customIncentiveActive = null
) {
  const settings = getSettings();
  const dist = Math.max(0.1, parseFloat(distanceKm || 1.0));

  const perKmRate = (customPerKm !== null && !isNaN(parseFloat(customPerKm)))
    ? parseFloat(customPerKm)
    : parseFloat(settings.riderPerKmRate !== undefined ? settings.riderPerKmRate : 12.00);

  const incentiveActive = (customIncentiveActive !== null && customIncentiveActive !== undefined)
    ? !!customIncentiveActive
    : (settings.riderIncentiveActive !== undefined ? !!settings.riderIncentiveActive : true);

  const incentiveBonus = incentiveActive
    ? ((customIncentive !== null && !isNaN(parseFloat(customIncentive)))
        ? parseFloat(customIncentive)
        : parseFloat(settings.riderIncentiveBonus !== undefined ? settings.riderIncentiveBonus : 15.00))
    : 0;

  // Exact multiplication of km with per-km rate (e.g. 2 km * 12 = 24)
  const distancePay = Math.round(dist * perKmRate * 100) / 100;
  
  // Total Rider Payout: Distance Pay + Incentive Bonus (if active)
  const finalPayout = Math.round((distancePay + incentiveBonus) * 100) / 100;

  return {
    distanceKm: dist,
    perKmRate,
    distancePay,
    incentiveBonus,
    incentiveActive,
    riderPayout: finalPayout,
    valueOf() { return finalPayout; },
    toString() { return finalPayout.toString(); }
  };
}

/**
 * Calculates Customer Delivery Fee
 * Generates an owner delivery margin while remaining competitive
 */
function calculateCustomerDeliveryFee(distanceKm) {
  const settings = getSettings();
  const dist = Math.max(0.1, parseFloat(distanceKm || 1.0));
  const baseFee = parseFloat(settings.customerBaseDeliveryFee !== undefined ? settings.customerBaseDeliveryFee : 30.00);
  const perKmFee = parseFloat(settings.customerPerKmDeliveryFee !== undefined ? settings.customerPerKmDeliveryFee : 12.50);

  let fee = baseFee;
  if (dist > 2.0) {
    fee += (dist - 2.0) * perKmFee;
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
  commissionPercent = null,
  platformFee = null,
  isRainSurge = false,
  riderPerKmRate = null,
  riderIncentiveBonus = null,
  riderIncentiveActive = null
}) {
  const settings = getSettings();
  const foodAmt = Math.max(0, parseFloat(foodTotal || 0));

  const riderSplit = calculateRiderPayout(
    distanceKm,
    trafficMinutes,
    isRainSurge,
    riderPerKmRate,
    riderIncentiveBonus,
    riderIncentiveActive
  );

  const deliveryFee = calculateCustomerDeliveryFee(distanceKm, isRainSurge);
  
  const effectivePlatformFee = (platformFee !== null && !isNaN(parseFloat(platformFee)))
    ? parseFloat(platformFee)
    : parseFloat(settings.defaultPlatformFee !== undefined ? settings.defaultPlatformFee : 8.00);

  const effectiveCommPercent = (commissionPercent !== null && !isNaN(parseFloat(commissionPercent)))
    ? parseFloat(commissionPercent)
    : parseFloat(settings.defaultRestaurantCommission !== undefined ? settings.defaultRestaurantCommission : 15.00);

  // Commission from restaurant on food total
  const ownerCommission = Math.round((foodAmt * (effectiveCommPercent / 100)) * 100) / 100;
  const restaurantEarning = Math.round((foodAmt - ownerCommission) * 100) / 100;

  // Delivery Margin (Customer Delivery Fee - Rider Payout)
  const deliveryMargin = Math.round((deliveryFee - riderSplit.riderPayout) * 100) / 100;

  // Total amount customer pays
  const customerTotalPaid = Math.round((foodAmt + deliveryFee + effectivePlatformFee) * 100) / 100;

  // Total Owner Net Profit on this order
  const ownerNetProfit = Math.round((ownerCommission + effectivePlatformFee + deliveryMargin) * 100) / 100;

  return {
    foodTotal: foodAmt,
    distanceKm: riderSplit.distanceKm,
    deliveryFee,
    platformFee: effectivePlatformFee,
    customerTotalPaid,
    riderPerKmRate: riderSplit.perKmRate,
    riderDistancePay: riderSplit.distancePay,
    riderIncentive: riderSplit.incentiveBonus,
    riderIncentiveActive: riderSplit.incentiveActive,
    riderPayout: riderSplit.riderPayout,
    restaurantCommissionPercent: effectiveCommPercent,
    restaurantEarning,
    ownerCommission,
    deliveryMargin,
    ownerNetProfit
  };
}

module.exports = {
  calculateRiderPayout,
  calculateCustomerDeliveryFee,
  calculateOrderFinancials,
  getSettings
};
