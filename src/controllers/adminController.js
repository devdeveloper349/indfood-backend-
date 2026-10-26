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
      wallet
    },
    recentOrders: db.orders.slice(-10).reverse(),
    pendingKycList: db.riders.filter(r => r.kycStatus === 'SUBMITTED' || r.kycStatus === 'PENDING')
  });
}

function updatePlatformCommission(req, res) {
  const { restaurantId, commissionPercent } = req.body;
  const db = readDb();
  
  if (restaurantId) {
    const rest = db.restaurants.find(r => r.id === restaurantId);
    if (rest) rest.commissionPercent = parseFloat(commissionPercent);
  } else {
    // Update default for all
    db.restaurants.forEach(r => {
      r.commissionPercent = parseFloat(commissionPercent);
    });
  }

  writeDb(db);
  return res.json({ success: true, message: `Commission updated to ${commissionPercent}%` });
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

module.exports = {
  getDashboardStats,
  updatePlatformCommission,
  resetDatabase
};
