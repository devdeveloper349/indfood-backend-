const { readDb, writeDb } = require('../models/db');
const { generateOrderId, generateDeliveryOtp } = require('../utils/idGenerator');
const { calculateOrderFinancials } = require('../utils/pricingEngine');
const razorpay = require('../config/razorpay');

function calculateHaversineDistanceKm(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lat1 === null || lon1 === undefined || lon1 === null ||
      lat2 === undefined || lat2 === null || lon2 === undefined || lon2 === null) {
    return 2.5;
  }
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const dist = R * c;
  return Math.max(0.5, Math.round(dist * 10) / 10);
}

/**
 * Customer creates an order
 */
async function createOrder(req, res) {
  try {
    const {
      customerId,
      customerName = 'Customer',
      customerPhone,
      restaurantId,
      items, // array of { id, name, price, quantity }
      deliveryAddress,
      customerLat,
      customerLng,
      distanceKm,
      paymentMethod = 'ONLINE', // 'ONLINE' or 'COD'
      isRainSurge = false,
      promoCode,
      cookingInstructions,
      deliveryInstructions
    } = req.body;

    if (!restaurantId || !items || !items.length) {
      return res.status(400).json({ success: false, message: 'Invalid order parameters: restaurant and items required' });
    }

    if (!customerPhone || customerPhone.toString().trim().length < 10) {
      return res.status(400).json({ success: false, message: 'Customer ka 10-digit mobile number bharna anivarya hai' });
    }

    const db = readDb();
    const restaurant = db.restaurants.find(r => r.id === restaurantId);
    if (!restaurant) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    // Dynamic distance calculation based on REAL GPS
    let actualDistanceKm = 2.5;
    if (customerLat !== undefined && customerLng !== undefined && restaurant.latitude && restaurant.longitude) {
      const calcDist = calculateHaversineDistanceKm(
        parseFloat(restaurant.latitude),
        parseFloat(restaurant.longitude),
        parseFloat(customerLat),
        parseFloat(customerLng)
      );
      actualDistanceKm = Math.max(0.1, calcDist);
    } else if (distanceKm && !isNaN(parseFloat(distanceKm)) && parseFloat(distanceKm) > 0) {
      actualDistanceKm = Math.max(0.1, Math.round(parseFloat(distanceKm) * 10) / 10);
    }

    // Calculate food subtotal
    const foodTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Calculate exact financial split (Commission, Delivery Fee, Rider Payout, Owner Profit) based on actual KM
    const commissionPercent = (restaurant && typeof restaurant.commissionPercent === 'number')
      ? restaurant.commissionPercent
      : ((db.settings && db.settings.defaultRestaurantCommission) !== undefined ? db.settings.defaultRestaurantCommission : 15);

    const financials = calculateOrderFinancials({
      foodTotal,
      distanceKm: actualDistanceKm,
      commissionPercent,
      isRainSurge
    });

    // Check & apply single-use Promo Code if supplied
    let promoDiscount = 0;
    let appliedPromoCode = null;
    if (promoCode) {
      const cleanCode = promoCode.toString().trim().toUpperCase();
      const promo = (db.promocodes || []).find(p => p.code === cleanCode && p.active !== false);
      if (promo) {
        promo.usedBy = promo.usedBy || [];
        const phoneClean = customerPhone ? customerPhone.toString().trim() : '';
        if (!promo.usedBy.includes(phoneClean) && (!promo.minOrder || foodTotal >= promo.minOrder)) {
          promoDiscount = Math.min(promo.discount, financials.customerTotalPaid);
          financials.customerTotalPaid = Math.max(0, financials.customerTotalPaid - promoDiscount);
          financials.promoDiscount = promoDiscount;
          financials.promoCode = cleanCode;
          appliedPromoCode = cleanCode;
          promo.usedBy.push(phoneClean);
        }
      }
    }

    const orderId = generateOrderId();
    const deliveryOtp = generateDeliveryOtp();
    const pickupCode = orderId.replace(/\D/g, '').slice(-4) || deliveryOtp;

    let razorpayOrder = null;

    // If online, initialize Razorpay Order
    if (paymentMethod === 'ONLINE') {
      try {
        const amountInPaise = Math.round(financials.customerTotalPaid * 100);
        razorpayOrder = await razorpay.orders.create({
          amount: amountInPaise,
          currency: 'INR',
          receipt: orderId,
          notes: {
            orderId,
            customerId: customerId || 'guest',
            restaurantName: restaurant.name
          }
        });
      } catch (err) {
        console.error('Razorpay order creation fallback (offline mode):', err.message);
        // Fallback simulated razorpay order if offline/rate-limited
        razorpayOrder = {
          id: `order_${orderId}_live`,
          amount: Math.round(financials.customerTotalPaid * 100),
          currency: 'INR',
          receipt: orderId
        };
      }
    }

    const newOrder = {
      orderId,
      customerId: customerId || 'cust_demo',
      customerName,
      customerPhone,
      restaurantId,
      restaurantName: restaurant.name,
      restaurantAddress: restaurant.address || 'Restaurant Location',
      restaurantPhone: restaurant.phone || '',
      restaurantLat: restaurant.latitude ? parseFloat(restaurant.latitude) : (customerLat ? parseFloat(customerLat) : null),
      restaurantLng: restaurant.longitude ? parseFloat(restaurant.longitude) : (customerLng ? parseFloat(customerLng) : null),
      items,
      deliveryAddress: deliveryAddress || 'Customer Location',
      customerLat: customerLat ? parseFloat(customerLat) : null,
      customerLng: customerLng ? parseFloat(customerLng) : null,
      distanceKm: actualDistanceKm,
      paymentMethod,
      paymentStatus: paymentMethod === 'ONLINE' ? 'PAYMENT_PENDING' : 'COD_PENDING',
      razorpayOrderId: razorpayOrder ? razorpayOrder.id : null,
      financials,
      orderStatus: paymentMethod === 'ONLINE' ? 'PENDING_PAYMENT' : 'PLACED',
      assignedRider: null,
      riderLat: null,
      riderLng: null,
      cookingInstructions: cookingInstructions || '',
      deliveryInstructions: deliveryInstructions || '',
      promoCode: appliedPromoCode || null,
      promoDiscount: promoDiscount || 0,
      pickupCode,
      deliveryOtp,
      createdAt: new Date().toISOString()
    };

    db.orders.push(newOrder);
    writeDb(db);

    // If online, do NOT broadcast to restaurant or riders until payment is verified!
    if (paymentMethod !== 'ONLINE' && req.io) {
      req.io.emit('new_order_restaurant', newOrder);
      req.io.emit('global_order_update', newOrder);
    }

    return res.json({
      success: true,
      message: 'Order created successfully!',
      order: newOrder,
      razorpayOrder: razorpayOrder ? {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        key: process.env.RAZORPAY_KEY_ID || 'rzp_live_TqxS4IwcLyKe3t'
      } : null
    });
  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Get order status & tracking details
 */
function getOrderDetails(req, res) {
  const { orderId } = req.params;
  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  const rest = (db.restaurants || []).find(r => r.id === order.restaurantId);
  if (rest) {
    if (!order.restaurantAddress) order.restaurantAddress = rest.address || '';
    if (!order.restaurantPhone) order.restaurantPhone = rest.phone || '';
    if (!order.restaurantLat && rest.latitude) order.restaurantLat = parseFloat(rest.latitude);
    if (!order.restaurantLng && rest.longitude) order.restaurantLng = parseFloat(rest.longitude);
  }
  return res.json({ success: true, order });
}

/**
 * Radar dispatch engine: Selects 1 available on-duty approved rider within area
 * Gives 45-second acceptance window exclusively to that rider before passing to next
 */
function dispatchRadarRider(order, db) {
  if (order.assignedRider) return;

  const now = Date.now();
  if (order.targetedRiderId && order.targetedRiderExpiresAt && order.targetedRiderExpiresAt > now) {
    return; // Current targeted rider still in active 45s countdown
  }

  // Active riders with current uncompleted trips
  const busyRiderIds = new Set();
  db.orders.forEach(o => {
    if (['ON_THE_WAY', 'ACCEPTED_BY_RIDER', 'AT_RESTAURANT', 'HANDED_OVER'].includes(o.orderStatus) && o.assignedRider) {
      busyRiderIds.add(o.assignedRider.userId);
      busyRiderIds.add(o.assignedRider.permanentRiderId);
    }
  });

  const rejectedRiders = order.rejectedRiderIds || [];
  const eligibleRiders = db.riders.filter(r =>
    r.kycStatus === 'APPROVED' &&
    r.isOnline !== false &&
    !busyRiderIds.has(r.userId) &&
    !busyRiderIds.has(r.permanentRiderId) &&
    !rejectedRiders.includes(r.userId) &&
    !rejectedRiders.includes(r.permanentRiderId)
  );

  if (eligibleRiders.length > 0) {
    const selected = eligibleRiders[Math.floor(Math.random() * eligibleRiders.length)];
    order.targetedRiderId = selected.userId;
    order.targetedRiderName = selected.name;
    order.targetedRiderPermanentId = selected.permanentRiderId;
    order.targetedRiderExpiresAt = now + 45000; // 45 seconds
  } else {
    // If all available rejected or only 1 rider in network, cycle back
    if (rejectedRiders.length > 0) {
      order.rejectedRiderIds = [];
      const anyEligible = db.riders.filter(r => r.kycStatus === 'APPROVED' && r.isOnline !== false);
      if (anyEligible.length > 0) {
        const selected = anyEligible[0];
        order.targetedRiderId = selected.userId;
        order.targetedRiderName = selected.name;
        order.targetedRiderPermanentId = selected.permanentRiderId;
        order.targetedRiderExpiresAt = now + 45000;
      }
    } else {
      order.targetedRiderId = null;
      order.targetedRiderExpiresAt = null;
    }
  }
}

/**
 * List orders for customer or restaurant or rider or admin
 */
function listOrders(req, res) {
  const { customerId, restaurantId, riderId, status } = req.query;
  const db = readDb();
  let filtered = [...db.orders];

  if (customerId) filtered = filtered.filter(o => o.customerId === customerId);
  if (restaurantId) filtered = filtered.filter(o => o.restaurantId === restaurantId);
  if (riderId && req.query.availableForRider !== 'true') filtered = filtered.filter(o => o.assignedRider && (o.assignedRider.permanentRiderId === riderId || o.assignedRider.userId === riderId));
  if (status) filtered = filtered.filter(o => o.orderStatus === status);

  if (req.query.availableForRider === 'true') {
    const currentRiderId = req.query.riderUserId || req.query.riderId;
    const currentRiderPhone = req.query.riderPhone;

    filtered = filtered.filter(o => {
      // 1. Keep active trips assigned to THIS rider (so active order never disappears when navigating or backing!)
      if (o.assignedRider) {
        const matchesId = currentRiderId && (
          o.assignedRider.permanentRiderId === currentRiderId ||
          o.assignedRider.userId === currentRiderId ||
          o.assignedRider.phone === currentRiderId
        );
        const matchesPhone = currentRiderPhone && (
          o.assignedRider.phone === currentRiderPhone
        );
        if (matchesId || matchesPhone) {
          return ['ACCEPTED_BY_RIDER', 'AT_RESTAURANT', 'HANDED_OVER', 'ON_THE_WAY', 'RIDER_ASSIGNED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP'].includes(o.orderStatus);
        }
        return false;
      }

      // 2. Otherwise keep available unassigned orders accepted by restaurant (or ready for pickup)
      if (!['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(o.orderStatus)) return false;
      
      // If rejected by this rider, don't show
      const rejected = o.rejectedRiderIds || [];
      if (currentRiderId && (rejected.includes(currentRiderId) || (currentRiderPhone && rejected.includes(currentRiderPhone)))) {
        return false;
      }
      return true;
    });

    // Enrich orders with restaurant details if missing
    const restaurantsMap = {};
    (db.restaurants || []).forEach(r => { restaurantsMap[r.id] = r; });
    filtered.forEach(o => {
      const rest = restaurantsMap[o.restaurantId];
      if (rest) {
        if (!o.restaurantAddress) o.restaurantAddress = rest.address || '';
        if (!o.restaurantPhone) o.restaurantPhone = rest.phone || '';
        if (!o.restaurantLat && rest.latitude) o.restaurantLat = parseFloat(rest.latitude);
        if (!o.restaurantLng && rest.longitude) o.restaurantLng = parseFloat(rest.longitude);
      }
    });

    const activeOrderForRider = filtered.find(o => o.assignedRider);
    const availableOrders = filtered.filter(o => !o.assignedRider && ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(o.orderStatus));

    return res.json({
      success: true,
      orders: [...filtered].reverse(),
      availableOrders: [...availableOrders].reverse(),
      activeOrderForRider: activeOrderForRider || null
    });
  }

  // Enrich orders with restaurant details if missing
  const restaurantsMap = {};
  (db.restaurants || []).forEach(r => { restaurantsMap[r.id] = r; });
  filtered.forEach(o => {
    const rest = restaurantsMap[o.restaurantId];
    if (rest) {
      if (!o.restaurantAddress) o.restaurantAddress = rest.address || '';
      if (!o.restaurantPhone) o.restaurantPhone = rest.phone || '';
      if (!o.restaurantLat && rest.latitude) o.restaurantLat = parseFloat(rest.latitude);
      if (!o.restaurantLng && rest.longitude) o.restaurantLng = parseFloat(rest.longitude);
    }
  });

  return res.json({ success: true, orders: filtered.reverse() });
}

/**
 * Restaurant updates order status (ACCEPTED, PREPARING, READY_FOR_PICKUP)
 */
function updateOrderStatus(req, res) {
  const { orderId, status, prepTime } = req.body;
  const validStatuses = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'CANCELLED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status update' });
  }

  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  order.orderStatus = status;
  order[`${status.toLowerCase()}At`] = new Date().toISOString();

  if (prepTime) {
    order.prepTimeMinutes = parseInt(prepTime);
    order.estimatedReadyAt = new Date(Date.now() + parseInt(prepTime) * 60000).toISOString();
  }

  if (['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(status)) {
    dispatchRadarRider(order, db);
  }

  writeDb(db);

  if (req.io) {
    req.io.emit('order_status_update', order);
    req.io.emit('new_order_available_rider', order);
    req.io.emit('global_order_update', order);
  }

  return res.json({
    success: true,
    message: `Order status updated to ${status}`,
    order
  });
}

/**
 * Rider rejects trip: Pass to next available rider in radar radius
 */
function riderRejectOrder(req, res) {
  const { orderId, riderUserId } = req.body;
  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  order.rejectedRiderIds = order.rejectedRiderIds || [];
  if (riderUserId && !order.rejectedRiderIds.includes(riderUserId)) {
    order.rejectedRiderIds.push(riderUserId);
  }
  order.targetedRiderId = null;
  order.targetedRiderExpiresAt = null;

  dispatchRadarRider(order, db);
  writeDb(db);

  if (req.io) {
    req.io.emit('order_status_update', order);
    req.io.emit('order_status_updated', order);
    req.io.emit('global_order_update', order);
  }

  return res.json({
    success: true,
    message: 'Trip passed to next available rider in radar network',
    order
  });
}

/**
 * Rider accepts and picks up order
 */
function riderAcceptOrder(req, res) {
  const { orderId } = req.body;
  const riderUserId = req.body.riderUserId || req.body.riderId || req.body.permanentRiderId;
  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const rider = db.riders.find(r => r.userId === riderUserId || r.permanentRiderId === riderUserId || (r.phone && r.phone === riderUserId));
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }

  // Delivery partner must have KYC APPROVED and permanent ID
  if (rider.kycStatus !== 'APPROVED' || !rider.permanentRiderId) {
    return res.status(403).json({
      success: false,
      message: 'KYC not verified! You must have an approved KYC and permanent ID (INDF-RD-XXXXX) before taking orders.'
    });
  }

  order.assignedRider = {
    userId: rider.userId,
    permanentRiderId: rider.permanentRiderId,
    name: rider.name,
    phone: rider.phone,
    ratings: rider.ratings || 5.0
  };
  order.orderStatus = 'ACCEPTED_BY_RIDER';
  order.acceptedByRiderAt = new Date().toISOString();
  order.riderArrivedAtRestaurant = false;
  order.foodHandedOver = false;

  // Real 2-Leg Dynamic Distance Calculation: (Rider -> Restaurant) + (Restaurant -> Customer)
  const riderLat = req.body.riderLat || req.body.latitude;
  const riderLng = req.body.riderLng || req.body.longitude;
  let pickupKm = 1.5;
  if (riderLat && riderLng && order.restaurantLat && order.restaurantLng) {
    pickupKm = calculateHaversineDistanceKm(
      parseFloat(riderLat),
      parseFloat(riderLng),
      parseFloat(order.restaurantLat),
      parseFloat(order.restaurantLng)
    );
  } else if (req.body.pickupDistanceKm && !isNaN(parseFloat(req.body.pickupDistanceKm))) {
    pickupKm = parseFloat(req.body.pickupDistanceKm);
  }

  let deliveryKm = order.distanceKm || 2.5;
  if (order.restaurantLat && order.restaurantLng && order.customerLat && order.customerLng) {
    deliveryKm = calculateHaversineDistanceKm(
      parseFloat(order.restaurantLat),
      parseFloat(order.restaurantLng),
      parseFloat(order.customerLat),
      parseFloat(order.customerLng)
    );
  } else if (req.body.deliveryDistanceKm && !isNaN(parseFloat(req.body.deliveryDistanceKm))) {
    deliveryKm = parseFloat(req.body.deliveryDistanceKm);
  }

  const totalTripKm = Math.round((pickupKm + deliveryKm) * 10) / 10;
  const settings = db.settings || {};
  const perKmRate = parseFloat(settings.riderPerKmRate !== undefined ? settings.riderPerKmRate : 12.00);
  const incentiveActive = settings.riderIncentiveActive !== false;
  const incentiveBonus = incentiveActive ? parseFloat(settings.riderIncentiveBonus !== undefined ? settings.riderIncentiveBonus : 15.00) : 0;
  const distPay = Math.round(totalTripKm * perKmRate * 100) / 100;
  const finalPayout = Math.round((distPay + incentiveBonus) * 100) / 100;

  order.financials = order.financials || {};
  order.financials.pickupDistanceKm = pickupKm;
  order.financials.deliveryDistanceKm = deliveryKm;
  order.financials.totalDistanceKm = totalTripKm;
  order.financials.distanceKm = totalTripKm;
  order.financials.riderPerKmRate = perKmRate;
  order.financials.riderDistancePay = distPay;
  order.financials.riderIncentive = incentiveBonus;
  order.financials.riderIncentiveActive = incentiveActive;
  order.financials.riderPayout = finalPayout;
  order.distanceKm = totalTripKm;

  writeDb(db);

  if (req.io) {
    req.io.emit('order_status_update', order);
    req.io.emit('order_status_updated', order);
    req.io.emit('global_order_update', order);
  }

  return res.json({
    success: true,
    message: `Order assigned to Delivery Partner ${rider.permanentRiderId}`,
    order
  });
}

/**
 * Rider arrives at restaurant (within 100 meters or verified)
 * Unlocks the secret Order ID so rider can tell the restaurant staff
 */
function riderArriveRestaurant(req, res) {
  const { orderId } = req.body;
  const riderUserId = req.body.riderUserId || req.body.riderId || req.body.permanentRiderId;
  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  order.orderStatus = 'AT_RESTAURANT';
  order.riderArrivedAtRestaurant = true;
  order.riderArrivedAt = new Date().toISOString();

  writeDb(db);

  if (req.io) {
    req.io.emit('order_status_update', order);
    req.io.emit('order_status_updated', order);
    req.io.emit('global_order_update', order);
  }

  return res.json({
    success: true,
    message: 'Rider arrived at restaurant. Order ID unlocked!',
    order
  });
}

/**
 * Restaurant confirms the Order ID and hands over food to rider
 */
function restaurantConfirmHandover(req, res) {
  const { orderId } = req.body;
  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  order.foodHandedOver = true;
  order.handedOverAt = new Date().toISOString();
  order.orderStatus = 'HANDED_OVER';

  writeDb(db);

  if (req.io) {
    req.io.emit('order_status_update', order);
    req.io.emit('order_status_updated', order);
    req.io.emit('global_order_update', order);
  }

  return res.json({
    success: true,
    message: 'Food handover confirmed to Delivery Partner!',
    order
  });
}

/**
 * Rider confirms food pickup from restaurant -> Navigation to customer begins
 */
function riderPickupOrder(req, res) {
  const { orderId } = req.body;
  const riderUserId = req.body.riderUserId || req.body.riderId || req.body.permanentRiderId;
  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  order.orderStatus = 'ON_THE_WAY';
  order.foodHandedOver = true;
  order.pickedUpAt = new Date().toISOString();

  writeDb(db);

  if (req.io) {
    req.io.emit('order_status_update', order);
    req.io.emit('order_status_updated', order);
    req.io.emit('global_order_update', order);
  }

  return res.json({
    success: true,
    message: 'Order picked up! Navigation to Customer active.',
    order
  });
}

/**
 * Generate Dynamic Razorpay QR for COD orders at delivery
 */
async function generateCodQr(req, res) {
  try {
    const { orderId } = req.body;
    const db = readDb();
    const order = db.orders.find(o => o.orderId === orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const totalPaid = (order.financials && order.financials.customerTotalPaid) || 100;
    const amountInPaise = Math.round(totalPaid * 100);

    // Reuse existing link if already generated and valid
    if (order.codPaymentLinkId && order.codPaymentLinkUrl) {
      try {
        const existingPlink = await razorpay.paymentLink.fetch(order.codPaymentLinkId);
        if (existingPlink && existingPlink.status === 'paid') {
          order.paymentStatus = 'PAID_ONLINE_COD';
          writeDb(db);
          return res.json({
            success: true,
            isPaid: true,
            orderId: order.orderId,
            amount: totalPaid,
            message: 'Payment already received!'
          });
        }
        const settings = db.settings || {};
        const businessUpiId = settings.businessUpiId || process.env.BUSINESS_UPI_ID || 'INDFood@upi';
        const businessName = settings.businessName || process.env.BUSINESS_NAME || 'INDFood';
        const upiUri = `upi://pay?pa=${businessUpiId}&pn=${encodeURIComponent(businessName)}&mc=5812&mode=02&purpose=00&orgid=159001&tr=${order.orderId}&tn=INDFood-Order-${order.orderId}&am=${totalPaid}&cu=INR`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(upiUri)}`;
        return res.json({
          success: true,
          isPaid: false,
          orderId: order.orderId,
          amount: totalPaid,
          paymentLinkId: order.codPaymentLinkId,
          paymentUrl: order.codPaymentLinkUrl,
          qrUrl,
          upiUri,
          businessName,
          businessUpiId
        });
      } catch (e) {
        // regenerate if expired or invalid
      }
    }

    let plink = null;
    let customerPhone = (order.customerPhone || '').toString().replace(/\D/g, '');
    if (customerPhone.length > 10 && customerPhone.startsWith('91')) customerPhone = customerPhone.slice(2);
    if (customerPhone.length > 10 && customerPhone.startsWith('0')) customerPhone = customerPhone.slice(1);
    if (customerPhone.length > 10) customerPhone = customerPhone.slice(-10);
    if (!customerPhone || customerPhone.length !== 10) customerPhone = '9826012345';

    try {
      plink = await razorpay.paymentLink.create({
        amount: amountInPaise,
        currency: 'INR',
        accept_partial: false,
        description: `Order #${order.orderId} Delivery Payment`,
        customer: {
          name: order.customerName || 'Customer',
          contact: customerPhone
        },
        notify: { sms: false, email: false },
        notes: {
          orderId: order.orderId,
          source: 'rider_app_cod_qr'
        }
      });
    } catch (err) {
      console.error('Razorpay Payment Link creation error:', err.message);
    }

    const payUrl = plink ? plink.short_url : `https://rzp.io/i/${order.orderId}`;
    const settings = db.settings || {};
    const businessUpiId = settings.businessUpiId || process.env.BUSINESS_UPI_ID || 'INDFood@upi';
    const businessName = settings.businessName || process.env.BUSINESS_NAME || 'INDFood';
    const upiUri = `upi://pay?pa=${businessUpiId}&pn=${encodeURIComponent(businessName)}&mc=5812&mode=02&purpose=00&orgid=159001&tr=${order.orderId}&tn=INDFood-Order-${order.orderId}&am=${totalPaid}&cu=INR`;
    const qrData = upiUri;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(qrData)}`;

    order.codPaymentLinkId = plink ? plink.id : `plink_sim_${order.orderId}`;
    order.codPaymentLinkUrl = payUrl;
    writeDb(db);

    return res.json({
      success: true,
      isPaid: order.paymentStatus === 'PAID_ONLINE_COD',
      orderId: order.orderId,
      amount: totalPaid,
      paymentLinkId: order.codPaymentLinkId,
      paymentUrl: payUrl,
      qrUrl,
      upiUri,
      businessName,
      businessUpiId
    });
  } catch (err) {
    console.error('generateCodQr error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Check if the COD dynamic Razorpay QR has been paid
 */
async function checkCodQrPayment(req, res) {
  try {
    const { orderId } = req.body;
    const db = readDb();
    const order = db.orders.find(o => o.orderId === orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.paymentStatus === 'PAID_ONLINE_COD' || order.paymentStatus === 'PAID') {
      return res.json({
        success: true,
        isPaid: true,
        amount: (order.financials && order.financials.customerTotalPaid) || 0,
        orderId: order.orderId
      });
    }

    let isPaid = false;
    if (order.codPaymentLinkId && !order.codPaymentLinkId.startsWith('plink_sim_')) {
      try {
        const plink = await razorpay.paymentLink.fetch(order.codPaymentLinkId);
        if (plink && (plink.status === 'paid' || plink.amount_paid >= plink.amount)) {
          isPaid = true;
        }
      } catch (err) {
        console.error('Error fetching razorpay payment link:', err.message);
      }
    }

    if (isPaid) {
      order.paymentStatus = 'PAID_ONLINE_COD';
      writeDb(db);

      if (req.io) {
        req.io.to(`order_${order.orderId}`).emit('cod_payment_success', {
          orderId: order.orderId,
          amount: (order.financials && order.financials.customerTotalPaid) || 0
        });
        req.io.emit('cod_payment_success', {
          orderId: order.orderId,
          amount: (order.financials && order.financials.customerTotalPaid) || 0
        });
        req.io.emit('global_order_update', order);
      }

      return res.json({
        success: true,
        isPaid: true,
        amount: (order.financials && order.financials.customerTotalPaid) || 0,
        orderId: order.orderId
      });
    }

    return res.json({
      success: true,
      isPaid: false,
      amount: (order.financials && order.financials.customerTotalPaid) || 0,
      orderId: order.orderId
    });
  } catch (err) {
    console.error('checkCodQrPayment error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Rider completes delivery directly to customer
 * Supports:
 * 1) CASH: Rider receives cash in hand -> order amount deducted from rider wallet (balance can go negative), payout added.
 * 2) ONLINE_QR: Customer paid via dynamic QR -> NO cash deduction, payout added to rider wallet.
 */
function completeDelivery(req, res) {
  const { orderId, riderUserId, paymentType = 'CASH' } = req.body;
  const db = readDb();
  const order = db.orders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  order.orderStatus = 'DELIVERED';
  order.deliveredAt = new Date().toISOString();

  const totalOrderPaid = (order.financials && order.financials.customerTotalPaid) || 0;
  const payout = (order.financials && order.financials.riderPayout) || 40;

  // Credit/Debit rider wallet
  const rider = db.riders.find(r =>
    r.userId === riderUserId ||
    r.permanentRiderId === riderUserId ||
    (r.phone && r.phone === riderUserId) ||
    (order.assignedRider && (
      r.permanentRiderId === order.assignedRider.permanentRiderId ||
      r.userId === order.assignedRider.userId ||
      r.phone === order.assignedRider.phone
    ))
  );

  const isOnlinePayment = paymentType === 'ONLINE_QR' || order.paymentStatus === 'PAID_ONLINE_COD' || order.paymentMethod === 'ONLINE';

  if (rider) {
    rider.completedTrips = (rider.completedTrips || 0) + 1;

    if (isOnlinePayment) {
      // Customer paid online / via QR -> Rider receives full delivery payout (+)
      // Zero cash deducted!
      rider.walletBalance = Math.round(((rider.walletBalance || 0) + payout) * 100) / 100;
      order.paymentStatus = 'PAID_ONLINE_QR';
    } else {
      // Customer paid Cash to Rider -> Rider collects cash in hand
      // Deduct order cash from rider wallet (wallet balance CAN go negative)
      // and add delivery payout (+)
      rider.walletBalance = Math.round(((rider.walletBalance || 0) - totalOrderPaid + payout) * 100) / 100;
      rider.codCashInHand = Math.round(((rider.codCashInHand || 0) + totalOrderPaid) * 100) / 100;
      order.paymentStatus = 'PAID_CASH';
    }
  }

  // Update Owner Profit Wallet
  db.wallets = db.wallets || {};
  db.wallets.owner = db.wallets.owner || {
    totalRevenue: 0,
    totalCommission: 0,
    totalPlatformFee: 0,
    totalDeliveryMargin: 0,
    netProfit: 0
  };

  if (order.financials) {
    db.wallets.owner.totalRevenue = Math.round((db.wallets.owner.totalRevenue + (order.financials.customerTotalPaid || 0)) * 100) / 100;
    db.wallets.owner.totalCommission = Math.round((db.wallets.owner.totalCommission + (order.financials.ownerCommission || 0)) * 100) / 100;
    db.wallets.owner.totalPlatformFee = Math.round((db.wallets.owner.totalPlatformFee + (order.financials.platformFee || 0)) * 100) / 100;
    db.wallets.owner.totalDeliveryMargin = Math.round((db.wallets.owner.totalDeliveryMargin + (order.financials.deliveryMargin || 0)) * 100) / 100;
    db.wallets.owner.netProfit = Math.round((db.wallets.owner.netProfit + (order.financials.ownerNetProfit || 0)) * 100) / 100;
  }

  writeDb(db);

  if (req.io) {
    req.io.emit('order_status_update', order);
    req.io.emit('order_status_updated', order);
    req.io.emit('global_order_update', order);
  }

  return res.json({
    success: true,
    message: isOnlinePayment
      ? 'Online Payment received via QR! Delivery completed, payout added to wallet.'
      : 'Cash collected! Order amount adjusted in Delivery Partner Wallet.',
    order,
    paymentType: isOnlinePayment ? 'ONLINE_QR' : 'CASH',
    riderWallet: rider ? rider.walletBalance : null,
    ownerProfitGained: order.financials ? order.financials.ownerNetProfit : 0
  });
}

/**
 * Backward compatibility: verifyDeliveryOtp delegates to completeDelivery (no OTP check required)
 */
function verifyDeliveryOtp(req, res) {
  return completeDelivery(req, res);
}

/**
 * Update live rider location coordinates
 */
function updateRiderLocation(req, res) {
  try {
    const { orderId, riderUserId, riderId, latitude, longitude } = req.body;
    const effectiveRiderId = riderUserId || riderId;
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'Latitude and Longitude required' });
    }
    const db = readDb();
    let updatedOrder = null;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (orderId) {
      const order = db.orders.find(o => o.orderId === orderId);
      if (order) {
        order.riderLat = lat;
        order.riderLng = lng;
        order.riderLocationUpdatedAt = new Date().toISOString();
        updatedOrder = order;
      }
    }

    if (effectiveRiderId) {
      const rider = db.riders.find(r => r.userId === effectiveRiderId || r.permanentRiderId === effectiveRiderId || r.phone === effectiveRiderId);
      if (rider) {
        rider.latitude = lat;
        rider.longitude = lng;
        rider.lastLocationUpdate = new Date().toISOString();
      }
    }

    writeDb(db);

    if (req.io) {
      if (orderId) {
        req.io.to(`order_${orderId}`).emit('rider_position', {
          orderId,
          latitude: lat,
          longitude: lng,
          riderUserId,
          updatedAt: new Date().toISOString()
        });
      }
      req.io.emit('rider_location_broadcast', {
        orderId,
        riderUserId,
        latitude: lat,
        longitude: lng
      });
    }

    return res.json({ success: true, message: 'Rider location updated', order: updatedOrder });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function cancelUnpaidOrder(req, res) {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'orderId is required' });
  }
  const db = readDb();
  const idx = db.orders.findIndex(o => o.orderId === orderId && (o.orderStatus === 'PENDING_PAYMENT' || o.paymentStatus === 'PAYMENT_PENDING'));
  if (idx !== -1) {
    db.orders.splice(idx, 1);
    writeDb(db);
    return res.json({ success: true, message: 'Unpaid cancelled order removed successfully', orderId });
  }
  return res.json({ success: true, message: 'Order was not pending payment' });
}

module.exports = {
  createOrder,
  getOrderDetails,
  listOrders,
  updateOrderStatus,
  riderAcceptOrder,
  riderArriveRestaurant,
  restaurantConfirmHandover,
  riderPickupOrder,
  riderRejectOrder,
  completeDelivery,
  verifyDeliveryOtp,
  updateRiderLocation,
  generateCodQr,
  checkCodQrPayment,
  cancelUnpaidOrder
};
