const { readDb, writeDb } = require('../models/db');

function getDashboardStats(req, res) {
  const db = readDb();
  
  const totalOrders = db.orders.length;
  const completedOrders = db.orders.filter(o => o.orderStatus === 'DELIVERED').length;
  const activeOrders = db.orders.filter(o => !['DELIVERED', 'CANCELLED'].includes(o.orderStatus)).length;
  
  const totalRiders = db.riders.length;
  const approvedRiders = db.riders.filter(r => r.kycStatus === 'APPROVED').length;
  const pendingKycRiders = db.riders.filter(r => r.kycStatus === 'SUBMITTED' || r.kycStatus === 'PENDING').length;
  
  const wallet = db.wallets ? db.wallets.owner : {
    totalRevenue: 0,
    totalCommission: 0,
    totalPlatformFee: 0,
    totalDeliveryMargin: 0,
    netProfit: 0
  };

  return res.json({
    success: true,
    stats: {
      totalOrders,
      completedOrders,
      activeOrders,
      totalRiders,
      approvedRiders,
      pendingKycRiders,
      totalRestaurants: db.restaurants.length,
      wallet,
      settings: db.settings
    },
    settings: db.settings,
    recentOrders: db.orders.slice(-10).reverse(),
    pendingKycList: db.riders.filter(r => r.kycStatus === 'SUBMITTED' || r.kycStatus === 'PENDING')
  });
}

function getSettings(req, res) {
  const db = readDb();
  return res.json({
    success: true,
    settings: db.settings
  });
}

function updateSettings(req, res) {
  const db = readDb();
  db.settings = db.settings || {};

  const {
    riderPerKmRate,
    riderIncentiveBonus,
    riderIncentiveActive,
    riderMinBasePay,
    businessName,
    businessUpiId,
    defaultRestaurantCommission,
    defaultPlatformFee,
    customerBaseDeliveryFee,
    customerPerKmDeliveryFee
  } = req.body;

  if (riderPerKmRate !== undefined && !isNaN(parseFloat(riderPerKmRate))) {
    db.settings.riderPerKmRate = Math.max(0.1, parseFloat(riderPerKmRate));
  }
  if (riderIncentiveBonus !== undefined && !isNaN(parseFloat(riderIncentiveBonus))) {
    db.settings.riderIncentiveBonus = Math.max(0, parseFloat(riderIncentiveBonus));
  }
  if (riderIncentiveActive !== undefined) {
    db.settings.riderIncentiveActive = !!riderIncentiveActive;
  }
  if (riderMinBasePay !== undefined && !isNaN(parseFloat(riderMinBasePay))) {
    db.settings.riderMinBasePay = Math.max(0, parseFloat(riderMinBasePay));
  }
  if (businessName && typeof businessName === 'string') {
    db.settings.businessName = businessName.trim();
  }
  if (businessUpiId && typeof businessUpiId === 'string') {
    db.settings.businessUpiId = businessUpiId.trim();
  }
  if (defaultRestaurantCommission !== undefined && !isNaN(parseFloat(defaultRestaurantCommission))) {
    db.settings.defaultRestaurantCommission = Math.max(0, Math.min(100, parseFloat(defaultRestaurantCommission)));
  }
  if (defaultPlatformFee !== undefined && !isNaN(parseFloat(defaultPlatformFee))) {
    db.settings.defaultPlatformFee = Math.max(0, parseFloat(defaultPlatformFee));
  }
  if (customerBaseDeliveryFee !== undefined && !isNaN(parseFloat(customerBaseDeliveryFee))) {
    db.settings.customerBaseDeliveryFee = Math.max(0, parseFloat(customerBaseDeliveryFee));
  }
  if (customerPerKmDeliveryFee !== undefined && !isNaN(parseFloat(customerPerKmDeliveryFee))) {
    db.settings.customerPerKmDeliveryFee = Math.max(0, parseFloat(customerPerKmDeliveryFee));
  }

  writeDb(db);

  return res.json({
    success: true,
    message: 'INDFood admin settings saved successfully!',
    settings: db.settings
  });
}

function getAdminRestaurants(req, res) {
  const db = readDb();
  const defaultComm = (db.settings && db.settings.defaultRestaurantCommission) !== undefined
    ? db.settings.defaultRestaurantCommission
    : 15;

  const restaurants = (db.restaurants || []).map(r => ({
    id: r.id,
    name: r.name || 'Unnamed Restaurant',
    phone: r.phone || '',
    ownerEmail: r.ownerEmail || '',
    address: r.address || 'Address not set',
    cuisine: r.cuisine || '',
    commissionPercent: (r.commissionPercent !== undefined && !isNaN(parseFloat(r.commissionPercent)))
      ? parseFloat(r.commissionPercent)
      : defaultComm,
    isActive: r.isActive !== false,
    isOpen: r.isOpen !== false,
    menuItemCount: (r.menu || []).length,
    createdAt: r.createdAt || ''
  }));

  return res.json({
    success: true,
    defaultCommission: defaultComm,
    restaurants
  });
}

