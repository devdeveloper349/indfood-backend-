const crypto = require('crypto');
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
  console.log('  INDFOOD CHECKOUT SECURITY & IDEMPOTENCY TEST SUITE');
  console.log('====================================================\n');

  const db = readDb();
  const testRest = db.restaurants[0] || {
    id: 'rest_test_sec_1',
    name: 'Security Test Kitchen',
    latitude: '22.7196',
    longitude: '75.8577',
    commissionPercent: 15
  };
  if (!db.restaurants.find(r => r.id === testRest.id)) {
    db.restaurants.push(testRest);
    writeDb(db);
  }

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

  // -----------------------------------------------------------
  // TEST 1: Two parallel requests with the same Idempotency Key
  // -----------------------------------------------------------
  console.log('--- TEST GROUP 1: IDEMPOTENCY & CONCURRENCY ---');
  const sharedKey = 'idem_parallel_test_' + Date.now();
  const payload1 = {
    idempotencyKey: sharedKey,
    customerId: 'cust_parallel',
    customerName: 'Parallel Test User',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
    paymentMethod: 'ONLINE'
  };

  const dbOrdersCountBefore = db.orders.length;

  const { req: reqA, res: resA } = mockReqRes({ ...payload1 });
  const { req: reqB, res: resB } = mockReqRes({ ...payload1 });

  // Fire both concurrently
  const [resA_val, resB_val] = await Promise.all([
    new Promise(resolve => {
      orderController.createOrder(reqA, resA).then(() => resolve({
        code: resA.getStatusCode(),
        body: resA.getResponse()
      }));
    }),
    new Promise(resolve => {
      orderController.createOrder(reqB, resB).then(() => resolve({
        code: resB.getStatusCode(),
        body: resB.getResponse()
      }));
    })
  ]);

  const dbOrdersAfterParallel = readDb().orders;
  const ordersMatchingKey = dbOrdersAfterParallel.filter(o => o.idempotencyKey === sharedKey);

  assert(
    'Two parallel requests with same Idempotency Key create only ONE order',
    ordersMatchingKey.length === 1 && resA_val.code === 200 && resB_val.code === 200 &&
    resA_val.body.order.orderId === resB_val.body.order.orderId,
    `Matching orders in DB: ${ordersMatchingKey.length}, Order ID: ${resA_val.body?.order?.orderId}, Concurrent replay returned: ${resB_val.body?.isIdempotentReplay}`
  );

  // -----------------------------------------------------------
  // TEST 2: Network retry after order creation
  // -----------------------------------------------------------
  const retryKey = 'idem_retry_test_' + Date.now();
  const retryPayload = {
    idempotencyKey: retryKey,
    customerId: 'cust_retry',
    customerName: 'Retry User',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_2', name: 'Dal Tadka', price: 150, quantity: 1 }],
    paymentMethod: 'ONLINE'
  };

  const { req: reqOrig, res: resOrig } = mockReqRes({ ...retryPayload });
  await orderController.createOrder(reqOrig, resOrig);
  const origOrder = resOrig.getResponse().order;

  // Simulate network retry with identical key
  const { req: reqRetry, res: resRetry } = mockReqRes({ ...retryPayload });
  await orderController.createOrder(reqRetry, resRetry);
  const retryRes = resRetry.getResponse();

  assert(
    'Network retry after order creation returns existing order without creating duplicate',
    resRetry.getStatusCode() === 200 &&
    retryRes.isIdempotentReplay === true &&
    retryRes.order.orderId === origOrder.orderId,
    `Status: ${resRetry.getStatusCode()}, isIdempotentReplay: ${retryRes.isIdempotentReplay}, Same Order ID: ${retryRes.order?.orderId === origOrder.orderId}`
  );

  // -----------------------------------------------------------
  // TEST 3: Two different keys create legitimate separate orders
  // -----------------------------------------------------------
  const keyA = 'idem_diff_A_' + Date.now();
  const keyB = 'idem_diff_B_' + Date.now();

  const { req: reqDiffA, res: resDiffA } = mockReqRes({ ...payload1, idempotencyKey: keyA });
  const { req: reqDiffB, res: resDiffB } = mockReqRes({ ...payload1, idempotencyKey: keyB });

  await orderController.createOrder(reqDiffA, resDiffA);
  await orderController.createOrder(reqDiffB, resDiffB);

  const orderA = resDiffA.getResponse().order;
  const orderB = resDiffB.getResponse().order;

  assert(
    'Two different keys for legitimate separate orders both succeed independently',
    orderA && orderB && orderA.orderId !== orderB.orderId,
    `Order A: ${orderA?.orderId}, Order B: ${orderB?.orderId} (distinct orders)`
  );

  console.log('\n--- TEST GROUP 2: RAZORPAY VERIFICATION SECURITY ---');

  // Create an order specifically for Razorpay verification tests
  const testSecOrderKey = 'idem_sec_order_' + Date.now();
  const { req: reqSec, res: resSec } = mockReqRes({
    idempotencyKey: testSecOrderKey,
    customerId: 'cust_sec',
    customerName: 'Sec User',
    customerPhone: '9876543210',
    restaurantId: testRest.id,
    items: [{ id: 'dish_sec', name: 'Biryani', price: 250, quantity: 1 }],
    paymentMethod: 'ONLINE'
  });
  await orderController.createOrder(reqSec, resSec);
  const secOrder = resSec.getResponse().order;
  const rzpOrderId = secOrder.razorpayOrderId;

  // -----------------------------------------------------------
  // TEST 4: Invalid signature rejection
  // -----------------------------------------------------------
  const { req: reqBadSig, res: resBadSig } = mockReqRes({
    orderId: secOrder.orderId,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: 'pay_test_fake_123',
    razorpay_signature: 'invalid_fraudulent_signature_hex_000000000000'
  });
  await paymentController.verifyPayment(reqBadSig, resBadSig);

  assert(
    'Invalid HMAC signature is rejected with 400 Fraud Warning',
    resBadSig.getStatusCode() === 400 && resBadSig.getResponse().message.includes('Invalid payment signature'),
    `Status: ${resBadSig.getStatusCode()}, Message: ${resBadSig.getResponse()?.message}`
  );

  // -----------------------------------------------------------
  // TEST 5: Incorrect Razorpay Order ID
  // -----------------------------------------------------------
  // Generate valid HMAC signature for mismatched order id
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
    'Mismatched Razorpay Order ID is strictly rejected with 400',
    resMismatchOrder.getStatusCode() === 400 && resMismatchOrder.getResponse().message.includes('Razorpay Order ID mismatch'),
    `Status: ${resMismatchOrder.getStatusCode()}, Message: ${resMismatchOrder.getResponse()?.message}`
  );

  // -----------------------------------------------------------
  // TEST 6: Repeated Payment ID (Legitimate Idempotent verification)
  // -----------------------------------------------------------
  // Set the order as already paid in DB
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
    'Repeated Payment ID on paid order returns idempotent 200 OK without re-charging or failing',
    resRepeat.getStatusCode() === 200 && resRepeat.getResponse().isDuplicate === true,
    `Status: ${resRepeat.getStatusCode()}, isDuplicate: ${resRepeat.getResponse()?.isDuplicate}`
  );

  // -----------------------------------------------------------
  // TEST 7: Conflicting Payment ID on already-paid order (Replay Attack)
  // -----------------------------------------------------------
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
    'Conflicting Payment ID on already-paid order is rejected with 409 Conflict',
    resConflict.getStatusCode() === 409,
    `Status: ${resConflict.getStatusCode()}, Message: ${resConflict.getResponse()?.message}`
  );

  // -----------------------------------------------------------
  // TEST 8: Incorrect payment amount (Simulated / Mocked Razorpay API)
  // -----------------------------------------------------------
  // We mock razorpay.payments.fetch temporarily to return a payment with wrong amount
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

  // Mock returning wrong amount (e.g. 100 paise = Rs 1 instead of actual amount)
  razorpay.payments.fetch = async (id) => ({
    id: mockPayId,
    order_id: rzpOrderId,
    amount: 100, // Rs 1
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
    'Incorrect payment amount is strictly rejected with 400',
    resBadAmount.getStatusCode() === 400 && resBadAmount.getResponse().message.includes('Payment amount mismatch'),
    `Status: ${resBadAmount.getStatusCode()}, Message: ${resBadAmount.getResponse()?.message}`
  );

  // -----------------------------------------------------------
  // TEST 9: Correct Razorpay payment verification (with captured status & correct amount)
  // -----------------------------------------------------------
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
    'Valid Razorpay payment with matching amount, order_id, currency and captured status marks order PAID',
    resValidPay.getStatusCode() === 200 && orderAfterValidPay.paymentStatus === 'PAID' && orderAfterValidPay.orderStatus === 'PLACED',
    `Status: ${resValidPay.getStatusCode()}, Order Payment Status: ${orderAfterValidPay?.paymentStatus}, Order Status: ${orderAfterValidPay?.orderStatus}`
  );

  // Restore razorpay.payments.fetch
  razorpay.payments.fetch = originalFetch;

  // Clean up test orders from DB to preserve clean DB state
  const finalDb = readDb();
  finalDb.orders = finalDb.orders.filter(o => 
    o.idempotencyKey !== sharedKey && 
    o.idempotencyKey !== retryKey && 
    o.idempotencyKey !== keyA && 
    o.idempotencyKey !== keyB && 
    o.idempotencyKey !== testSecOrderKey
  );
  writeDb(finalDb);

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
});
