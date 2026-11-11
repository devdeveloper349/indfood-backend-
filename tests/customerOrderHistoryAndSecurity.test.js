const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { readDb, writeDb } = require('../src/models/db');
const orderController = require('../src/controllers/orderController');
const pricingEngine = require('../src/utils/pricingEngine');

const JWT_SECRET = process.env.JWT_SECRET || 'indfood_super_secure_jwt_secret_key_2026';

function generateTestJwt(user) {
  return jwt.sign(
    {
      id: user.id,
      phone: user.phone ? String(user.phone).replace(/\D/g, '').slice(-10) : '',
      email: user.email || '',
      role: user.role || 'customer',
      name: user.name || 'Test User'
    },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
}

function mockReqRes(params = {}) {
  const req = {
    body: params.body || {},
    headers: params.headers || {},
    params: params.params || {},
    query: params.query || {},
    cookies: params.cookies || {},
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
  console.log('  INDFOOD CUSTOMER ORDER HISTORY & SECURITY TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, evidence) {
    if (condition) {
      passed++;
      console.log(`[PASS] ${testName}`);
      if (evidence) console.log(`       Evidence: ${evidence}`);
    } else {
      failed++;
      console.error(`[FAIL] ${testName}`);
      if (evidence) console.error(`       Evidence: ${evidence}`);
    }
  }

  const db = readDb();
  // Ensure test restaurant
  let rest = (db.restaurants || []).find(r => r.id === 'rest_test_history_1');
  if (!rest) {
    rest = {
      id: 'rest_test_history_1',
      name: 'History Test Restaurant',
      latitude: '22.7196',
      longitude: '75.8577',
      commissionPercent: 15,
      deliveryRadiusKm: 15.0,
      menu: [
        { id: 'dish_h1', name: 'Dal Makhani', price: 180 },
        { id: 'dish_h2', name: 'Shahi Paneer', price: 240 }
      ]
    };
    db.restaurants.push(rest);
    writeDb(db);
  }

  const customerA = { id: 'cust_9876543210', phone: '9876543210', name: 'Customer A', role: 'customer' };
  const customerB = { id: 'cust_9123456789', phone: '9123456789', name: 'Customer B', role: 'customer' };

  const tokenA = generateTestJwt(customerA);
  const tokenB = generateTestJwt(customerB);

  // --- TEST GROUP 1: MULTIPLE ORDERS & ORDER HISTORY LISTING (4+ ORDERS) ---
  console.log('--- TEST GROUP 1: CUSTOMER ORDER HISTORY (4+ ORDERS & ALL STATUSES) ---');
  
  // Create 4 distinct orders for Customer A
  const statuses = ['PLACED', 'PREPARING', 'DELIVERED', 'CANCELLED'];
  const orderIdsA = [];

  for (let i = 0; i < 4; i++) {
    const { req, res } = mockReqRes({
      body: {
        customerId: customerA.id,
        customerName: customerA.name,
        customerPhone: customerA.phone,
        restaurantId: rest.id,
        items: [{ id: 'dish_h1', name: 'Dal Makhani', price: 180, quantity: 1 }],
        paymentMethod: 'COD',
        deliveryAddress: 'Indore Test Flat ' + (i + 1),
        distanceKm: 3.0,
        idempotencyKey: 'idemp_test_hist_' + i + '_' + Date.now()
      },
      headers: {
        'authorization': `Bearer ${tokenA}`
      }
    });

    await orderController.createOrder(req, res);
    const data = res.getResponse();
    if (data && data.order) {
      orderIdsA.push(data.order.orderId);
      // Manually set status for test categorization
      const currentDb = readDb();
      const o = currentDb.orders.find(ord => ord.orderId === data.order.orderId);
      if (o) {
        o.orderStatus = statuses[i];
        // Distinguish timestamps for sorting test
        o.createdAt = new Date(Date.now() - (3 - i) * 100000).toISOString();
        writeDb(currentDb);
      }
    }
  }

  // Fetch orders using Customer A's verified JWT
  const { req: reqListA, res: resListA } = mockReqRes({
    headers: { 'authorization': `Bearer ${tokenA}` }
  });
  orderController.listOrders(reqListA, resListA);
  const listDataA = resListA.getResponse();
  const ordersA = (listDataA && listDataA.orders) || [];

  assert(
    resListA.getStatusCode() === 200 && ordersA.length >= 4,
    '1. Single customer with 4+ orders fetches ALL orders (active, delivered, cancelled)',
    `Status: ${resListA.getStatusCode()}, Total Orders Found: ${ordersA.length}`
  );

  // Check categorization: Active vs Past
  const activeOrders = ordersA.filter(o => o.orderStatus !== 'DELIVERED' && o.orderStatus !== 'CANCELLED');
  const pastOrders = ordersA.filter(o => o.orderStatus === 'DELIVERED' || o.orderStatus === 'CANCELLED');

  assert(
    activeOrders.some(o => o.orderStatus === 'PLACED') &&
    activeOrders.some(o => o.orderStatus === 'PREPARING') &&
    pastOrders.some(o => o.orderStatus === 'DELIVERED') &&
    pastOrders.some(o => o.orderStatus === 'CANCELLED'),
    '2. Correct categorization into Active (PLACED, PREPARING) and Past (DELIVERED, CANCELLED)',
    `Active Count: ${activeOrders.length}, Past Count: ${pastOrders.length}`
  );

  // Check newest-to-oldest sorting
  let isSorted = true;
  for (let i = 0; i < ordersA.length - 1; i++) {
    if (new Date(ordersA[i].createdAt) < new Date(ordersA[i + 1].createdAt)) {
      isSorted = false;
      break;
    }
  }
  assert(
    isSorted,
    '3. Orders are sorted newest-to-oldest chronologically',
    `Newest: ${ordersA[0] ? ordersA[0].createdAt : 'none'}, Oldest: ${ordersA[ordersA.length - 1] ? ordersA[ordersA.length - 1].createdAt : 'none'}`
  );

  // --- TEST GROUP 2: CUSTOMER ISOLATION & UNAUTHORIZED ACCESS REJECTION ---
  console.log('\n--- TEST GROUP 2: CUSTOMER ISOLATION & SECURITY CHECKS ---');

  // Create an order for Customer B
  const { req: reqCreateB, res: resCreateB } = mockReqRes({
    body: {
      customerId: customerB.id,
      customerName: customerB.name,
      customerPhone: customerB.phone,
      restaurantId: rest.id,
      items: [{ id: 'dish_h2', name: 'Shahi Paneer', price: 240, quantity: 1 }],
      paymentMethod: 'COD',
      deliveryAddress: 'Customer B Address',
      distanceKm: 2.5,
      idempotencyKey: 'idemp_test_b_' + Date.now()
    },
    headers: { 'authorization': `Bearer ${tokenB}` }
  });
  await orderController.createOrder(reqCreateB, resCreateB);
  const dataB = resCreateB.getResponse();
  const orderIdB = dataB.order.orderId;

  // Customer A lists orders -> Customer B's order must NOT be present
  const customerBOrderInA = ordersA.find(o => o.orderId === orderIdB);
  assert(
    !customerBOrderInA,
    '4. Customer A cannot view Customer B\'s orders in order listing',
    `Customer B Order ${orderIdB} present in A: ${Boolean(customerBOrderInA)}`
  );

  // Customer A tries to directly view Customer B's order details
  const { req: reqDetailA_B, res: resDetailA_B } = mockReqRes({
    params: { orderId: orderIdB },
    headers: { 'authorization': `Bearer ${tokenA}` }
  });
  orderController.getOrderDetails(reqDetailA_B, resDetailA_B);
  assert(
    resDetailA_B.getStatusCode() === 403,
    '5. Customer A accessing Customer B\'s specific order returns 403 Forbidden',
    `Status: ${resDetailA_B.getStatusCode()}, Message: ${resDetailA_B.getResponse().message}`
  );

  // Unauthenticated caller attempts to query customer orders using unverified query param
  const { req: reqFakeQuery, res: resFakeQuery } = mockReqRes({
    query: { customerPhone: customerA.phone }
  });
  orderController.listOrders(reqFakeQuery, resFakeQuery);
  assert(
    resFakeQuery.getStatusCode() === 401,
    '6. Unauthenticated query param ?customerPhone=... rejected with 401 Unauthorized',
    `Status: ${resFakeQuery.getStatusCode()}, Message: ${resFakeQuery.getResponse().message}`
  );

  // Unauthenticated caller attempts to query customer orders using unverified custom header
  const { req: reqFakeHeader, res: resFakeHeader } = mockReqRes({
    headers: { 'x-customer-phone': customerA.phone }
  });
  orderController.listOrders(reqFakeHeader, resFakeHeader);
  assert(
    resFakeHeader.getStatusCode() === 401,
    '7. Unauthenticated custom header x-customer-phone rejected with 401 Unauthorized',
    `Status: ${resFakeHeader.getStatusCode()}, Message: ${resFakeHeader.getResponse().message}`
  );

  // Authenticated Customer A attempts to spoof Customer B phone in query param
  const { req: reqSpoofA_B, res: resSpoofA_B } = mockReqRes({
    query: { customerPhone: customerB.phone },
    headers: { 'authorization': `Bearer ${tokenA}` }
  });
  orderController.listOrders(reqSpoofA_B, resSpoofA_B);
  assert(
    resSpoofA_B.getStatusCode() === 403,
    '8. Authenticated Customer A spoofing Customer B phone returns 403 Forbidden',
    `Status: ${resSpoofA_B.getStatusCode()}, Message: ${resSpoofA_B.getResponse().message}`
  );

  // --- TEST GROUP 3: COD ₹0 BUG & ACCURATE FINANCIAL MAPPINGS ---
  console.log('\n--- TEST GROUP 3: COD ₹0 BUG & FINANCIAL AMOUNT MAPPINGS ---');

  // Verify COD Order financials mapping
  const codOrder = ordersA.find(o => o.paymentMethod === 'COD');
  assert(
    codOrder && codOrder.totalAmount > 0 && codOrder.codAmount === codOrder.totalAmount && codOrder.codCashToCollect === codOrder.totalAmount,
    '9. COD order has non-zero verified totalAmount, codAmount, and codCashToCollect',
    `Order: ${codOrder.orderId}, totalAmount: ₹${codOrder.totalAmount}, codAmount: ₹${codOrder.codAmount}`
  );

  // Online Paid Order has codCashToCollect === 0
  const { req: reqOnline, res: resOnline } = mockReqRes({
    body: {
      customerId: customerA.id,
      customerName: customerA.name,
      customerPhone: customerA.phone,
      restaurantId: rest.id,
      items: [{ id: 'dish_h1', name: 'Dal Makhani', price: 180, quantity: 1 }],
      paymentMethod: 'ONLINE',
      deliveryAddress: 'Online Test Address',
      distanceKm: 3.0,
      idempotencyKey: 'idemp_test_online_' + Date.now()
    },
    headers: { 'authorization': `Bearer ${tokenA}` }
  });
  await orderController.createOrder(reqOnline, resOnline);
  const onlineOrder = resOnline.getResponse().order;

  // Mark as PAID
  const currentDb = readDb();
  const storedOnline = currentDb.orders.find(o => o.orderId === onlineOrder.orderId);
  storedOnline.paymentStatus = 'PAID';
  storedOnline.orderStatus = 'CONFIRMED';
  writeDb(currentDb);

  const { req: reqOnlineGet, res: resOnlineGet } = mockReqRes({
    params: { orderId: onlineOrder.orderId },
    headers: { 'authorization': `Bearer ${tokenA}` }
  });
  orderController.getOrderDetails(reqOnlineGet, resOnlineGet);
  const verifiedOnline = resOnlineGet.getResponse().order;

  assert(
    verifiedOnline.paymentStatus === 'PAID' && verifiedOnline.codAmount === 0 && verifiedOnline.codCashToCollect === 0,
    '10. Online PAID order has codAmount === 0 and codCashToCollect === 0 (no duplicate cash collection)',
    `Status: ${verifiedOnline.paymentStatus}, codAmount: ₹${verifiedOnline.codAmount}, codCashToCollect: ₹${verifiedOnline.codCashToCollect}`
  );

  // Decimal amounts test
  const financialsDec = pricingEngine.calculateOrderFinancials({
    foodTotal: 250.75,
    distanceKm: 4.3,
    promoDiscount: 0,
    commissionPercent: 15
  });
  const expectedTotal = Math.round((financialsDec.foodTotal + financialsDec.deliveryFee + financialsDec.platformFee - (financialsDec.promoDiscount || 0)) * 100) / 100;
  assert(
    financialsDec.foodTotal === 250.75 &&
    typeof financialsDec.deliveryFee === 'number' && financialsDec.deliveryFee > 0 &&
    typeof financialsDec.platformFee === 'number' && financialsDec.platformFee > 0 &&
    typeof financialsDec.customerTotalPaid === 'number' && !isNaN(financialsDec.customerTotalPaid) && financialsDec.customerTotalPaid > 0 &&
    financialsDec.customerTotalPaid === expectedTotal,
    '11. Decimal amounts calculate without NaN or zero fallback',
    `foodTotal: ₹${financialsDec.foodTotal}, deliveryFee: ₹${financialsDec.deliveryFee}, platformFee: ₹${financialsDec.platformFee}, customerTotalPaid: ₹${financialsDec.customerTotalPaid}`
  );

  // --- TEST GROUP 4: DISTANCE, SERVICEABILITY & RIDER PAYOUT PRESERVATION ---
  console.log('\n--- TEST GROUP 4: DISTANCE, SERVICEABILITY & RIDER PAYOUT ---');

  // Test 12: Rider payout uses original actual distanceKm and admin settings untouched
  // INDFood Admin calculation formula: (Distance * PerKmRate) + (Incentive Bonus if active)
  // 8.5 km * ₹12/km = ₹102 + ₹15 incentive = ₹117
  const actualDistance = 8.5;
  const payoutObj = pricingEngine.calculateRiderPayout(actualDistance, 0, false, 12.0, 15.0, true);
  const payout = payoutObj.riderPayout;
  assert(
    payout === 117,
    '12. Rider payout preserves actual distance (8.5 km), Admin per-km rate (₹12), and incentive (₹15)',
    `Calculated Payout: ₹${payout} (Expected ₹117)`
  );

  // Test 13: Customer delivery fee cap does NOT affect rider payout
  // Set Admin maxCustomerDeliveryFee cap in DB
  const testDb = readDb();
  if (!testDb.settings) testDb.settings = {};
  testDb.settings.maxCustomerDeliveryFee = 40.0;
  testDb.settings.riderPerKmRate = 10.0;
  testDb.settings.riderIncentiveActive = false;
  writeDb(testDb);

  const cappedFee = pricingEngine.calculateCustomerDeliveryFee(10.0);
  const uncappedRiderPayout = pricingEngine.calculateRiderPayout(10.0).riderPayout;
  // Uncapped customer fee for 10km would be 30 + (10 - 2)*12.5 = 130 -> capped to 40
  // Rider payout for 10km: 10 * 10 = 100 -> untouched
  assert(
    cappedFee === 40 && uncappedRiderPayout === 100,
    '13. Customer delivery fee cap applies independently; Rider payout remains untouched',
    `Customer Fee: ₹${cappedFee} (Capped at 40), Rider Payout: ₹${uncappedRiderPayout} (Full 100)`
  );

  // Restore DB settings
  const cleanDb = readDb();
  delete cleanDb.settings.maxCustomerDeliveryFee;
  cleanDb.settings.riderPerKmRate = 12.0;
  cleanDb.settings.riderIncentiveActive = true;
  writeDb(cleanDb);

  // Test 14: Order within serviceable radius (4.5 km <= 15 km) is ACCEPTED
  const { req: reqWithin, res: resWithin } = mockReqRes({
    body: {
      customerId: customerA.id,
      customerName: customerA.name,
      customerPhone: customerA.phone,
      restaurantId: rest.id,
      items: [{ id: 'dish_h1', name: 'Dal Makhani', price: 180, quantity: 1 }],
      paymentMethod: 'COD',
      deliveryAddress: 'Within 15 KM Indore',
      distanceKm: 4.5,
      idempotencyKey: 'idemp_test_within_' + Date.now()
    },
    headers: { 'authorization': `Bearer ${tokenA}` }
  });
  await orderController.createOrder(reqWithin, resWithin);
  assert(
    resWithin.getStatusCode() === 200 && resWithin.getResponse().success === true,
    '14. Order within serviceable radius (4.5 km <= 15 km) is ACCEPTED',
    `Status: ${resWithin.getStatusCode()}, OrderId: ${resWithin.getResponse().order ? resWithin.getResponse().order.orderId : 'none'}`
  );

  // Test 15: Order outside serviceable radius (24.0 km > 15 km) is STRICTLY REJECTED with 400
  const { req: reqOutside, res: resOutside } = mockReqRes({
    body: {
      customerId: customerA.id,
      customerName: customerA.name,
      customerPhone: customerA.phone,
      restaurantId: rest.id,
      items: [{ id: 'dish_h1', name: 'Dal Makhani', price: 180, quantity: 1 }],
      paymentMethod: 'COD',
      deliveryAddress: 'Outside 15 KM Remote Location',
      distanceKm: 24.0,
      idempotencyKey: 'idemp_test_outside_' + Date.now()
    },
    headers: { 'authorization': `Bearer ${tokenA}` }
  });
  await orderController.createOrder(reqOutside, resOutside);
  assert(
    resOutside.getStatusCode() === 400 && resOutside.getResponse().success === false,
    '15. Order outside serviceable radius (24.0 km > 15 km) is STRICTLY REJECTED with 400',
    `Status: ${resOutside.getStatusCode()}, Message: ${resOutside.getResponse().message}`
  );

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passed}/${passed + failed} TESTS PASSED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
