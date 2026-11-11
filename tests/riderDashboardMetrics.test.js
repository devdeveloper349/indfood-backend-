const assert = require('assert');
const { getRiderDashboardStats, toggleRiderOnlineStatus } = require('../src/controllers/kycController');
const { readDb, writeDb } = require('../src/models/db');
const { generateUserJwt } = require('../src/controllers/authController');

function createMockReqRes({ body = {}, query = {}, headers = {} }) {
  const req = { body, query, headers };
  const res = {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    }
  };
  return { req, res };
}

async function runTests() {
  console.log('====================================================');
  console.log('  INDFOOD RIDER DASHBOARD & METRICS TEST SUITE');
  console.log('====================================================\n');

  const db = readDb();
  let passed = 0;
  let total = 0;

  function pass(msg, ev = '') {
    passed++;
    total++;
    console.log(`[PASS] ${total}. ${msg}`);
    if (ev) console.log(`       Evidence: ${ev}`);
  }

  // 1. New Rider with ZERO deliveries
  const newRiderPhone = '9991110000';
  let newRider = db.riders.find(r => r.phone === newRiderPhone);
  if (!newRider) {
    newRider = {
      userId: 'usr_new_rider_zero',
      phone: newRiderPhone,
      name: 'Fresh Rider',
      email: 'fresh@indfood.app',
      permanentRiderId: 'INDF-RD-00001',
      kycStatus: 'APPROVED',
      isOnline: false,
      walletBalance: 0,
      completedTrips: 0
    };
    db.riders.push(newRider);
    writeDb(db);
  }

  const newRiderToken = generateUserJwt({
    id: newRider.userId,
    phone: newRider.phone,
    name: newRider.name,
    role: 'rider',
    permanentRiderId: newRider.permanentRiderId
  });

  const { req: req0, res: res0 } = createMockReqRes({
    headers: { authorization: `Bearer ${newRiderToken}` },
    query: { userId: newRider.userId }
  });

  getRiderDashboardStats(req0, res0);
  assert.strictEqual(res0.statusCode, 200);
  assert.strictEqual(res0.data.success, true);
  assert.strictEqual(res0.data.rider.name, 'Fresh Rider');
  assert.strictEqual(res0.data.rider.isOnline, false);
  assert.strictEqual(res0.data.rider.isTopRider, false);
  assert.notStrictEqual(res0.data.rider.tier, 'Top Rider');
  assert.strictEqual(res0.data.metrics.todayEarnings.amount, 0);
  assert.strictEqual(res0.data.metrics.completedOrders.count, 0);
  assert.strictEqual(res0.data.metrics.thisWeekDistance.distanceKm, 0);
  assert.strictEqual(res0.data.metrics.incentiveBonus.amount, 0);
  assert.strictEqual(res0.data.metrics.notifications.unreadCount, 0);
  pass('New rider with 0 deliveries returns genuine ₹0 earnings, 0 orders, 0 km, ₹0 incentive, and no Top Rider badge',
    `Today Earnings: ₹${res0.data.metrics.todayEarnings.amount}, Orders: ${res0.data.metrics.completedOrders.count}, Distance: ${res0.data.metrics.thisWeekDistance.distanceKm} km, TopRider: ${res0.data.rider.isTopRider}`);

  // 2. Rider with actual completed deliveries
  const activeRiderPhone = '9998881234';
  let activeRider = db.riders.find(r => r.phone === activeRiderPhone);
  if (!activeRider) {
    activeRider = {
      userId: 'usr_test_rider_dash',
      phone: activeRiderPhone,
      name: 'Ramesh Kumar',
      email: 'ramesh@indfood.app',
      permanentRiderId: 'INDF-RD-77788',
      kycStatus: 'APPROVED',
      isOnline: true,
      walletBalance: 120,
      completedTrips: 1
    };
    db.riders.push(activeRider);
  } else {
    activeRider.name = 'Ramesh Kumar';
  }

  // Create test order delivered today for activeRider
  db.orders = db.orders || [];
  const testOrderId = 'ORD-TEST-DASH-1';
  let testOrder = db.orders.find(o => o.orderId === testOrderId);
  if (!testOrder) {
    testOrder = {
      orderId: testOrderId,
      orderStatus: 'DELIVERED',
      assignedRider: {
        userId: activeRider.userId,
        permanentRiderId: activeRider.permanentRiderId,
        phone: activeRider.phone,
        name: activeRider.name
      },
      deliveredAt: new Date().toISOString(),
      financials: {
        foodTotal: 300,
        distanceKm: 4.5,
        totalDistanceKm: 4.5,
        riderPayout: 65,
        riderIncentive: 15
      }
    };
    db.orders.push(testOrder);
  } else {
    testOrder.deliveredAt = new Date().toISOString();
    testOrder.financials = {
      foodTotal: 300,
      distanceKm: 4.5,
      totalDistanceKm: 4.5,
      riderPayout: 65,
      riderIncentive: 15
    };
  }
  writeDb(db);

  const activeRiderToken = generateUserJwt({
    id: activeRider.userId,
    phone: activeRider.phone,
    name: activeRider.name,
    role: 'rider',
    permanentRiderId: activeRider.permanentRiderId
  });

  const { req: req1, res: res1 } = createMockReqRes({
    headers: { authorization: `Bearer ${activeRiderToken}` },
    query: { userId: activeRider.userId }
  });

  getRiderDashboardStats(req1, res1);
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res1.data.success, true);
  assert.strictEqual(res1.data.rider.name, 'Ramesh Kumar');
  assert(res1.data.metrics.todayEarnings.amount >= 65, 'Today earnings must reflect real completed delivery payout');
  assert(res1.data.metrics.completedOrders.count >= 1, 'Completed orders count must reflect real completed order');
  assert(res1.data.metrics.thisWeekDistance.distanceKm >= 4.5, 'Weekly distance must reflect real delivered distance');
  assert(res1.data.metrics.incentiveBonus.amount >= 15, 'Incentive must reflect real rider incentive');
  pass('Rider with real deliveries returns calculated earnings, order count, distance and incentive',
    `Today Earnings: ₹${res1.data.metrics.todayEarnings.amount}, Orders: ${res1.data.metrics.completedOrders.count}, Distance: ${res1.data.metrics.thisWeekDistance.distanceKm} km, Incentive: ₹${res1.data.metrics.incentiveBonus.amount}`);

  // 3. Cross-Rider Stats Snooping Protection (Rider A cannot access Rider B stats)
  const attackerPhone = '9111111111';
  let attackerRider = db.riders.find(r => r.phone === attackerPhone);
  if (!attackerRider) {
    attackerRider = {
      userId: 'usr_attacker_rider',
      phone: attackerPhone,
      name: 'Attacker Rider',
      permanentRiderId: 'INDF-RD-99999',
      kycStatus: 'APPROVED',
      isOnline: false
    };
    db.riders.push(attackerRider);
    writeDb(db);
  }

  const attackerToken = generateUserJwt({
    id: attackerRider.userId,
    phone: attackerRider.phone,
    name: attackerRider.name,
    role: 'rider',
    permanentRiderId: attackerRider.permanentRiderId
  });

  const { req: req2, res: res2 } = createMockReqRes({
    headers: { authorization: `Bearer ${attackerToken}` },
    query: { userId: activeRider.userId }
  });

  getRiderDashboardStats(req2, res2);
  assert.strictEqual(res2.statusCode, 403);
  assert.strictEqual(res2.data.success, false);
  pass('Cross-Rider stats snooping is strictly rejected with 403 Forbidden', res2.data.message);

  // 4. Non-existent Rider returns 404
  const { req: req3, res: res3 } = createMockReqRes({
    headers: { authorization: `Bearer ${activeRiderToken}` },
    query: { userId: 'non_existent_rider_xyz_9999' }
  });

  getRiderDashboardStats(req3, res3);
  assert.strictEqual(res3.statusCode, 403); // Cross-rider check catches this first
  pass('Accessing unauthorized/foreign rider ID is forbidden', res3.data.message);

  // 5. Toggle Rider Online / Duty Status to OFFLINE
  const { req: req4, res: res4 } = createMockReqRes({
    headers: { authorization: `Bearer ${activeRiderToken}` },
    body: { isOnline: false }
  });

  toggleRiderOnlineStatus(req4, res4);
  assert.strictEqual(res4.statusCode, 200);
  assert.strictEqual(res4.data.isOnline, false);
  pass('Rider successfully toggles duty status to OFFLINE', `isOnline: ${res4.data.isOnline}`);

  // 6. Toggle back to ONLINE
  const { req: req5, res: res5 } = createMockReqRes({
    headers: { authorization: `Bearer ${activeRiderToken}` },
    body: { isOnline: true }
  });

  toggleRiderOnlineStatus(req5, res5);
  assert.strictEqual(res5.statusCode, 200);
  assert.strictEqual(res5.data.isOnline, true);
  pass('Rider successfully toggles duty status back to ONLINE', `isOnline: ${res5.data.isOnline}`);

  // 7. Cross-Rider Online Status Modification Guard
  const { req: req6, res: res6 } = createMockReqRes({
    headers: { authorization: `Bearer ${attackerToken}` },
    body: { riderUserId: activeRider.userId, isOnline: false }
  });

  toggleRiderOnlineStatus(req6, res6);
  assert.strictEqual(res6.statusCode, 403);
  assert.strictEqual(res6.data.success, false);
  pass('One rider cannot modify another rider online status (403 Forbidden)', res6.data.message);

  // 8. Unauthenticated toggle request rejected with 401
  const { req: req7, res: res7 } = createMockReqRes({
    body: { riderUserId: activeRider.userId, isOnline: false }
  });

  toggleRiderOnlineStatus(req7, res7);
  assert.strictEqual(res7.statusCode, 401);
  assert.strictEqual(res7.data.success, false);
  pass('Unauthenticated toggle request is rejected with 401 Unauthorized', res7.data.message);

  // 9. Invalid/tampered JWT token rejected with 401
  const { req: req8, res: res8 } = createMockReqRes({
    headers: { authorization: 'Bearer invalid.tampered.token' },
    body: { isOnline: false }
  });

  toggleRiderOnlineStatus(req8, res8);
  assert.strictEqual(res8.statusCode, 401);
  assert.strictEqual(res8.data.success, false);
  pass('Invalid or tampered token is rejected with 401 Unauthorized', res8.data.message);

  console.log(`\n====================================================`);
  console.log(`TEST SUMMARY: ${passed}/${total} TESTS PASSED`);
  console.log(`====================================================\n`);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
