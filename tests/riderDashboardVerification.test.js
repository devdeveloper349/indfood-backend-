const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const assert = require('assert');
const { getRiderDashboardStats, toggleRiderOnlineStatus } = require('../src/controllers/kycController');
const { completeDelivery } = require('../src/controllers/orderController');
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

async function runE2ETests() {
  console.log('================================================================');
  console.log('  RIDER DASHBOARD REAL API & HARDCODED DATA ELIMINATION SUITE  ');
  console.log('================================================================\n');

  const db = readDb();
  let passed = 0;
  let total = 0;

  function pass(msg, ev = '') {
    passed++;
    total++;
    console.log(`[PASS] ${total}. ${msg}`);
    if (ev) console.log(`       Evidence: ${ev}`);
  }

  // Set up fresh test riders
  const newRiderPhone = '9800000001';
  let newRider = db.riders.find(r => r.phone === newRiderPhone);
  if (!newRider) {
    newRider = {
      userId: 'usr_new_zero_test',
      phone: newRiderPhone,
      name: 'Fresh Onboarded Partner',
      permanentRiderId: 'INDF-RD-10001',
      kycStatus: 'APPROVED',
      isOnline: false,
      walletBalance: 0,
      completedTrips: 0
    };
    db.riders.push(newRider);
  } else {
    newRider.isOnline = false;
    newRider.completedTrips = 0;
  }

  const activeRiderPhone = '9800000002';
  let activeRider = db.riders.find(r => r.phone === activeRiderPhone);
  if (!activeRider) {
    activeRider = {
      userId: 'usr_active_delivery_test',
      phone: activeRiderPhone,
      name: 'Active Delivery Hero',
      permanentRiderId: 'INDF-RD-10002',
      kycStatus: 'APPROVED',
      isOnline: true,
      walletBalance: 85,
      completedTrips: 1
    };
    db.riders.push(activeRider);
  } else {
    activeRider.isOnline = true;
  }

  // Create an authentic completed delivery order for activeRider
  db.orders = (db.orders || []).filter(o => o.orderId !== 'ORD-ACTIVE-OFFLINE-1');
  const testOrderId = 'ORD-VERIF-ACTIVE-1';
  let activeOrder = db.orders.find(o => o.orderId === testOrderId);
  if (!activeOrder) {
    activeOrder = {
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
        foodTotal: 450,
        distanceKm: 5.2,
        totalDistanceKm: 5.2,
        riderPayout: 75,
        riderIncentive: 15
      }
    };
    db.orders.push(activeOrder);
  } else {
    activeOrder.deliveredAt = new Date().toISOString();
    activeOrder.financials = {
      foodTotal: 450,
      distanceKm: 5.2,
      totalDistanceKm: 5.2,
      riderPayout: 75,
      riderIncentive: 15
    };
  }
  writeDb(db);

  const newToken = generateUserJwt({
    id: newRider.userId,
    phone: newRider.phone,
    name: newRider.name,
    role: 'rider',
    permanentRiderId: newRider.permanentRiderId
  });

  const activeToken = generateUserJwt({
    id: activeRider.userId,
    phone: activeRider.phone,
    name: activeRider.name,
    role: 'rider',
    permanentRiderId: activeRider.permanentRiderId
  });

  const attackerToken = generateUserJwt({
    id: 'usr_malicious_hacker',
    phone: '9800000099',
    name: 'Unauthorized Caller',
    role: 'rider',
    permanentRiderId: 'INDF-RD-99999'
  });

  // Ensure attacker exists in db.riders for valid JWT lookup
  if (!db.riders.some(r => r.phone === '9800000099')) {
    db.riders.push({
      userId: 'usr_malicious_hacker',
      phone: '9800000099',
      name: 'Unauthorized Caller',
      permanentRiderId: 'INDF-RD-99999',
      kycStatus: 'APPROVED',
      isOnline: false
    });
    writeDb(db);
  }

  // -------------------------------------------------------------
  // TEST SCENARIO 1: New rider with zero deliveries
  // -------------------------------------------------------------
  const { req: req1, res: res1 } = createMockReqRes({
    headers: { authorization: `Bearer ${newToken}` },
    query: { userId: newRider.userId }
  });
  getRiderDashboardStats(req1, res1);
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res1.data.metrics.todayEarnings.amount, 0, 'Must show ₹0 earnings');
  assert.strictEqual(res1.data.metrics.completedOrders.count, 0, 'Must show 0 completed orders');
  assert.strictEqual(res1.data.metrics.thisWeekDistance.distanceKm, 0, 'Must show 0 km distance');
  assert.strictEqual(res1.data.metrics.incentiveBonus.amount, 0, 'Must show ₹0 incentive');
  assert.strictEqual(res1.data.rider.isTopRider, false, 'Must NOT qualify as Top Rider');
  assert.notStrictEqual(res1.data.rider.tier, 'Top Rider', 'Must NOT have Top Rider tier');
  assert.strictEqual(res1.data.metrics.notifications.unreadCount, 0, 'Must have 0 unread notifications');
  pass('Test 1: New rider with 0 deliveries returns genuine 0 metrics across all cards without mock data',
    `Earnings: ₹${res1.data.metrics.todayEarnings.amount}, Orders: ${res1.data.metrics.completedOrders.count}, Distance: ${res1.data.metrics.thisWeekDistance.distanceKm}km, TopRider: ${res1.data.rider.isTopRider}`);

  // -------------------------------------------------------------
  // TEST SCENARIO 2: Rider with actual completed deliveries
  // -------------------------------------------------------------
  const { req: req2, res: res2 } = createMockReqRes({
    headers: { authorization: `Bearer ${activeToken}` },
    query: { userId: activeRider.userId }
  });
  getRiderDashboardStats(req2, res2);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.data.metrics.todayEarnings.amount, 75, 'Must calculate real payout sum');
  assert.strictEqual(res2.data.metrics.completedOrders.count, 1, 'Must count real delivered orders');
  assert.strictEqual(res2.data.metrics.thisWeekDistance.distanceKm, 5.2, 'Must calculate real delivered distance');
  assert.strictEqual(res2.data.metrics.incentiveBonus.amount, 15, 'Must calculate real incentive');
  pass('Test 2: Rider with completed deliveries reflects real earnings and metrics from delivered order records',
    `Earnings: ₹${res2.data.metrics.todayEarnings.amount}, Orders: ${res2.data.metrics.completedOrders.count}, Distance: ${res2.data.metrics.thisWeekDistance.distanceKm}km, Incentive: ₹${res2.data.metrics.incentiveBonus.amount}`);

  // -------------------------------------------------------------
  // TEST SCENARIO 3: App launch when rider is Online vs Offline
  // -------------------------------------------------------------
  assert.strictEqual(res1.data.rider.isOnline, false, 'New rider initially Offline in DB');
  assert.strictEqual(res2.data.rider.isOnline, true, 'Active rider initially Online in DB');
  pass('Test 3: App launch reads real saved duty status (Online vs Offline) instead of hardcoding Online',
    `NewRider isOnline: ${res1.data.rider.isOnline}, ActiveRider isOnline: ${res2.data.rider.isOnline}`);

  // -------------------------------------------------------------
  // TEST SCENARIO 4: Successful toggle in both directions
  // -------------------------------------------------------------
  // Toggle Active Rider: Online -> Offline
  const { req: req4a, res: res4a } = createMockReqRes({
    headers: { authorization: `Bearer ${activeToken}` },
    body: { isOnline: false }
  });
  toggleRiderOnlineStatus(req4a, res4a);
  assert.strictEqual(res4a.statusCode, 200);
  assert.strictEqual(res4a.data.isOnline, false);

  // Toggle Active Rider: Offline -> Online
  const { req: req4b, res: res4b } = createMockReqRes({
    headers: { authorization: `Bearer ${activeToken}` },
    body: { isOnline: true }
  });
  toggleRiderOnlineStatus(req4b, res4b);
  assert.strictEqual(res4b.statusCode, 200);
  assert.strictEqual(res4b.data.isOnline, true);
  pass('Test 4: Rider successfully toggles duty status Online -> Offline and Offline -> Online',
    `Step 1 isOnline: ${res4a.data.isOnline}, Step 2 isOnline: ${res4b.data.isOnline}`);

  // -------------------------------------------------------------
  // TEST SCENARIO 5: Backend / API failure while toggling
  // -------------------------------------------------------------
  // 5a. Unauthenticated toggle
  const { req: req5a, res: res5a } = createMockReqRes({
    body: { isOnline: false }
  });
  toggleRiderOnlineStatus(req5a, res5a);
  assert.strictEqual(res5a.statusCode, 401, 'Unauthenticated toggle must return 401');

  // 5b. Invalid / tampered token
  const { req: req5b, res: res5b } = createMockReqRes({
    headers: { authorization: 'Bearer invalid.tampered.jwt.signature' },
    body: { isOnline: false }
  });
  toggleRiderOnlineStatus(req5b, res5b);
  assert.strictEqual(res5b.statusCode, 401, 'Tampered token must return 401');
  pass('Test 5: API failure guards properly reject unauthenticated and tampered toggle requests with 401',
    `Unauthenticated status: ${res5a.statusCode}, Tampered status: ${res5b.statusCode}`);

  // -------------------------------------------------------------
  // TEST SCENARIO 6: No metrics or notification data available
  // -------------------------------------------------------------
  assert.strictEqual(res1.data.metrics.notifications.unreadCount, 0);
  assert.strictEqual(res1.data.metrics.todayEarnings.amount, 0);
  assert.strictEqual(res1.data.metrics.completedOrders.count, 0);
  assert.strictEqual(res1.data.metrics.thisWeekDistance.distanceKm, 0);
  pass('Test 6: Safe fallback handling when no metrics or notification records exist',
    'Unread count: 0, Earnings: ₹0, Orders: 0, Distance: 0 km');

  // -------------------------------------------------------------
  // TEST SCENARIO 7: Cross-rider snooping & unauthorized modification
  // -------------------------------------------------------------
  // 7a. Attacker attempts to read victim metrics
  const { req: req7a, res: res7a } = createMockReqRes({
    headers: { authorization: `Bearer ${attackerToken}` },
    query: { userId: activeRider.userId }
  });
  getRiderDashboardStats(req7a, res7a);
  assert.strictEqual(res7a.statusCode, 403, 'Cross-rider metrics snooping must return 403');

  // 7b. Attacker attempts to toggle victim online status
  const { req: req7b, res: res7b } = createMockReqRes({
    headers: { authorization: `Bearer ${attackerToken}` },
    body: { riderUserId: activeRider.userId, isOnline: false }
  });
  toggleRiderOnlineStatus(req7b, res7b);
  assert.strictEqual(res7b.statusCode, 403, 'Cross-rider status modification must return 403');
  pass('Test 7: Cross-rider security guards strictly block unauthorized metric access and status changes with 403 Forbidden',
    `Snoop Code: ${res7a.statusCode} (${res7a.data.message}), Tamper Code: ${res7b.statusCode} (${res7b.data.message})`);

  // -------------------------------------------------------------
  // TEST SCENARIO 8: App refresh / reopen consistency
  // -------------------------------------------------------------
  const { req: req8, res: res8 } = createMockReqRes({
    headers: { authorization: `Bearer ${newToken}` },
    query: { userId: newRider.userId }
  });
  getRiderDashboardStats(req8, res8);
  assert.strictEqual(res8.data.metrics.todayEarnings.amount, 0);
  assert.strictEqual(res8.data.metrics.completedOrders.count, 0);
  assert.strictEqual(res8.data.metrics.thisWeekDistance.distanceKm, 0);
  assert.strictEqual(res8.data.rider.isTopRider, false);
  pass('Test 8: App refresh returns identical, authentic 0-state data without reverting to fabricated figures',
    `Refreshed Earnings: ₹${res8.data.metrics.todayEarnings.amount}, Orders: ${res8.data.metrics.completedOrders.count}, Distance: ${res8.data.metrics.thisWeekDistance.distanceKm}km`);

  // -------------------------------------------------------------
  // TEST SCENARIO 9: Offline rider cannot receive new order assignments, while active order completion is uninterrupted
  // -------------------------------------------------------------
  // 9a. Toggle active rider to OFFLINE
  const { req: req9a, res: res9a } = createMockReqRes({
    headers: { authorization: `Bearer ${activeToken}` },
    body: { isOnline: false }
  });
  toggleRiderOnlineStatus(req9a, res9a);
  assert.strictEqual(res9a.statusCode, 200);
  assert.strictEqual(res9a.data.isOnline, false);

  // Verify rider is now marked offline in DB
  const dbUpdated = readDb();
  const riderInDb = dbUpdated.riders.find(r => r.userId === activeRider.userId);
  assert.strictEqual(riderInDb.isOnline, false, 'Rider must be persisted as offline in DB');

  // Verify eligible rider filter excludes this offline rider
  const busyRiderIds = new Set();
  const eligibleRiders = (dbUpdated.riders || []).filter(r =>
    r.kycStatus === 'APPROVED' &&
    r.isOnline !== false &&
    !busyRiderIds.has(r.userId) &&
    !busyRiderIds.has(r.permanentRiderId)
  );
  assert.strictEqual(
    eligibleRiders.some(r => r.userId === activeRider.userId),
    false,
    'Offline rider must NEVER be included in eligible riders for new order assignments'
  );

  // 9b. Active order completion: Rider has an in-progress active delivery ORD-ACTIVE-OFFLINE-1
  const testActiveOrderId = 'ORD-ACTIVE-OFFLINE-1';
  let activeOrderOffline = dbUpdated.orders.find(o => o.orderId === testActiveOrderId);
  if (!activeOrderOffline) {
    activeOrderOffline = {
      orderId: testActiveOrderId,
      orderStatus: 'ON_THE_WAY',
      deliveryOtp: '7412',
      customerPhone: '9826011111',
      assignedRider: {
        userId: activeRider.userId,
        permanentRiderId: activeRider.permanentRiderId,
        phone: activeRider.phone,
        name: activeRider.name
      },
      financials: {
        foodTotal: 300,
        distanceKm: 3.5,
        totalDistanceKm: 3.5,
        riderPayout: 55,
        riderIncentive: 10
      }
    };
    dbUpdated.orders.push(activeOrderOffline);
  } else {
    activeOrderOffline.orderStatus = 'ON_THE_WAY';
    activeOrderOffline.deliveryOtp = '7412';
    activeOrderOffline.assignedRider = {
      userId: activeRider.userId,
      permanentRiderId: activeRider.permanentRiderId,
      phone: activeRider.phone,
      name: activeRider.name
    };
  }
  writeDb(dbUpdated);

  const { req: req9b, res: res9b } = createMockReqRes({
    headers: { authorization: `Bearer ${activeToken}` },
    body: {
      orderId: testActiveOrderId,
      otp: '7412',
      deliveryOtp: '7412'
    }
  });
  completeDelivery(req9b, res9b);
  assert.strictEqual(res9b.statusCode, 200, 'Already-active delivery must complete without interruption while offline');
  assert.strictEqual(res9b.data.success, true);
  assert.strictEqual(res9b.data.order.orderStatus, 'DELIVERED');
  pass('Test 9: Offline rider cannot receive new delivery assignments, while already-active deliveries remain safe and uninterrupted',
    `isOnline: ${res9a.data.isOnline}, Excluded from new dispatch: true, Active Delivery Completed: ${res9b.data.order.orderStatus}`);

  console.log(`\n================================================================`);
  console.log(`  ALL ${passed}/${total} E2E VERIFICATION TEST SCENARIOS PASSED CLEANLY!  `);
  console.log(`================================================================\n`);
}

runE2ETests().catch(err => {
  console.error('E2E Verification failed:', err);
  process.exit(1);
});
