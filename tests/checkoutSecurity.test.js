const crypto = require('crypto');
const path = require('path');
const { readDb, writeDb } = require('../src/models/db');
const razorpay = require('../src/config/razorpay');
const paymentController = require('../src/controllers/paymentController');
const orderController = require('../src/controllers/orderController');

// Helper to simulate express req/res
function mockReqRes(body = {}, headers = {}) {
  const req = {
    body,
    headers,
    params: {},
    query: {},
    io: { emit: () => {} }
  };
  let statusCode = 200;
  let responseData = null;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    },
    getStatusCode: () => statusCode,
    getResponse: () => responseData
  };

  return { req, res };
}

async function runTests() {
  console.log('====================================================');
  console.log('  INDFOOD CHECKOUT SECURITY & FINGERPRINT TEST SUITE');
  console.log('====================================================\n');

  const db = readDb();
  const testRest = db.restaurants[0] || {
    id: 'rest_test_sec_1',
    name: 'Security Test Kitchen',
    latitude: '22.7196',
    longitude: '75.8577',
    commissionPercent: 15,
    menu: [
      { id: 'dish_1', name: 'Paneer Butter Masala', price: 200 },
      { id: 'dish_2', name: 'Dal Tadka', price: 150 },
      { id: 'dish_3', name: 'Biryani Special', price: 250 }
    ]
  };
  if (!db.restaurants.find(r => r.id === testRest.id)) {
    db.restaurants.push(testRest);
  }

  // Ensure test restaurant has menu items for price validation
  if (!testRest.menu || testRest.menu.length === 0) {
    testRest.menu = [
      { id: 'dish_1', name: 'Paneer Butter Masala', price: 200 },
      { id: 'dish_2', name: 'Dal Tadka', price: 150 },
      { id: 'dish_3', name: 'Biryani Special', price: 250 }
    ];
  }

  // Second restaurant for restaurant-mismatch test
  const testRest2 = {
    id: 'rest_test_sec_2',
    name: 'Second Test Kitchen',
    latitude: '22.7200',
    longitude: '75.8600',
    commissionPercent: 15,
    menu: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200 }]
  };
  if (!db.restaurants.find(r => r.id === testRest2.id)) {
    db.restaurants.push(testRest2);
  }
  writeDb(db);

  const keySecret = process.env.RAZORPAY_KEY_SECRET || 'test_secret_key_mock_123';
  let passedTests = 0;
  let totalTests = 0;

  function assert(title, condition, detail) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`[PASS] ${title}`);
      if (detail) console.log(`       Evidence: ${detail}`);
    } else {
      console.log(`[FAIL] ${title}`);
      if (detail) console.log(`       Evidence: ${detail}`);
    }
  }

  // =========================================================================
  // GROUP 1: IDEMPOTENCY & SHA-256 PAYLOAD FINGERPRINT TESTS (9 TESTS)
  // =========================================================================
  console.log('--- TEST GROUP 1: IDEMPOTENCY PAYLOAD FINGERPRINT & CONFLICT RULES ---');

  const baseKey = 'idem_fp_test_' + Date.now();
  const basePayload = {
    idempotencyKey: baseKey,
    customerId: 'cust_fp_user',
    customerName: 'Fingerprint Test User',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 2 }],
    deliveryAddress: '101, Test Street, Indore',
    paymentMethod: 'ONLINE'
  };

  // TEST 1.1: Initial Creation & Same Key + Same Payload = Replay PASS
  const { req: req1, res: res1 } = mockReqRes({ ...basePayload });
  await orderController.createOrder(req1, res1);
  const createdOrder = res1.getResponse().order;

  const { req: reqReplay, res: resReplay } = mockReqRes({ ...basePayload });
  await orderController.createOrder(reqReplay, resReplay);
  const replayBody = resReplay.getResponse();

  assert(
    '1. Same Key + Same Payload = Replay PASS',
    resReplay.getStatusCode() === 200 &&
    replayBody.isIdempotentReplay === true &&
    replayBody.order.orderId === createdOrder.orderId,
    `Status: ${resReplay.getStatusCode()}, isIdempotentReplay: ${replayBody.isIdempotentReplay}, Order ID: ${replayBody.order?.orderId}`
  );

  // TEST 1.2: Same Key + Changed Quantity = 409 Conflict
  const payloadChangedQty = {
    ...basePayload,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 5 }] // Changed from 2 to 5
  };
  const { req: reqChgQty, res: resChgQty } = mockReqRes(payloadChangedQty);
  await orderController.createOrder(reqChgQty, resChgQty);
  assert(
    '2. Same Key + Changed Quantity = 409 Conflict',
    resChgQty.getStatusCode() === 409 && resChgQty.getResponse().message.includes('Idempotency conflict'),
    `Status: ${resChgQty.getStatusCode()}, Message: ${resChgQty.getResponse()?.message}`
  );

  // TEST 1.3: Same Key + Changed Dish = 409 Conflict
  const payloadChangedDish = {
    ...basePayload,
    items: [{ id: 'dish_2', name: 'Dal Tadka', price: 150, quantity: 2 }] // Changed from dish_1 to dish_2
  };
  const { req: reqChgDish, res: resChgDish } = mockReqRes(payloadChangedDish);
  await orderController.createOrder(reqChgDish, resChgDish);
  assert(
    '3. Same Key + Changed Dish = 409 Conflict',
    resChgDish.getStatusCode() === 409 && resChgDish.getResponse().message.includes('Idempotency conflict'),
    `Status: ${resChgDish.getStatusCode()}, Message: ${resChgDish.getResponse()?.message}`
  );

  // TEST 1.4: Same Key + Changed Restaurant = 409 Conflict
  const payloadChangedRest = {
    ...basePayload,
    restaurantId: testRest2.id // Changed restaurant
  };
  const { req: reqChgRest, res: resChgRest } = mockReqRes(payloadChangedRest);
  await orderController.createOrder(reqChgRest, resChgRest);
  assert(
    '4. Same Key + Changed Restaurant = 409 Conflict',
    resChgRest.getStatusCode() === 409 && resChgRest.getResponse().message.includes('Idempotency conflict'),
    `Status: ${resChgRest.getStatusCode()}, Message: ${resChgRest.getResponse()?.message}`
  );

  // TEST 1.5: Different Key + Different Payload = New Order PASS
  const diffKey = 'idem_diff_new_' + Date.now();
  const diffPayload = {
    idempotencyKey: diffKey,
    customerId: 'cust_fp_user',
    customerName: 'Fingerprint Test User',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_3', name: 'Biryani Special', price: 250, quantity: 1 }],
    deliveryAddress: '202, New Road, Indore',
    paymentMethod: 'ONLINE'
  };
  const { req: reqDiff, res: resDiff } = mockReqRes(diffPayload);
  await orderController.createOrder(reqDiff, resDiff);
  const diffOrder = resDiff.getResponse().order;
  assert(
    '5. Different Key + Different Payload = New Order PASS',
    resDiff.getStatusCode() === 200 && diffOrder && diffOrder.orderId !== createdOrder.orderId,
    `Status: ${resDiff.getStatusCode()}, New Order ID: ${diffOrder?.orderId}`
  );

  // TEST 1.6: Parallel Same Key + Same Payload = Only One Order
  const parallelSameKey = 'idem_parallel_same_' + Date.now();
  const parallelSamePayload = {
    idempotencyKey: parallelSameKey,
    customerId: 'cust_parallel_user',
    customerName: 'Parallel Same User',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
    paymentMethod: 'ONLINE'
  };
  const { req: reqParSame1, res: resParSame1 } = mockReqRes({ ...parallelSamePayload });
  const { req: reqParSame2, res: resParSame2 } = mockReqRes({ ...parallelSamePayload });

  const [pSameRes1, pSameRes2] = await Promise.all([
    new Promise(r => orderController.createOrder(reqParSame1, resParSame1).then(() => r({ code: resParSame1.getStatusCode(), body: resParSame1.getResponse() }))),
    new Promise(r => orderController.createOrder(reqParSame2, resParSame2).then(() => r({ code: resParSame2.getStatusCode(), body: resParSame2.getResponse() })))
  ]);

  const allOrdersSame = readDb().orders.filter(o => o.idempotencyKey === parallelSameKey);
  assert(
    '6. Parallel Same Key + Same Payload = Only One Order',
    allOrdersSame.length === 1 && pSameRes1.code === 200 && pSameRes2.code === 200 && pSameRes1.body.order.orderId === pSameRes2.body.order.orderId,
    `Orders in DB: ${allOrdersSame.length}, Order ID: ${pSameRes1.body?.order?.orderId}, Concurrent replay: ${pSameRes2.body?.isIdempotentReplay}`
  );

  // TEST 1.7: Parallel Same Key + Different Payload = Conflict
  const parallelDiffKey = 'idem_parallel_diff_' + Date.now();
  const parDiffPayloadA = {
    idempotencyKey: parallelDiffKey,
    customerId: 'cust_par_diff',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
    paymentMethod: 'ONLINE'
  };
  const parDiffPayloadB = {
    idempotencyKey: parallelDiffKey,
    customerId: 'cust_par_diff',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_2', name: 'Dal Tadka', price: 150, quantity: 3 }], // Completely different dish and qty!
    paymentMethod: 'ONLINE'
  };
  const { req: reqParDiffA, res: resParDiffA } = mockReqRes(parDiffPayloadA);
  const { req: reqParDiffB, res: resParDiffB } = mockReqRes(parDiffPayloadB);

  const [pDiffResA, pDiffResB] = await Promise.all([
    new Promise(r => orderController.createOrder(reqParDiffA, resParDiffA).then(() => r({ code: resParDiffA.getStatusCode(), body: resParDiffA.getResponse() }))),
    new Promise(r => orderController.createOrder(reqParDiffB, resParDiffB).then(() => r({ code: resParDiffB.getStatusCode(), body: resParDiffB.getResponse() })))
  ]);

  const allOrdersDiff = readDb().orders.filter(o => o.idempotencyKey === parallelDiffKey);
  const hasConflict = (pDiffResA.code === 409 || pDiffResB.code === 409);
  const hasSuccess = (pDiffResA.code === 200 || pDiffResB.code === 200);

  assert(
    '7. Parallel Same Key + Different Payload = Conflict',
    allOrdersDiff.length === 1 && hasConflict && hasSuccess,
    `Orders in DB: ${allOrdersDiff.length}, ResA code: ${pDiffResA.code}, ResB code: ${pDiffResB.code}`
  );

  // TEST 1.8: Server Restart + Same Key + Same Payload = Replay
  // Simulate complete server restart: verify payloadFingerprint exists on disk in database.json
  const currentDbReload = readDb();
  const persistedOrder = currentDbReload.orders.find(o => o.idempotencyKey === baseKey);
  const hasPersistedFingerprint = Boolean(persistedOrder && persistedOrder.payloadFingerprint);

  const { req: reqRestart, res: resRestart } = mockReqRes({ ...basePayload });
  await orderController.createOrder(reqRestart, resRestart);
  const restartResBody = resRestart.getResponse();

  assert(
    '8. Server Restart + Same Key + Same Payload = Replay',
    hasPersistedFingerprint && resRestart.getStatusCode() === 200 && restartResBody.isIdempotentReplay === true && restartResBody.order.orderId === createdOrder.orderId,
    `Persisted Fingerprint: ${persistedOrder?.payloadFingerprint?.slice(0, 16)}..., Replay Status: ${resRestart.getStatusCode()}`
  );

  // TEST 1.9: Existing Orders Without Fingerprint = Safe Backward Compatibility
  const legacyKey = 'idem_legacy_no_fp_' + Date.now();
  const legacyOrder = {
    orderId: 'ORD-LEGACY-001',
    idempotencyKey: legacyKey,
    customerId: 'cust_legacy',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
    deliveryAddress: 'Old Colony, Indore',
    paymentMethod: 'ONLINE',
    paymentStatus: 'PAYMENT_PENDING',
    orderStatus: 'PENDING_PAYMENT',
    financials: { customerTotalPaid: 200 }
    // Note: payloadFingerprint is intentionally missing!
  };
  const dbBeforeLegacy = readDb();
  dbBeforeLegacy.orders.push(legacyOrder);
  writeDb(dbBeforeLegacy);

  // 1.9a: Replaying identical legacy payload succeeds and safely backfills fingerprint
  const legacyPayloadSame = {
    idempotencyKey: legacyKey,
    customerId: 'cust_legacy',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
    deliveryAddress: 'Old Colony, Indore',
    paymentMethod: 'ONLINE'
  };
  const { req: reqLegSame, res: resLegSame } = mockReqRes(legacyPayloadSame);
  await orderController.createOrder(reqLegSame, resLegSame);

  // 1.9b: Replaying modified payload against legacy order returns 409 Conflict
  const legacyPayloadDiff = {
    idempotencyKey: legacyKey,
    customerId: 'cust_legacy',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 10 }], // Modified quantity!
    deliveryAddress: 'Old Colony, Indore',
    paymentMethod: 'ONLINE'
  };
  const { req: reqLegDiff, res: resLegDiff } = mockReqRes(legacyPayloadDiff);
  await orderController.createOrder(reqLegDiff, resLegDiff);

  const orderAfterBackfill = readDb().orders.find(o => o.orderId === 'ORD-LEGACY-001');

  assert(
    '9. Existing Orders Without Fingerprint = Safe Backward Compatibility',
    resLegSame.getStatusCode() === 200 &&
    resLegSame.getResponse().isIdempotentReplay === true &&
    resLegDiff.getStatusCode() === 409 &&
    Boolean(orderAfterBackfill && orderAfterBackfill.payloadFingerprint),
    `Same status: ${resLegSame.getStatusCode()}, Diff status: ${resLegDiff.getStatusCode()} (409 Conflict), Backfilled: ${Boolean(orderAfterBackfill?.payloadFingerprint)}`
  );

  // =========================================================================
  // GROUP 2: RAZORPAY SECURITY REGRESSION TESTS (9 TESTS)
  // =========================================================================
  console.log('\n--- TEST GROUP 2: RAZORPAY VERIFICATION SECURITY REGRESSION ---');

  // Create an order specifically for Razorpay verification tests
  const testSecOrderKey = 'idem_sec_rzp_' + Date.now();
  const { req: reqSec, res: resSec } = mockReqRes({
    idempotencyKey: testSecOrderKey,
    customerId: 'cust_sec_rzp',
    customerName: 'Sec User',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
    paymentMethod: 'ONLINE'
  });
  await orderController.createOrder(reqSec, resSec);
  const secOrder = resSec.getResponse().order;
  const rzpOrderId = secOrder.razorpayOrderId;

  // TEST 2.1: Invalid signature rejection
  const { req: reqBadSig, res: resBadSig } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: 'pay_test_fake_123',
    razorpay_signature: 'invalid_fraudulent_signature_hex_000000000000'
  });
  await paymentController.verifyPayment(reqBadSig, resBadSig);

  assert(
    '10. Invalid HMAC signature is rejected with 400 Fraud Warning',
    resBadSig.getStatusCode() === 400 && resBadSig.getResponse().message.includes('Invalid payment signature'),
    `Status: ${resBadSig.getStatusCode()}, Message: ${resBadSig.getResponse()?.message}`
  );

  // TEST 2.2: Incorrect Razorpay Order ID
  const mismatchedRzpOrderId = 'order_wrong_fake_9999';
  const fakePaymentId = 'pay_test_mismatch_123';
  const sigForMismatch = crypto
    .createHmac('sha256', keySecret)
    .update(mismatchedRzpOrderId + '|' + fakePaymentId)
    .digest('hex');

  const { req: reqMismatchOrder, res: resMismatchOrder } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: mismatchedRzpOrderId,
    razorpay_payment_id: fakePaymentId,
    razorpay_signature: sigForMismatch
  });
  await paymentController.verifyPayment(reqMismatchOrder, resMismatchOrder);

  assert(
    '11. Mismatched Razorpay Order ID is strictly rejected with 400',
    resMismatchOrder.getStatusCode() === 400 && resMismatchOrder.getResponse().message.includes('Razorpay Order ID mismatch'),
    `Status: ${resMismatchOrder.getStatusCode()}, Message: ${resMismatchOrder.getResponse()?.message}`
  );

  // TEST 2.3: Repeated Payment ID (Legitimate Idempotent verification)
  const currentDb = readDb();
  const dbOrder = currentDb.orders.find(o => o.orderId === secOrder.orderId);
  dbOrder.paymentStatus = 'PAID';
  dbOrder.orderStatus = 'PLACED';
  dbOrder.razorpayPaymentId = 'pay_already_paid_12345';
  writeDb(currentDb);

  const sigForPaid = crypto
    .createHmac('sha256', keySecret)
    .update(rzpOrderId + '|' + 'pay_already_paid_12345')
    .digest('hex');

  const { req: reqRepeat, res: resRepeat } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: 'pay_already_paid_12345',
    razorpay_signature: sigForPaid
  });
  await paymentController.verifyPayment(reqRepeat, resRepeat);

  assert(
    '12. Repeated Payment ID on paid order returns idempotent 200 OK without re-charging or failing',
    resRepeat.getStatusCode() === 200 && resRepeat.getResponse().isDuplicate === true,
    `Status: ${resRepeat.getStatusCode()}, isDuplicate: ${resRepeat.getResponse()?.isDuplicate}`
  );

  // TEST 2.4: Conflicting Payment ID on already-paid order (Replay Attack)
  const conflictingPaymentId = 'pay_conflicting_replay_999';
  const sigForConflict = crypto
    .createHmac('sha256', keySecret)
    .update(rzpOrderId + '|' + conflictingPaymentId)
    .digest('hex');

  const { req: reqConflict, res: resConflict } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: conflictingPaymentId,
    razorpay_signature: sigForConflict
  });
  await paymentController.verifyPayment(reqConflict, resConflict);

  assert(
    '13. Conflicting Payment ID on already-paid order is rejected with 409 Conflict',
    resConflict.getStatusCode() === 409,
    `Status: ${resConflict.getStatusCode()}, Message: ${resConflict.getResponse()?.message}`
  );

  // TEST 2.5: Incorrect payment amount (Simulated / Mocked Razorpay API)
  const originalFetch = razorpay.payments.fetch;
  const mockPayId = 'pay_valid_mock_123';
  const validSig = crypto
    .createHmac('sha256', keySecret)
    .update(rzpOrderId + '|' + mockPayId)
    .digest('hex');

  // Reset order paymentStatus to PAYMENT_PENDING
  const dbReset = readDb();
  const resetOrder = dbReset.orders.find(o => o.orderId === secOrder.orderId);
  resetOrder.paymentStatus = 'PAYMENT_PENDING';
  resetOrder.razorpayPaymentId = null;
  writeDb(dbReset);

  razorpay.payments.fetch = async (id) => ({
    id: mockPayId,
    order_id: rzpOrderId,
    amount: 100, // Rs 1 instead of actual amount
    currency: 'INR',
    status: 'captured'
  });

  const { req: reqBadAmount, res: resBadAmount } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: mockPayId,
    razorpay_signature: validSig
  });
  await paymentController.verifyPayment(reqBadAmount, resBadAmount);

  assert(
    '14. Incorrect payment amount is strictly rejected with 400',
    resBadAmount.getStatusCode() === 400 && resBadAmount.getResponse().message.includes('Payment amount mismatch'),
    `Status: ${resBadAmount.getStatusCode()}, Message: ${resBadAmount.getResponse()?.message}`
  );

  // TEST 2.6: Correct Razorpay payment verification
  const expectedAmountPaise = Math.round(secOrder.financials.customerTotalPaid * 100);
  razorpay.payments.fetch = async (id) => ({
    id: mockPayId,
    order_id: rzpOrderId,
    amount: expectedAmountPaise,
    currency: 'INR',
    status: 'captured'
  });

  const { req: reqValidPay, res: resValidPay } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: mockPayId,
    razorpay_signature: validSig
  });
  await paymentController.verifyPayment(reqValidPay, resValidPay);

  const orderAfterValidPay = readDb().orders.find(o => o.orderId === secOrder.orderId);

  assert(
    '15. Valid Razorpay payment with matching amount, order_id, currency and captured status marks order PAID',
    resValidPay.getStatusCode() === 200 && orderAfterValidPay.paymentStatus === 'PAID' && orderAfterValidPay.orderStatus === 'PLACED',
    `Status: ${resValidPay.getStatusCode()}, Order Payment Status: ${orderAfterValidPay?.paymentStatus}, Order Status: ${orderAfterValidPay?.orderStatus}`
  );

  // TEST 2.7: Payment currency mismatch (EUR instead of INR)
  const dbResetCurr = readDb();
  const resetOrderCurr = dbResetCurr.orders.find(o => o.orderId === secOrder.orderId);
  resetOrderCurr.paymentStatus = 'PAYMENT_PENDING';
  resetOrderCurr.razorpayPaymentId = null;
  writeDb(dbResetCurr);

  razorpay.payments.fetch = async (id) => ({
    id: mockPayId,
    order_id: rzpOrderId,
    amount: expectedAmountPaise,
    currency: 'USD',
    status: 'captured'
  });
  const { req: reqBadCurr, res: resBadCurr } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: mockPayId,
    razorpay_signature: validSig
  });
  await paymentController.verifyPayment(reqBadCurr, resBadCurr);

  assert(
    '16. Payment currency mismatch (non-INR) is strictly rejected with 400',
    resBadCurr.getStatusCode() === 400 && resBadCurr.getResponse().message.includes('Payment currency mismatch'),
    `Status: ${resBadCurr.getStatusCode()}, Message: ${resBadCurr.getResponse()?.message}`
  );

  // TEST 2.8: Uncaptured payment status rejection
  razorpay.payments.fetch = async (id) => ({
    id: mockPayId,
    order_id: rzpOrderId,
    amount: expectedAmountPaise,
    currency: 'INR',
    status: 'authorized' // Authorized but not captured
  });
  const { req: reqUncap, res: resUncap } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: mockPayId,
    razorpay_signature: validSig
  });
  await paymentController.verifyPayment(reqUncap, resUncap);

  assert(
    '17. Uncaptured payment status is rejected with 400 before marking order PAID',
    resUncap.getStatusCode() === 400 && resUncap.getResponse().message.includes('Payment is not in captured status'),
    `Status: ${resUncap.getStatusCode()}, Message: ${resUncap.getResponse()?.message}`
  );

  // TEST 2.9: Non-existent order verification rejection
  const { req: reqNoOrder, res: resNoOrder } = mockReqRes({
    orderId: 'ORD-NON-EXISTENT-999',
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: mockPayId,
    razorpay_signature: validSig
  });
  await paymentController.verifyPayment(reqNoOrder, resNoOrder);

  assert(
    '18. Payment verification for non-existent order returns 404',
    resNoOrder.getStatusCode() === 404,
    `Status: ${resNoOrder.getStatusCode()}, Message: ${resNoOrder.getResponse()?.message}`
  );

  // Restore razorpay.payments.fetch
  razorpay.payments.fetch = originalFetch;

  // Clean up test orders from DB to preserve clean DB state
  const finalDb = readDb();
  finalDb.orders = finalDb.orders.filter(o => 
    o.idempotencyKey !== baseKey && 
    o.idempotencyKey !== diffKey && 
    o.idempotencyKey !== parallelSameKey && 
    o.idempotencyKey !== parallelDiffKey && 
    o.idempotencyKey !== legacyKey &&
    o.idempotencyKey !== testSecOrderKey &&
    o.orderId !== 'ORD-LEGACY-001'
  );
  writeDb(finalDb);

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
});
