const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readDb, writeDb } = require('../src/models/db');
const trackingManager = require('../src/services/trackingManager');
const orderController = require('../src/controllers/orderController');

const DB_FILE = path.join(__dirname, '../data/database.json');

// Helper to create mock Socket.IO instance
function createMockIo() {
  const emittedEvents = [];
  return {
    emittedEvents,
    to(room) {
      return {
        emit(event, data) {
          emittedEvents.push({ room, event, data, time: Date.now() });
        }
      };
    },
    emit(event, data) {
      emittedEvents.push({ room: 'global', event, data, time: Date.now() });
    }
  };
}

// Helper to create mock Socket client
function createMockSocket(id) {
  const rooms = new Set();
  const sentMessages = [];
  return {
    id,
    rooms,
    sentMessages,
    join(room) {
      rooms.add(room);
    },
    emit(event, data) {
      sentMessages.push({ event, data });
    }
  };
}

async function runTests() {
  console.log('🧪 Starting INDFood Live GPS Tracking Optimization Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  // Setup test environment in database
  const db = readDb();
  const testOrderId = 'ord_test_gps_9999';
  const testRiderId = 'INDF-RD-TEST01';
  const testRiderUserId = 'usr_rider_test_01';
  const testRiderPhone = '9876543210';
  const testCustomerId = 'usr_cust_test_01';

  // Ensure test order exists with assigned rider
  let testOrder = db.orders.find(o => o.orderId === testOrderId);
  if (!testOrder) {
    testOrder = {
      orderId: testOrderId,
      customerId: testCustomerId,
      customerPhone: '9988776655',
      restaurantId: 'rest_01',
      restaurantLat: 28.6139,
      restaurantLng: 77.2090,
      customerLat: 28.6200,
      customerLng: 77.2150,
      orderStatus: 'ON_THE_WAY',
      paymentMethod: 'ONLINE',
      paymentStatus: 'PAID',
      assignedRider: {
        userId: testRiderUserId,
        permanentRiderId: testRiderId,
        name: 'Test Super Rider',
        phone: testRiderPhone
      },
      riderLat: 28.6140,
      riderLng: 77.2095
    };
    db.orders.push(testOrder);
    writeDb(db);
  } else {
    testOrder.orderStatus = 'ON_THE_WAY';
    testOrder.assignedRider = {
      userId: testRiderUserId,
      permanentRiderId: testRiderId,
      name: 'Test Super Rider',
      phone: testRiderPhone
    };
    writeDb(db);
  }

  trackingManager.resetForTesting();
  const mockIo = createMockIo();

  // Test 1: Zero Disk Write on GPS Update
  test('1. GPS update in RAM does NOT trigger database.json disk write', () => {
    const beforeStat = fs.statSync(DB_FILE);
    const beforeMtime = beforeStat.mtimeMs;

    const res = trackingManager.updateLocation({
      orderId: testOrderId,
      riderId: testRiderId,
      latitude: 28.6155,
      longitude: 77.2110,
      socketId: 'sock_101',
      io: mockIo
    });

    assert.strictEqual(res.success, true, 'Location update should succeed');
    const afterStat = fs.statSync(DB_FILE);
    assert.strictEqual(afterStat.mtimeMs, beforeMtime, 'Disk mtime must NOT change on GPS update (zero disk write)');
  });

  // Test 2: In-Memory Storage & Socket Broadcast
  test('2. Live location is stored in RAM riderLocations and broadcast via Socket.IO', () => {
    const loc = trackingManager.getLocation(testOrderId);
    assert.ok(loc, 'Location must exist in RAM');
    assert.strictEqual(loc.latitude, 28.6155);
    assert.strictEqual(loc.longitude, 77.2110);
    assert.strictEqual(loc.status, 'ONLINE');
    assert.strictEqual(loc.isOnline, true);

    const broadcast = mockIo.emittedEvents.find(e => e.room === `order_${testOrderId}` && e.event === 'rider_position');
    assert.ok(broadcast, 'Must broadcast rider_position to order room');
    assert.strictEqual(broadcast.data.latitude, 28.6155);
    assert.strictEqual(broadcast.data.status, 'ONLINE');
  });

  // Test 3: Security & Authorization Check
  test('3. Unauthorized rider attempting to update GPS is rejected', () => {
    const rogueRes = trackingManager.updateLocation({
      orderId: testOrderId,
      riderId: 'ROGUE_RIDER_999',
      latitude: 28.9999,
      longitude: 77.9999,
      socketId: 'sock_hacker',
      io: mockIo
    });

    assert.strictEqual(rogueRes.success, false, 'Rogue rider update must be rejected');
    assert.ok(rogueRes.message.includes('Unauthorized'), 'Error message must specify unauthorized');

    // Confirm coords did not change
    const loc = trackingManager.getLocation(testOrderId);
    assert.strictEqual(loc.latitude, 28.6155, 'Coordinates must remain untouched after unauthorized attempt');
  });

  // Test 4: Stale Detection (>30s without update)
  test('4. Stale location (>30s) automatically triggers SIGNAL_LOST and OFFLINE notification', () => {
    const rawLoc = trackingManager.riderLocations.get(testOrderId);
    assert.ok(rawLoc, 'Raw memory record must exist');

    // Simulate 35 seconds elapsed without update
    rawLoc.updatedAt = Date.now() - 35000;

    mockIo.emittedEvents.length = 0;
    trackingManager.checkStaleLocations(mockIo);

    assert.strictEqual(rawLoc.status, 'SIGNAL_LOST', 'Status must transition to SIGNAL_LOST');
    assert.strictEqual(rawLoc.isOnline, false, 'isOnline must be false');

    const staleBroadcast = mockIo.emittedEvents.find(e => e.event === 'rider_status_change');
    assert.ok(staleBroadcast, 'rider_status_change event must be emitted');
    assert.strictEqual(staleBroadcast.data.status, 'SIGNAL_LOST');

    const pubLoc = trackingManager.getLocation(testOrderId);
    assert.strictEqual(pubLoc.isOnline, false);
    assert.strictEqual(pubLoc.status, 'SIGNAL_LOST');
  });

  // Test 5: Reconnection Resets Stale and Restores Online
  test('5. Fresh ping from rider restores status to ONLINE', () => {
    mockIo.emittedEvents.length = 0;
    const res = trackingManager.updateLocation({
      orderId: testOrderId,
      riderId: testRiderPhone, // match via phone
      latitude: 28.6160,
      longitude: 77.2115,
      socketId: 'sock_102',
      io: mockIo
    });

    assert.strictEqual(res.success, true);
    const pubLoc = trackingManager.getLocation(testOrderId);
    assert.strictEqual(pubLoc.status, 'ONLINE');
    assert.strictEqual(pubLoc.isOnline, true);
    assert.strictEqual(pubLoc.latitude, 28.6160);
  });

  // Test 6: Socket Disconnect with 2.5 min Grace Period
  test('6. Socket disconnect marks DISCONNECTED with active grace period timer', () => {
    mockIo.emittedEvents.length = 0;
    trackingManager.handleSocketDisconnect('sock_102', mockIo);

    const rawLoc = trackingManager.riderLocations.get(testOrderId);
    assert.strictEqual(rawLoc.status, 'DISCONNECTED', 'Status must be DISCONNECTED');
    assert.strictEqual(rawLoc.isOnline, false);
    assert.ok(rawLoc.disconnectTimer, 'Disconnect grace period timer must be active');

    const discEvent = mockIo.emittedEvents.find(e => e.event === 'rider_status_change');
    assert.ok(discEvent, 'Must emit rider_status_change on disconnect');
    assert.strictEqual(discEvent.data.status, 'DISCONNECTED');
    assert.strictEqual(discEvent.data.gracePeriodSeconds, 150);
  });

  // Test 7: Multi-Socket Race Condition Resolution (Requirement 10)
  test('7. Old socket disconnect does NOT kill a newly connected socket session', () => {
    // Rider connects with new socket sock_200
    trackingManager.updateLocation({
      orderId: testOrderId,
      riderId: testRiderId,
      latitude: 28.6165,
      longitude: 77.2120,
      socketId: 'sock_200',
      io: mockIo
    });

    const rawLoc = trackingManager.riderLocations.get(testOrderId);
    assert.strictEqual(rawLoc.status, 'ONLINE');
    assert.strictEqual(rawLoc.socketId, 'sock_200');
    assert.strictEqual(rawLoc.disconnectTimer, null, 'Previous timer must be cancelled on reconnect');

    // Late disconnect from old socket sock_102 fires
    mockIo.emittedEvents.length = 0;
    trackingManager.handleSocketDisconnect('sock_102', mockIo);

    // Ensure status is STILL ONLINE because active socket is sock_200
    assert.strictEqual(rawLoc.status, 'ONLINE', 'Old socket disconnect must be ignored');
    assert.strictEqual(rawLoc.socketId, 'sock_200');
    assert.strictEqual(mockIo.emittedEvents.length, 0, 'No false disconnect event should be broadcast');
  });

  // Test 8: Room Joining & Authorization
  test('8. Client joining order room is authorized and receives immediate fresh state', () => {
    const custSocket = createMockSocket('sock_customer_1');
    trackingManager.authorizeAndJoinOrder(custSocket, {
      orderId: testOrderId,
      userId: testCustomerId,
      role: 'customer'
    }, mockIo);

    assert.ok(custSocket.rooms.has(`order_${testOrderId}`), 'Customer must join order room');
    const posMsg = custSocket.sentMessages.find(m => m.event === 'rider_position');
    assert.ok(posMsg, 'Must immediately push cached location upon join');
    assert.strictEqual(posMsg.data.latitude, 28.6165);
    assert.strictEqual(posMsg.data.isOnline, true);
  });

  // Test 9: Memory Cleanup on Order Delivery / Cancellation
  test('9. Order completion (DELIVERED) clears location from RAM with zero memory leak', () => {
    assert.strictEqual(trackingManager.riderLocations.has(testOrderId), true);
    trackingManager.clearLocation(testOrderId, 'DELIVERED');
    assert.strictEqual(trackingManager.riderLocations.has(testOrderId), false, 'Must be removed from RAM');
    assert.strictEqual(trackingManager.getLocation(testOrderId), null);
  });

  // Test 10: Server Restart Behavior (No stale coords shown as live)
  test('10. Server restart shows CONNECTING until fresh authenticated GPS ping arrives', () => {
    trackingManager.resetForTesting();
    const custSocket = createMockSocket('sock_customer_after_restart');
    trackingManager.authorizeAndJoinOrder(custSocket, {
      orderId: testOrderId,
      userId: testCustomerId,
      role: 'customer'
    }, mockIo);

    const connectingMsg = custSocket.sentMessages.find(m => m.event === 'rider_status_change');
    assert.ok(connectingMsg, 'Must emit CONNECTING status on restart');
    assert.strictEqual(connectingMsg.data.status, 'CONNECTING');
    assert.strictEqual(connectingMsg.data.isOnline, false);
  });

  // Test 11: HTTP REST Fallback Endpoint (Zero Disk Write)
  test('11. HTTP POST /api/orders/rider-location updates RAM without writeDb', () => {
    // Re-active order in DB for test
    const d = readDb();
    const ord = d.orders.find(o => o.orderId === testOrderId);
    ord.orderStatus = 'ON_THE_WAY';

    const beforeStat = fs.statSync(DB_FILE);
    const beforeMtime = beforeStat.mtimeMs;

    let resBody = null;
    let resStatus = 200;
    const req = {
      body: {
        orderId: testOrderId,
        riderUserId: testRiderUserId,
        latitude: 28.6180,
        longitude: 77.2135
      },
      io: mockIo
    };
    const res = {
      status(code) { resStatus = code; return this; },
      json(data) { resBody = data; return this; }
    };

    orderController.updateRiderLocation(req, res);

    assert.strictEqual(resStatus, 200);
    assert.strictEqual(resBody.success, true);
    assert.ok(resBody.message.includes('RAM'), 'Must confirm RAM update');

    const afterStat = fs.statSync(DB_FILE);
    assert.strictEqual(afterStat.mtimeMs, beforeMtime, 'REST GPS update must NOT write to disk');

    const memLoc = trackingManager.getLocation(testOrderId);
    assert.strictEqual(memLoc.latitude, 28.6180);
    assert.strictEqual(memLoc.status, 'ONLINE');
  });

  // Clean up test order
  const cleanupDb = readDb();
  const idx = cleanupDb.orders.findIndex(o => o.orderId === testOrderId);
  if (idx !== -1) {
    cleanupDb.orders.splice(idx, 1);
    writeDb(cleanupDb);
  }
  trackingManager.resetForTesting();

  console.log(`\n========================================`);
  console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