function updateRestaurantCommission(req, res) {
  const { restaurantId, commissionPercent } = req.body;
  if (commissionPercent === undefined || isNaN(parseFloat(commissionPercent))) {
    return res.status(400).json({ success: false, message: 'Valid commission percentage is required' });
  }

  const cleanPercent = Math.max(0, Math.min(100, parseFloat(commissionPercent)));
  const db = readDb();
  
  if (restaurantId) {
    const rest = db.restaurants.find(r => r.id === restaurantId);
    if (!rest) {
      return res.status(404).json({ success: false, message: 'Restaurant not found with ID: ' + restaurantId });
    }
    rest.commissionPercent = cleanPercent;
    writeDb(db);
    return res.json({
      success: true,
      message: `Commission updated to ${cleanPercent}% for "${rest.name}"`,
      restaurant: {
        id: rest.id,
        name: rest.name,
        commissionPercent: rest.commissionPercent
      }
    });
  } else {
    // Update default for all and update settings
    db.settings = db.settings || {};
    db.settings.defaultRestaurantCommission = cleanPercent;
    (db.restaurants || []).forEach(r => {
      r.commissionPercent = cleanPercent;
    });
    writeDb(db);
    return res.json({
      success: true,
      message: `Global default commission updated to ${cleanPercent}% for all restaurants`,
      defaultCommission: cleanPercent
    });
  }
}

function resetDatabase(req, res) {
  const cleanData = {
    users: [
      {
        id: 'usr_admin_1',
        name: 'INDFood Master Admin',
        phone: '9999999999',
        role: 'admin',
        createdAt: new Date().toISOString()
      }
    ],
    riders: [],
    restaurants: [],
    shifts: [
      { id: 'shift_1', name: 'Morning Breakfast', time: '07:30 AM - 11:00 AM', maxSlots: 15, bookedRiders: [] },
      { id: 'shift_2', name: 'Lunch Peak Rush', time: '12:00 PM - 03:30 PM', maxSlots: 30, bookedRiders: [] },
      { id: 'shift_3', name: 'Evening Snacks', time: '04:00 PM - 07:00 PM', maxSlots: 20, bookedRiders: [] },
      { id: 'shift_4', name: 'Dinner Super Peak', time: '07:30 PM - 11:30 PM', maxSlots: 40, bookedRiders: [] },
      { id: 'shift_5', name: 'Late Night Cravings', time: '11:30 PM - 03:00 AM', maxSlots: 10, bookedRiders: [] }
    ],
    orders: [],
    promocodes: [],
    settings: {
      businessName: 'INDFood',
      businessUpiId: process.env.BUSINESS_UPI_ID || '9174782706@ybl',
      riderPerKmRate: 12.00,
      riderIncentiveBonus: 15.00,
      riderIncentiveActive: true,
      riderMinBasePay: 0.00,
      defaultRestaurantCommission: 15.00,
      defaultPlatformFee: 8.00,
      customerBaseDeliveryFee: 30.00,
      customerPerKmDeliveryFee: 12.50
    },
    wallets: {
      owner: {
        totalRevenue: 0,
        totalCommission: 0,
        totalPlatformFee: 0,
        totalDeliveryMargin: 0,
        netProfit: 0
      }
    }
  };

  writeDb(cleanData);
  return res.json({ success: true, message: 'All INDfood application data cleared successfully!' });
}

function lookupRider(req, res) {
  const query = (req.query.q || req.query.riderId || '').toString().trim().toLowerCase();
  if (!query) {
    return res.status(400).json({ success: false, message: 'Please provide rider ID, phone or name to search' });
  }

  const db = readDb();
  const rider = db.riders.find(r => 
    (r.permanentRiderId && r.permanentRiderId.toLowerCase() === query) ||
    (r.userId && r.userId.toLowerCase() === query) ||
    (r.phone && r.phone.toLowerCase() === query) ||
    (r.name && r.name.toLowerCase().includes(query)) ||
    (r.panNumber && r.panNumber.toLowerCase() === query)
  );

  if (!rider) {
    return res.status(404).json({ success: false, message: 'No delivery partner found with ID / phone: ' + query });
  }

  const riderOrders = db.orders.filter(o => 
    o.assignedRider && (
      o.assignedRider.permanentRiderId === rider.permanentRiderId ||
      o.assignedRider.userId === rider.userId ||
      o.assignedRider.phone === rider.phone
    )
  ).slice(-10).reverse();

  return res.json({
    success: true,
    rider,
    orders: riderOrders
  });
}

function toggleBlockRider(req, res) {
  const { riderId } = req.body;
  const db = readDb();
  const rider = db.riders.find(r => r.permanentRiderId === riderId || r.userId === riderId || r.phone === riderId);
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }

  rider.isBlocked = !rider.isBlocked;
  if (rider.isBlocked) {
    rider.isOnline = false;
  }
  writeDb(db);

  return res.json({
    success: true,
    message: rider.isBlocked ? `Rider ${rider.name} (${rider.permanentRiderId}) has been BLOCKED/SUSPENDED.` : `Rider ${rider.name} has been ACTIVATED.`,
    isBlocked: rider.isBlocked
  });
}

module.exports = {
  getDashboardStats,
  getSettings,
  updateSettings,
  getAdminRestaurants,
  updateRestaurantCommission,
  updatePlatformCommission: updateRestaurantCommission,
  resetDatabase,
  lookupRider,
  toggleBlockRider
};
