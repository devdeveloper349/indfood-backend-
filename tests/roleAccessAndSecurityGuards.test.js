const assert = require('assert');
const jwt = require('jsonwebtoken');
const { readDb, writeDb } = require('../src/models/db');
const { getJwtSecret } = require('../src/config/jwt');
const { generateUserJwt, setServerOtp, verifyServerOtp } = require('../src/controllers/authController');
const orderController = require('../src/controllers/orderController');
const adminController = require('../src/controllers/adminController');
const restaurantController = require('../src/controllers/restaurantController');
const kycController = require('../src/controllers/kycController');

function mockReqRes(options = {}) {
  let statusCode = 200;
  let responseData = null;

  const req = {
    body: options.body || {},
    query: options.query || {},
    params: options.params || {},
    headers: options.headers || {},
    io: options.io || null
  };

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

async function runSecurityTests() {
  console.log('====================================================');
  console.log('  INDFOOD TARGETED SECURITY & ROLE ACCESS TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function testAssert(condition, testName, evidence) {
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

  // ==========================================
  // GROUP 1: JWT SECRET SECURITY & PRODUCTION GUARDS
  // ==========================================
  console.log('--- TEST GROUP 1: JWT SECRET SECURITY & PRODUCTION GUARDS ---');

  // Test 1: Production fails safely when JWT_SECRET is missing
  const origEnv = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    let threwMissing = false;
    try {
      getJwtSecret();
    } catch (err) {
      threwMissing = err.message.includes('JWT_SECRET must be configured in production');
    }
    testAssert(threwMissing, '1. Production fails safely when JWT_SECRET is missing', 'Threw expected configuration error');

    // Test 2: Production fails safely when JWT_SECRET is weak
    process.env.JWT_SECRET = 'short_weak_key';
    let threwWeak = false;
    try {
      getJwtSecret();
    } catch (err) {
      threwWeak = err.message.includes('Insecure JWT_SECRET detected');
    }
    testAssert(threwWeak, '2. Production fails safely when JWT_SECRET is weak (<32 chars)', 'Threw expected insecure secret error');
  } finally {
    process.env = origEnv;
  }

  // Test 3: JWT Generation and Verification for all four roles
  const roles = [
    { id: 'usr_c_test1', phone: '9876543210', role: 'customer', name: 'Customer Test' },
    { id: 'usr_r_test1', phone: '9876543211', role: 'rider', name: 'Rider Test' },
    { id: 'usr_rest_test1', phone: '9876543212', role: 'restaurant', name: 'Rest Owner', restaurantId: 'rest_sec_test_1' },
    { id: 'usr_adm_test1', phone: '9876543213', role: 'admin', name: 'Admin Test' }
  ];

  let allRolesValid = true;
  for (const r of roles) {
    const token = generateUserJwt(r);
    const decoded = jwt.verify(token, getJwtSecret());
    if (!decoded || decoded.role !== r.role || decoded.id !== r.id) {
      allRolesValid = false;
    }
  }
  testAssert(allRolesValid, '3. JWT generation & verification works consistently for Customer, Rider, Restaurant & Admin', `Tested 4 roles: ${roles.map(r => r.role).join(', ')}`);

  // ==========================================
  // GROUP 2: ZERO FOOD SUBTOTAL & MALFORMED PRICE GUARDS
  // ==========================================
  console.log('\n--- TEST GROUP 2: ZERO FOOD SUBTOTAL & MALFORMED PRICE GUARDS ---');

  const db = readDb();
  let secRest = (db.restaurants || []).find(r => r.id === 'rest_sec_guard_1');
  if (!secRest) {
    secRest = {
      id: 'rest_sec_guard_1',
      name: 'Security Guard Test Kitchen',
      latitude: '22.7196',
      longitude: '75.8577',
      commissionPercent: 15,
      deliveryRadiusKm: 15.0,
      menu: [
        { id: 'm_dish_1', name: 'Paneer Butter Masala', price: 200 },
        { id: 'm_dish_2', name: 'Dal Makhani', price: 150 }
      ]
    };
    db.restaurants.push(secRest);
    writeDb(db);
  }

  const custUser = roles[0];
  const custToken = generateUserJwt(custUser);

  // Test 4: Reject zero-price order
  const { req: reqZeroPrice, res: resZeroPrice } = mockReqRes({
    body: {
      customerId: custUser.id,
      customerPhone: custUser.phone,
      restaurantId: secRest.id,
      items: [{ id: 'm_dish_unknown', name: 'Free Item', price: 0, quantity: 1 }],
      deliveryAddress: 'Indore Test Area',
      paymentMethod: 'ONLINE'
    },
    headers: { authorization: `Bearer ${custToken}` }
  });
  await orderController.createOrder(reqZeroPrice, resZeroPrice);
  testAssert(
    resZeroPrice.getStatusCode() === 400,
    '4. Zero-price item / order is strictly rejected with 400',
    `Status: ${resZeroPrice.getStatusCode()}, Message: ${resZeroPrice.getResponse()?.message}`
  );

  // Test 5: Reject invalid/zero/negative quantities
  const { req: reqBadQty, res: resBadQty } = mockReqRes({
    body: {
      customerId: custUser.id,
      customerPhone: custUser.phone,
      restaurantId: secRest.id,
      items: [{ id: 'm_dish_1', name: 'Paneer Butter Masala', price: 200, quantity: -2 }],
      deliveryAddress: 'Indore Test Area',
      paymentMethod: 'ONLINE'
    },
    headers: { authorization: `Bearer ${custToken}` }
  });
  await orderController.createOrder(reqBadQty, resBadQty);
  testAssert(
    resBadQty.getStatusCode() === 400,
    '5. Negative or invalid item quantity is strictly rejected with 400',
    `Status: ${resBadQty.getStatusCode()}, Message: ${resBadQty.getResponse()?.message}`
  );

  // Test 6: Tampered client price is ignored and recalculated using trusted server menu price
  const { req: reqPriceTamper, res: resPriceTamper } = mockReqRes({
    body: {
      customerId: custUser.id,
      customerPhone: custUser.phone,
      restaurantId: secRest.id,
      // Client maliciously claims price is ₹1 instead of menu price ₹200
      items: [{ id: 'm_dish_1', name: 'Paneer Butter Masala', price: 1, quantity: 2 }],
      deliveryAddress: 'Indore Test Area',
      distanceKm: 2.0,
      paymentMethod: 'COD'
    },
    headers: { authorization: `Bearer ${custToken}` }
  });
  await orderController.createOrder(reqPriceTamper, resPriceTamper);
  const createdTampered = resPriceTamper.getResponse()?.order;
  testAssert(
    resPriceTamper.getStatusCode() === 200 && createdTampered && createdTampered.foodTotal === 400,
    '6. Client-tampered item price (₹1 vs ₹200) is ignored; Server trusted menu price enforced (₹400)',
    `Status: ${resPriceTamper.getStatusCode()}, Food Total: ₹${createdTampered?.foodTotal} (Expected ₹400 for 2x ₹200)`
  );

  // ==========================================
  // GROUP 3: ROLE-BASED ACCESS CONTROL FOR getOrderDetails
  // ==========================================
  console.log('\n--- TEST GROUP 3: ROLE-BASED ACCESS CONTROL FOR getOrderDetails ---');

  // Set up Rider 1, Rider 2, Restaurant 1, Restaurant 2
  const rider1User = { id: 'usr_rd_assigned_1', phone: '9826011111', role: 'rider', name: 'Assigned Rider' };
  const rider2User = { id: 'usr_rd_unassigned_2', phone: '9826022222', role: 'rider', name: 'Unassigned Rider' };
  const rider1Token = generateUserJwt(rider1User);
  const rider2Token = generateUserJwt(rider2User);

  const rest1User = { id: 'usr_rest_owner_1', phone: '9826033333', role: 'restaurant', name: 'Rest 1 Owner', restaurantId: secRest.id };
  const rest2User = { id: 'usr_rest_owner_2', phone: '9826044444', role: 'restaurant', name: 'Rest 2 Owner', restaurantId: 'rest_other_2' };
  const rest1Token = generateUserJwt(rest1User);
  const rest2Token = generateUserJwt(rest2User);

  const adminToken = generateUserJwt(roles[3]);

  // Ensure rider records exist in db.riders
  const currentDb = readDb();
  if (!currentDb.riders.find(r => r.userId === rider1User.id)) {
    currentDb.riders.push({
      userId: rider1User.id,
      phone: rider1User.phone,
      name: rider1User.name,
      permanentRiderId: 'rider1perm123',
      kycStatus: 'APPROVED',
      isOnline: true
    });
  }
  if (!currentDb.riders.find(r => r.userId === rider2User.id)) {
    currentDb.riders.push({
      userId: rider2User.id,
      phone: rider2User.phone,
      name: rider2User.name,
      permanentRiderId: 'rider2perm456',
      kycStatus: 'APPROVED',
      isOnline: true
    });
  }
  writeDb(currentDb);

  // Create a clean verified order assigned to Rider 1 and belonging to secRest
  const { req: reqOrder, res: resOrder } = mockReqRes({
    body: {
      customerId: custUser.id,
      customerName: custUser.name,
      customerPhone: custUser.phone,
      restaurantId: secRest.id,
      items: [{ id: 'm_dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
      deliveryAddress: 'Test Delivery Address',
      distanceKm: 2.5,
      paymentMethod: 'COD'
    },
    headers: { authorization: `Bearer ${custToken}` }
  });
  await orderController.createOrder(reqOrder, resOrder);
  const targetOrder = resOrder.getResponse()?.order;
  assert(targetOrder, 'Failed to create test order');

  // Assign Rider 1 to this order in DB
  const dbAfterCreate = readDb();
  const dbOrder = dbAfterCreate.orders.find(o => o.orderId === targetOrder.orderId);
  dbOrder.assignedRider = {
    userId: rider1User.id,
    permanentRiderId: 'rider1perm123',
    name: rider1User.name,
    phone: rider1User.phone
  };
  writeDb(dbAfterCreate);

  // Test 7: Unauthenticated request to getOrderDetails is rejected with 401
  const { req: reqUnauth, res: resUnauth } = mockReqRes({
    params: { orderId: targetOrder.orderId }
  });
  orderController.getOrderDetails(reqUnauth, resUnauth);
  testAssert(
    resUnauth.getStatusCode() === 401,
    '7. Unauthenticated request to getOrderDetails is strictly rejected with 401',
    `Status: ${resUnauth.getStatusCode()}, Message: ${resUnauth.getResponse()?.message}`
  );

  // Test 8: Assigned Rider 1 can access their assigned order (sanitized: deliveryOtp stripped)
  const { req: reqRider1, res: resRider1 } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${rider1Token}` }
  });
  orderController.getOrderDetails(reqRider1, resRider1);
  const rider1Order = resRider1.getResponse()?.order;
  testAssert(
    resRider1.getStatusCode() === 200 && rider1Order && rider1Order.orderId === targetOrder.orderId && rider1Order.deliveryOtp === undefined,
    '8. Assigned Rider can access their own assigned order with sensitive deliveryOtp stripped',
    `Status: ${resRider1.getStatusCode()}, OrderId: ${rider1Order?.orderId}, deliveryOtp present: ${rider1Order?.deliveryOtp !== undefined}`
  );

  // Test 9: Unassigned Rider 2 CANNOT access Rider 1's assigned order (403 Forbidden)
  const { req: reqRider2, res: resRider2 } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${rider2Token}` }
  });
  orderController.getOrderDetails(reqRider2, resRider2);
  testAssert(
    resRider2.getStatusCode() === 403,
    '9. Unassigned Rider cannot access another rider\'s assigned order (403 Forbidden)',
    `Status: ${resRider2.getStatusCode()}, Message: ${resRider2.getResponse()?.message}`
  );

  // Test 10: Restaurant 1 can access its own restaurant\'s order (sanitized: deliveryOtp stripped)
  const { req: reqRest1, res: resRest1 } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${rest1Token}` }
  });
  orderController.getOrderDetails(reqRest1, resRest1);
  const rest1Order = resRest1.getResponse()?.order;
  testAssert(
    resRest1.getStatusCode() === 200 && rest1Order && rest1Order.orderId === targetOrder.orderId && rest1Order.deliveryOtp === undefined,
    '10. Restaurant can access its own restaurant\'s order with sensitive deliveryOtp stripped',
    `Status: ${resRest1.getStatusCode()}, OrderId: ${rest1Order?.orderId}, deliveryOtp present: ${rest1Order?.deliveryOtp !== undefined}`
  );

  // Test 11: Restaurant 2 CANNOT access Restaurant 1\'s order (403 Forbidden)
  const { req: reqRest2, res: resRest2 } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${rest2Token}` }
  });
  orderController.getOrderDetails(reqRest2, resRest2);
  testAssert(
    resRest2.getStatusCode() === 403,
    '11. Restaurant cannot access another restaurant\'s order (403 Forbidden)',
    `Status: ${resRest2.getStatusCode()}, Message: ${resRest2.getResponse()?.message}`
  );

  // Test 12: Customer 1 (owner) can access their order WITH deliveryOtp
  const { req: reqCust1, res: resCust1 } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${custToken}` }
  });
  orderController.getOrderDetails(reqCust1, resCust1);
  const custOrder = resCust1.getResponse()?.order;
  testAssert(
    resCust1.getStatusCode() === 200 && custOrder && custOrder.deliveryOtp !== undefined,
    '12. Customer owner can access their order and retains deliveryOtp for handoff verification',
    `Status: ${resCust1.getStatusCode()}, deliveryOtp: ${custOrder?.deliveryOtp}`
  );

  // Test 13: Customer 2 CANNOT access Customer 1\'s order (403 Forbidden)
  const cust2User = { id: 'usr_c_other_99', phone: '9111122222', role: 'customer', name: 'Other Customer' };
  const cust2Token = generateUserJwt(cust2User);
  const { req: reqCust2, res: resCust2 } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${cust2Token}` }
  });
  orderController.getOrderDetails(reqCust2, resCust2);
  testAssert(
    resCust2.getStatusCode() === 403,
    '13. Customer cannot access another customer\'s order (403 Forbidden)',
    `Status: ${resCust2.getStatusCode()}, Message: ${resCust2.getResponse()?.message}`
  );

  // Test 14: Admin can access any order
  const { req: reqAdmin, res: resAdmin } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${adminToken}` }
  });
  orderController.getOrderDetails(reqAdmin, resAdmin);
  testAssert(
    resAdmin.getStatusCode() === 200 && resAdmin.getResponse()?.order?.orderId === targetOrder.orderId,
    '14. Admin authorization remains fully functional for getOrderDetails',
    `Status: ${resAdmin.getStatusCode()}, OrderId: ${resAdmin.getResponse()?.order?.orderId}`
  );

  // ==========================================
  // GROUP 4: STRICT REJECTION OF UNSIGNED LEGACY TOKENS & FORGED/EXPIRED TOKENS
  // ==========================================
  console.log('\n--- TEST GROUP 4: STRICT REJECTION OF UNSIGNED & FORGED TOKENS ---');

  // Test 15: Unsigned dummy token on getOrderDetails is strictly rejected with 401
  const { req: reqDummy, res: resDummy } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer dummy_jwt_token_${custUser.id}` }
  });
  orderController.getOrderDetails(reqDummy, resDummy);
  testAssert(
    resDummy.getStatusCode() === 401,
    '15. Unsigned dummy token (dummy_jwt_token_...) is strictly rejected with 401',
    `Status: ${resDummy.getStatusCode()}, Message: ${resDummy.getResponse()?.message}`
  );

  // Test 16: Unsigned legacy timestamp token on getOrderDetails is strictly rejected with 401
  const { req: reqLegacyToken, res: resLegacyToken } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer jwt_token_${custUser.id}_1731110000000` }
  });
  orderController.getOrderDetails(reqLegacyToken, resLegacyToken);
  testAssert(
    resLegacyToken.getStatusCode() === 401,
    '16. Unsigned legacy timestamp token (jwt_token_...) is strictly rejected with 401',
    `Status: ${resLegacyToken.getStatusCode()}, Message: ${resLegacyToken.getResponse()?.message}`
  );

  // Test 17: Forged signature JWT is strictly rejected with 401
  const forgedToken = jwt.sign({ id: custUser.id, role: 'customer', phone: custUser.phone }, 'wrong_attacker_secret_key_123456');
  const { req: reqForged, res: resForged } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${forgedToken}` }
  });
  orderController.getOrderDetails(reqForged, resForged);
  testAssert(
    resForged.getStatusCode() === 401,
    '17. Forged signature JWT is strictly rejected with 401',
    `Status: ${resForged.getStatusCode()}, Message: ${resForged.getResponse()?.message}`
  );

  // Test 18: Expired JWT is strictly rejected with 401
  const expiredToken = jwt.sign({ id: custUser.id, role: 'customer', phone: custUser.phone }, getJwtSecret(), { expiresIn: '-10s' });
  const { req: reqExpired, res: resExpired } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${expiredToken}` }
  });
  orderController.getOrderDetails(reqExpired, resExpired);
  testAssert(
    resExpired.getStatusCode() === 401,
    '18. Expired JWT is strictly rejected with 401',
    `Status: ${resExpired.getStatusCode()}, Message: ${resExpired.getResponse()?.message}`
  );

  // Test 18b: JWT token with missing role is strictly rejected with 401 (never defaults to customer)
  const tokenNoRole = jwt.sign({ id: custUser.id, phone: custUser.phone }, getJwtSecret());
  const { req: reqNoRole, res: resNoRole } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${tokenNoRole}` }
  });
  orderController.getOrderDetails(reqNoRole, resNoRole);
  testAssert(
    resNoRole.getStatusCode() === 401,
    '18b. JWT token with missing role is strictly rejected with 401 (never defaults to customer)',
    `Status: ${resNoRole.getStatusCode()}, Message: ${resNoRole.getResponse()?.message}`
  );

  // Test 18c: JWT token with invalid role is strictly rejected with 401 (never defaults to customer)
  const tokenInvalidRole = jwt.sign({ id: custUser.id, phone: custUser.phone, role: 'attacker_fake_role' }, getJwtSecret());
  const { req: reqInvalidRole, res: resInvalidRole } = mockReqRes({
    params: { orderId: targetOrder.orderId },
    headers: { authorization: `Bearer ${tokenInvalidRole}` }
  });
  orderController.getOrderDetails(reqInvalidRole, resInvalidRole);
  testAssert(
    resInvalidRole.getStatusCode() === 401,
    '18c. JWT token with invalid role is strictly rejected with 401 (never defaults to customer)',
    `Status: ${resInvalidRole.getStatusCode()}, Message: ${resInvalidRole.getResponse()?.message}`
  );

  // Test 19: Unsigned admin token on Admin route is strictly rejected with 401
  const { req: reqUnsignedAdmin, res: resUnsignedAdmin } = mockReqRes({
    headers: { authorization: 'Bearer jwt_token_usr_admin_1' }
  });
  let adminBypassed = false;
  adminController.requireAdmin(reqUnsignedAdmin, resUnsignedAdmin, () => { adminBypassed = true; });
  testAssert(
    adminBypassed === false && resUnsignedAdmin.getStatusCode() === 401,
    '19. Unsigned admin token / user ID header on Admin route is strictly rejected with 401',
    `adminPassed: ${adminBypassed}, Status: ${resUnsignedAdmin.getStatusCode()}, Message: ${resUnsignedAdmin.getResponse()?.message}`
  );

  // Test 20: Unsigned dummy token on restaurant route is strictly rejected with 401
  const { req: reqUnsignedRest } = mockReqRes({
    headers: { authorization: 'Bearer dummy_jwt_token_usr_rest_1' }
  });
  const restOwnershipCheck = restaurantController.verifyRestaurantOwnership(reqUnsignedRest, secRest.id, readDb());
  testAssert(
    restOwnershipCheck.authorized === false && restOwnershipCheck.status === 401,
    '20. Unsigned dummy token on Restaurant route is strictly rejected with 401',
    `Authorized: ${restOwnershipCheck.authorized}, Status: ${restOwnershipCheck.status}, Message: ${restOwnershipCheck.message}`
  );

  // Test 21: Customer JWT token on Admin route is strictly rejected with 401
  const { req: reqCustOnAdmin, res: resCustOnAdmin } = mockReqRes({
    headers: { authorization: `Bearer ${custToken}` }
  });
  let custOnAdminPassed = false;
  adminController.requireAdmin(reqCustOnAdmin, resCustOnAdmin, () => { custOnAdminPassed = true; });
  testAssert(
    custOnAdminPassed === false && resCustOnAdmin.getStatusCode() === 401,
    '21. Customer JWT token on Admin route is strictly rejected with 401',
    `adminPassed: ${custOnAdminPassed}, Status: ${resCustOnAdmin.getStatusCode()}, Message: ${resCustOnAdmin.getResponse()?.message}`
  );

  // Test 22: Rider login via kycController.riderLogin returns valid signed JWT & verifies DB persistence
  const { req: reqRiderLogin, res: resRiderLogin } = mockReqRes({
    body: { phone: rider1User.phone }
  });
  kycController.riderLogin(reqRiderLogin, resRiderLogin);
  const riderLoginToken = resRiderLogin.getResponse()?.token;
  let decodedRiderToken = null;
  try {
    decodedRiderToken = jwt.verify(riderLoginToken, getJwtSecret());
  } catch (e) {}
  const dbAfterRiderLogin = readDb();
  const persistedUserInDb = (dbAfterRiderLogin.users || []).find(u => u.phone && String(u.phone).slice(-10) === String(rider1User.phone).slice(-10));
  testAssert(
    resRiderLogin.getStatusCode() === 200 &&
    decodedRiderToken &&
    decodedRiderToken.role === 'rider' &&
    decodedRiderToken.permanentRiderId === 'rider1perm123' &&
    persistedUserInDb &&
    persistedUserInDb.role === 'rider',
    '22. Rider login returns cryptographically verified signed JWT token with DB persistence',
    `Status: ${resRiderLogin.getStatusCode()}, Role: ${decodedRiderToken?.role}, PermId: ${decodedRiderToken?.permanentRiderId}, DB User Role: ${persistedUserInDb?.role}`
  );

  // Test 23: Rider registration via kycController.submitKyc creates actual Rider & User in DB with signed JWT
  const newRiderPhone = '9826099999';
  const preCleanupDb = readDb();
  preCleanupDb.riders = (preCleanupDb.riders || []).filter(r => r.phone !== newRiderPhone);
  preCleanupDb.users = (preCleanupDb.users || []).filter(u => u.phone !== newRiderPhone);
  writeDb(preCleanupDb);

  const { req: reqKycSubmit, res: resKycSubmit } = mockReqRes({
    body: {
      name: 'New Registered Rider',
      mobileNumber: newRiderPhone,
      panNumber: 'ABCDE1234F',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-1234'
    }
  });
  await kycController.submitKyc(reqKycSubmit, resKycSubmit);
  const kycSubmitToken = resKycSubmit.getResponse()?.token;
  const kycSubmitPermId = resKycSubmit.getResponse()?.permanentRiderId;
  let decodedKycToken = null;
  try {
    decodedKycToken = jwt.verify(kycSubmitToken, getJwtSecret());
  } catch (e) {}

  const dbAfterKyc = readDb();
  const persistedRiderInDb = (dbAfterKyc.riders || []).find(r => r.phone === newRiderPhone);
  const persistedNewUserInDb = (dbAfterKyc.users || []).find(u => u.phone === newRiderPhone);

  testAssert(
    resKycSubmit.getStatusCode() === 200 &&
    decodedKycToken &&
    decodedKycToken.role === 'rider' &&
    decodedKycToken.permanentRiderId === kycSubmitPermId &&
    persistedRiderInDb &&
    persistedRiderInDb.kycStatus === 'APPROVED' &&
    persistedNewUserInDb &&
    persistedNewUserInDb.role === 'rider',
    '23. Rider KYC registration creates persistent Rider & User records in DB with verified signed JWT',
    `Status: ${resKycSubmit.getStatusCode()}, DB Rider KYC: ${persistedRiderInDb?.kycStatus}, DB User Role: ${persistedNewUserInDb?.role}, PermId: ${kycSubmitPermId}`
  );

  // Test 24: Actual Flow - Newly registered Rider token used on actual protected endpoint (getOrderDetails)
  const { req: reqOrderForNewRider, res: resOrderForNewRider } = mockReqRes({
    body: {
      customerId: custUser.id,
      customerName: custUser.name,
      customerPhone: custUser.phone,
      restaurantId: secRest.id,
      items: [{ id: 'm_dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
      deliveryAddress: 'Test KYC Rider Delivery Area',
      distanceKm: 3.0,
      paymentMethod: 'COD'
    },
    headers: { authorization: `Bearer ${custToken}` }
  });
  await orderController.createOrder(reqOrderForNewRider, resOrderForNewRider);
  const newOrder = resOrderForNewRider.getResponse()?.order;
  assert(newOrder, 'Failed to create order for new KYC rider test');

  // Assign newly registered rider to this order in DB
  const dbAssign = readDb();
  const dbAssignOrder = dbAssign.orders.find(o => o.orderId === newOrder.orderId);
  dbAssignOrder.assignedRider = {
    userId: persistedRiderInDb.userId,
    permanentRiderId: kycSubmitPermId,
    phone: newRiderPhone,
    name: 'New Registered Rider'
  };
  writeDb(dbAssign);

  // Newly registered rider accesses assigned order details using their real signed JWT
  const { req: reqRiderAccess, res: resRiderAccess } = mockReqRes({
    params: { orderId: newOrder.orderId },
    headers: { authorization: `Bearer ${kycSubmitToken}` }
  });
  orderController.getOrderDetails(reqRiderAccess, resRiderAccess);
  const riderOrderRes = resRiderAccess.getResponse()?.order;
  testAssert(
    resRiderAccess.getStatusCode() === 200 &&
    riderOrderRes &&
    riderOrderRes.orderId === newOrder.orderId &&
    riderOrderRes.deliveryOtp === undefined,
    '24. Actual Flow: KYC Registered Rider accesses assigned order via signed JWT with deliveryOtp stripped',
    `Status: ${resRiderAccess.getStatusCode()}, OrderId: ${riderOrderRes?.orderId}, deliveryOtp present: ${Boolean(riderOrderRes?.deliveryOtp)}`
  );

  // Test 25: Actual Flow - Rider JWT is strictly rejected on Admin endpoints (Cross-role guard)
  const { req: reqRiderOnAdmin, res: resRiderOnAdmin } = mockReqRes({
    headers: { authorization: `Bearer ${kycSubmitToken}` }
  });
  let riderOnAdminPassed = false;
  adminController.requireAdmin(reqRiderOnAdmin, resRiderOnAdmin, () => { riderOnAdminPassed = true; });
  testAssert(
    riderOnAdminPassed === false && resRiderOnAdmin.getStatusCode() === 401,
    '25. Actual Flow: Rider JWT on Admin route is strictly rejected with 401',
    `adminPassed: ${riderOnAdminPassed}, Status: ${resRiderOnAdmin.getStatusCode()}, Message: ${resRiderOnAdmin.getResponse()?.message}`
  );

  // Test 26: Rider KYC strictly rejects attempt to overwrite an existing Admin account (403 Forbidden)
  const dbAdminUser = (readDb().users || []).find(u => u.role === 'admin') || { phone: '9999999999' };
  const adminPhone = dbAdminUser.phone;
  const { req: reqAdminOverwrite, res: resAdminOverwrite } = mockReqRes({
    body: {
      name: 'Malicious Rider',
      mobileNumber: adminPhone,
      panNumber: 'ABCDE9999F',
      dob: '1995-01-01',
      bikeNumber: 'MP-09-XX-9999'
    }
  });
  await kycController.submitKyc(reqAdminOverwrite, resAdminOverwrite);
  testAssert(
    resAdminOverwrite.getStatusCode() === 403,
    '26. Rider KYC strictly rejects attempt to overwrite an existing Admin account (403 Forbidden)',
    `Status: ${resAdminOverwrite.getStatusCode()}, Message: ${resAdminOverwrite.getResponse()?.message}`
  );

  // Test 27: Rider KYC strictly rejects attempt to overwrite an existing Restaurant account (403 Forbidden)
  const dbRest = (readDb().restaurants || []).find(r => r.phone) || { phone: '9174782706' };
  const restOwnerPhone = dbRest.phone;
  const { req: reqRestOverwrite, res: resRestOverwrite } = mockReqRes({
    body: {
      name: 'Malicious Rider',
      mobileNumber: restOwnerPhone,
      panNumber: 'ABCDE8888F',
      dob: '1995-01-01',
      bikeNumber: 'MP-09-XX-8888'
    }
  });
  await kycController.submitKyc(reqRestOverwrite, resRestOverwrite);
  testAssert(
    resRestOverwrite.getStatusCode() === 403,
    '27. Rider KYC strictly rejects attempt to overwrite an existing Restaurant account (403 Forbidden)',
    `Status: ${resRestOverwrite.getStatusCode()}, Message: ${resRestOverwrite.getResponse()?.message}`
  );

  // Test 28: Authenticated Duplicate Rider KYC submission with same phone reuses existing record and preserves permanentRiderId
  const { req: reqDupKyc, res: resDupKyc } = mockReqRes({
    body: {
      name: 'New Registered Rider Updated',
      mobileNumber: newRiderPhone,
      panNumber: 'ABCDE1234F',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-9999'
    },
    headers: { authorization: `Bearer ${kycSubmitToken}` }
  });
  await kycController.submitKyc(reqDupKyc, resDupKyc);
  const dupPermId = resDupKyc.getResponse()?.permanentRiderId;
  const dbDupCheck = readDb();
  const dupRiderMatches = (dbDupCheck.riders || []).filter(r => r.phone === newRiderPhone);
  testAssert(
    resDupKyc.getStatusCode() === 200 &&
    dupPermId === kycSubmitPermId &&
    dupRiderMatches.length === 1,
    '28. Authenticated duplicate Rider KYC reuses existing record without creating duplicate riders or altering permanentRiderId',
    `Status: ${resDupKyc.getStatusCode()}, Count in DB: ${dupRiderMatches.length}, Original PermId: ${kycSubmitPermId}, Returned PermId: ${dupPermId}`
  );

  // Test 28b: Unauthenticated Rider KYC submission on existing registered phone without session or OTP is strictly rejected with 401
  const { req: reqUnauthDupKyc, res: resUnauthDupKyc } = mockReqRes({
    body: {
      name: 'Attacker Impersonator',
      mobileNumber: newRiderPhone,
      panNumber: 'ATTACK9999Z',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-0000'
    }
  });
  await kycController.submitKyc(reqUnauthDupKyc, resUnauthDupKyc);
  testAssert(
    resUnauthDupKyc.getStatusCode() === 401 && !resUnauthDupKyc.getResponse()?.token,
    '28b. Unauthenticated Rider KYC on existing registered phone is strictly rejected with 401 and no token issued',
    `Status: ${resUnauthDupKyc.getStatusCode()}, Token: ${resUnauthDupKyc.getResponse()?.token || 'None'}`
  );

  // Test 28c: Rider KYC submission with Fake / Unregistered OTP is strictly rejected with 401
  const { req: reqFakeOtpKyc, res: resFakeOtpKyc } = mockReqRes({
    body: {
      name: 'Attacker Fake OTP Impersonator',
      mobileNumber: newRiderPhone,
      panNumber: 'ATTACK9999Z',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-0000',
      otp: '999999' // Arbitrary fake OTP never issued by server
    }
  });
  await kycController.submitKyc(reqFakeOtpKyc, resFakeOtpKyc);
  testAssert(
    resFakeOtpKyc.getStatusCode() === 401 && !resFakeOtpKyc.getResponse()?.token,
    '28c. Rider KYC with Fake OTP is strictly rejected with 401 and NO token issued',
    `Status: ${resFakeOtpKyc.getStatusCode()}, Message: ${resFakeOtpKyc.getResponse()?.message}`
  );

  // Test 28d: Genuine server-side verified OTP allows legitimate KYC update and issues valid signed JWT
  const legitOtp = '543210';
  setServerOtp(newRiderPhone, legitOtp, 10 * 60 * 1000);
  const { req: reqLegitOtpKyc, res: resLegitOtpKyc } = mockReqRes({
    body: {
      name: 'New Registered Rider Verified',
      mobileNumber: newRiderPhone,
      panNumber: 'ABCDE1234F',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-1234',
      otp: legitOtp
    }
  });
  await kycController.submitKyc(reqLegitOtpKyc, resLegitOtpKyc);
  const legitOtpToken = resLegitOtpKyc.getResponse()?.token;
  let decodedLegitOtpToken = null;
  try {
    decodedLegitOtpToken = jwt.verify(legitOtpToken, getJwtSecret());
  } catch (e) {}
  testAssert(
    resLegitOtpKyc.getStatusCode() === 200 &&
    decodedLegitOtpToken &&
    decodedLegitOtpToken.role === 'rider' &&
    resLegitOtpKyc.getResponse()?.permanentRiderId === kycSubmitPermId,
    '28d. Genuine server-side verified OTP successfully authenticates Rider KYC and preserves permanentRiderId',
    `Status: ${resLegitOtpKyc.getStatusCode()}, Role: ${decodedLegitOtpToken?.role}, PermId: ${resLegitOtpKyc.getResponse()?.permanentRiderId}`
  );

  // Test 28e: Single-use OTP verification: Replay of already-used OTP is strictly rejected with 401
  const { req: reqReplayOtpKyc, res: resReplayOtpKyc } = mockReqRes({
    body: {
      name: 'Attacker Replaying Consumed OTP',
      mobileNumber: newRiderPhone,
      panNumber: 'ATTACK9999Z',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-0000',
      otp: legitOtp // Replaying already-consumed OTP
    }
  });
  await kycController.submitKyc(reqReplayOtpKyc, resReplayOtpKyc);
  testAssert(
    resReplayOtpKyc.getStatusCode() === 401 && !resReplayOtpKyc.getResponse()?.token,
    '28e. Single-use OTP guarantee: Replaying an already-consumed OTP is strictly rejected with 401',
    `Status: ${resReplayOtpKyc.getStatusCode()}, Message: ${resReplayOtpKyc.getResponse()?.message}`
  );

  // Test 28f: Expired OTP is strictly rejected with 401
  const expiredOtp = '777777';
  setServerOtp(newRiderPhone, expiredOtp, -1000); // Already expired 1 second ago
  const { req: reqExpiredOtpKyc, res: resExpiredOtpKyc } = mockReqRes({
    body: {
      name: 'Attacker Expired OTP',
      mobileNumber: newRiderPhone,
      panNumber: 'ATTACK9999Z',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-0000',
      otp: expiredOtp
    }
  });
  await kycController.submitKyc(reqExpiredOtpKyc, resExpiredOtpKyc);
  testAssert(
    resExpiredOtpKyc.getStatusCode() === 401 && !resExpiredOtpKyc.getResponse()?.token,
    '28f. Expired OTP is strictly rejected with 401 and NO token issued',
    `Status: ${resExpiredOtpKyc.getStatusCode()}, Message: ${resExpiredOtpKyc.getResponse()?.message}`
  );

  // Test 28g: Phone-bound OTP verification: OTP issued for Phone A cannot be used for Phone B
  const boundOtp = '888888';
  setServerOtp('9826011111', boundOtp, 10 * 60 * 1000); // Issued strictly for 9826011111
  const { req: reqCrossPhoneKyc, res: resCrossPhoneKyc } = mockReqRes({
    body: {
      name: 'Attacker Cross Phone OTP',
      mobileNumber: newRiderPhone, // 9826099999 (different phone)
      panNumber: 'ATTACK9999Z',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-0000',
      otp: boundOtp
    }
  });
  await kycController.submitKyc(reqCrossPhoneKyc, resCrossPhoneKyc);
  testAssert(
    resCrossPhoneKyc.getStatusCode() === 401 && !resCrossPhoneKyc.getResponse()?.token,
    '28g. Phone-bound OTP: OTP issued for one phone cannot be used for another phone (401 Unauthorized)',
    `Status: ${resCrossPhoneKyc.getStatusCode()}, Message: ${resCrossPhoneKyc.getResponse()?.message}`
  );

  // Test 28h: Existing Rider Account Hijack Prevention: Cross-rider JWT or spoofed userId cannot hijack another Rider
  const { req: reqCrossRiderHijack, res: resCrossRiderHijack } = mockReqRes({
    body: {
      userId: rider2User.id, // Attacker passes their own rider userId in body
      name: 'Rider 2 Hijacker',
      mobileNumber: newRiderPhone, // Target victim rider phone
      panNumber: 'ATTACK8888Z',
      dob: '1998-05-15',
      bikeNumber: 'MP-09-AB-8888'
    },
    headers: { authorization: `Bearer ${rider2Token}` } // Attacker's own valid Rider 2 JWT
  });
  await kycController.submitKyc(reqCrossRiderHijack, resCrossRiderHijack);
  testAssert(
    resCrossRiderHijack.getStatusCode() === 401 && !resCrossRiderHijack.getResponse()?.token,
    '28h. Existing Rider hijack prevention: Attacker with different Rider JWT cannot overwrite victim Rider account (401)',
    `Status: ${resCrossRiderHijack.getStatusCode()}, Message: ${resCrossRiderHijack.getResponse()?.message}`
  );

  // ==========================================
  // GROUP 5: ADVANCED IDENTITY & CONCURRENCY GUARDS
  // ==========================================
  console.log('\n--- TEST GROUP 5: ADVANCED IDENTITY & CONCURRENCY GUARDS ---');

  // Test 29: Existing Customer account cannot be converted to Rider role or overwritten by Rider KYC
  const protectedCustPhone = '9826077777';
  const preDb = readDb();
  preDb.users = preDb.users || [];
  // Ensure a genuine customer exists in DB
  let genuineCust = preDb.users.find(u => u.phone === protectedCustPhone);
  if (!genuineCust) {
    genuineCust = {
      id: 'usr_cust_protected_1',
      phone: protectedCustPhone,
      name: 'Genuine Customer Protected',
      email: 'genuine_cust@indfood.app',
      role: 'customer',
      createdAt: new Date().toISOString()
    };
    preDb.users.push(genuineCust);
    writeDb(preDb);
  }

  // Attempt to submit KYC using the genuine customer's phone
  const { req: reqKycOnCust, res: resKycOnCust } = mockReqRes({
    body: {
      name: 'Malicious Rider Identity',
      mobileNumber: protectedCustPhone,
      panNumber: 'ABCDE7777F',
      dob: '1997-03-20',
      bikeNumber: 'MP-09-YY-7777'
    }
  });
  await kycController.submitKyc(reqKycOnCust, resKycOnCust);

  const postKycDb = readDb();
  const verifiedCustUser = postKycDb.users.find(u => u.phone === protectedCustPhone);
  testAssert(
    resKycOnCust.getStatusCode() === 403 &&
    !resKycOnCust.getResponse()?.token &&
    verifiedCustUser &&
    verifiedCustUser.role === 'customer' &&
    verifiedCustUser.name === 'Genuine Customer Protected' &&
    verifiedCustUser.email === 'genuine_cust@indfood.app',
    '29. Existing Customer account role is preserved as customer, unauthenticated KYC rejected with 403, and NO Rider JWT issued',
    `Status: ${resKycOnCust.getStatusCode()}, Token: ${resKycOnCust.getResponse()?.token || 'None'}, Role: ${verifiedCustUser?.role}`
  );

  // Test 30: Concurrent / Parallel KYC requests with same phone create exactly ONE rider and ONE permanentRiderId
  const concurrentPhone = '9826088888';
  const preParallelDb = readDb();
  preParallelDb.riders = (preParallelDb.riders || []).filter(r => r.phone !== concurrentPhone);
  preParallelDb.users = (preParallelDb.users || []).filter(u => u.phone !== concurrentPhone);
  writeDb(preParallelDb);

  const parallelKycRequests = Array.from({ length: 5 }, (_, i) => {
    const { req, res } = mockReqRes({
      body: {
        name: `Concurrent Rider ${i}`,
        mobileNumber: concurrentPhone,
        panNumber: 'ABCDE8888F',
        dob: '1996-08-10',
        bikeNumber: `MP-09-CC-${1000 + i}`
      }
    });
    return Promise.resolve().then(async () => {
      await kycController.submitKyc(req, res);
      return res;
    });
  });

  const parallelResults = await Promise.all(parallelKycRequests);
  const returnedPermIds = new Set(parallelResults.map(r => r.getResponse()?.permanentRiderId));
  const postParallelDb = readDb();
  const parallelRiderCount = (postParallelDb.riders || []).filter(r => r.phone === concurrentPhone).length;
  const parallelUserCount = (postParallelDb.users || []).filter(u => u.phone === concurrentPhone).length;

  testAssert(
    returnedPermIds.size === 1 &&
    parallelRiderCount === 1 &&
    parallelUserCount === 1,
    '30. Parallel KYC requests with same phone create exactly ONE rider and ONE consistent permanentRiderId',
    `Unique Perm IDs: ${returnedPermIds.size}, Riders in DB: ${parallelRiderCount}, Users in DB: ${parallelUserCount}`
  );

  // Test 31: Customer order access strict isolation: Customer B or spoofed query cannot access Customer A order
  // Create an order for Customer A
  const custAUser = { id: 'usr_cust_iso_a', phone: '9826019999', role: 'customer', name: 'Customer A' };
  const custBUser = { id: 'usr_cust_iso_b', phone: '9826022222', role: 'customer', name: 'Customer B' };
  const custAToken = generateUserJwt(custAUser);
  const custBToken = generateUserJwt(custBUser);

  const { req: reqOrderA, res: resOrderA } = mockReqRes({
    body: {
      customerId: custAUser.id,
      customerName: custAUser.name,
      customerPhone: custAUser.phone,
      restaurantId: secRest.id,
      items: [{ id: 'm_dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
      deliveryAddress: 'Customer A Private Home',
      distanceKm: 2.0,
      paymentMethod: 'COD'
    },
    headers: { authorization: `Bearer ${custAToken}` }
  });
  await orderController.createOrder(reqOrderA, resOrderA);
  const orderA = resOrderA.getResponse()?.order;
  assert(orderA, 'Failed to create order for customer isolation test');

  // Customer B attempts access to Customer A's order
  const { req: reqBOnA, res: resBOnA } = mockReqRes({
    params: { orderId: orderA.orderId },
    headers: { authorization: `Bearer ${custBToken}` }
  });
  orderController.getOrderDetails(reqBOnA, resBOnA);

  // Customer B attempts query spoofing (?customerPhone=9826011111)
  const { req: reqSpoofOnA, res: resSpoofOnA } = mockReqRes({
    params: { orderId: orderA.orderId },
    query: { customerPhone: custAUser.phone, customerId: custAUser.id },
    headers: { authorization: `Bearer ${custBToken}`, 'x-customer-phone': custAUser.phone }
  });
  orderController.getOrderDetails(reqSpoofOnA, resSpoofOnA);

  // Unauthenticated caller attempts access
  const { req: reqUnauthOnA, res: resUnauthOnA } = mockReqRes({
    params: { orderId: orderA.orderId }
  });
  orderController.getOrderDetails(reqUnauthOnA, resUnauthOnA);

  // Customer A accesses own order
  const { req: reqAOnA, res: resAOnA } = mockReqRes({
    params: { orderId: orderA.orderId },
    headers: { authorization: `Bearer ${custAToken}` }
  });
  orderController.getOrderDetails(reqAOnA, resAOnA);

  testAssert(
    resBOnA.getStatusCode() === 403 &&
    resSpoofOnA.getStatusCode() === 403 &&
    resUnauthOnA.getStatusCode() === 401 &&
    resAOnA.getStatusCode() === 200 &&
    resAOnA.getResponse()?.order?.deliveryOtp !== undefined,
    '31. Customer order access strict isolation: unauthorized customer & spoofing rejected with 403, unauthenticated with 401, owner with 200',
    `CustB Status: ${resBOnA.getStatusCode()}, Spoof Status: ${resSpoofOnA.getStatusCode()}, Unauth Status: ${resUnauthOnA.getStatusCode()}, Owner Status: ${resAOnA.getStatusCode()}`
  );

  // ==========================================
  // GROUP 6: EXACT ATTACK VECTOR NEGATIVE TEST & MITIGATION
  // ==========================================
  console.log('\n--- TEST GROUP 6: EXACT ATTACK VECTOR NEGATIVE TEST & MITIGATION ---');

  const victimCust = { id: 'usr_victim_exploit_1', phone: '9826055555', role: 'customer', name: 'Victim Customer' };
  const victimCustToken = generateUserJwt(victimCust);

  // Clean any previous test artifacts for victim phone and register genuine customer in db.users
  const dbVictimPre = readDb();
  dbVictimPre.riders = (dbVictimPre.riders || []).filter(r => r.phone !== victimCust.phone);
  dbVictimPre.users = (dbVictimPre.users || []).filter(u => u.phone !== victimCust.phone);
  dbVictimPre.users.push(victimCust);
  writeDb(dbVictimPre);

  // 1. Create a genuine order belonging to Victim Customer
  const { req: reqVictimOrder, res: resVictimOrder } = mockReqRes({
    body: {
      customerId: victimCust.id,
      customerName: victimCust.name,
      customerPhone: victimCust.phone,
      restaurantId: secRest.id,
      items: [{ id: 'm_dish_1', name: 'Paneer Butter Masala', price: 200, quantity: 1 }],
      deliveryAddress: 'Victim Customer Home Address',
      distanceKm: 2.0,
      paymentMethod: 'COD'
    },
    headers: { authorization: `Bearer ${victimCustToken}` }
  });
  await orderController.createOrder(reqVictimOrder, resVictimOrder);
  const victimOrder = resVictimOrder.getResponse()?.order;
  assert(victimOrder && victimOrder.orderId, 'Failed to create victim test order');

  // Step 2 of Attack: Attacker tries unauthenticated Rider KYC with victim customer's phone
  const { req: reqAttackerKyc, res: resAttackerKyc } = mockReqRes({
    body: {
      name: 'Malicious Attacker Rider',
      mobileNumber: victimCust.phone,
      panNumber: 'ABCDE5555F',
      dob: '1995-05-05',
      bikeNumber: 'MP-09-EV-5555'
    }
  });
  await kycController.submitKyc(reqAttackerKyc, resAttackerKyc);
  testAssert(
    resAttackerKyc.getStatusCode() === 403 && !resAttackerKyc.getResponse()?.token,
    '32a. [Attack Step 1 Mitigation] Unauthenticated Rider KYC using victim Customer phone is strictly REJECTED (403 Forbidden, NO JWT issued)',
    `Status: ${resAttackerKyc.getStatusCode()}, Token: ${resAttackerKyc.getResponse()?.token || 'None'}, Message: ${resAttackerKyc.getResponse()?.message}`
  );

  // Step 2b: Attacker tries riderLogin with victim customer's phone
  const { req: reqAttackerRiderLogin, res: resAttackerRiderLogin } = mockReqRes({
    body: { phone: victimCust.phone }
  });
  kycController.riderLogin(reqAttackerRiderLogin, resAttackerRiderLogin);
  testAssert(
    resAttackerRiderLogin.getStatusCode() === 403 && !resAttackerRiderLogin.getResponse()?.token,
    '32b. [Rider Login Exploit Mitigation] Rider login using victim Customer phone is strictly REJECTED (403 Forbidden)',
    `Status: ${resAttackerRiderLogin.getStatusCode()}, Token: ${resAttackerRiderLogin.getResponse()?.token || 'None'}`
  );

  // Step 3 of Attack: Attacker with Rider JWT (even if phone matches victim customer) attempts to access victim's order
  const attackerRiderToken = generateUserJwt({
    id: 'usr_rd_attacker_1',
    phone: victimCust.phone,
    role: 'rider',
    name: 'Attacker Rider',
    permanentRiderId: 'INDF-RD-ATTACK'
  });
  const { req: reqAttackerOrderAccess, res: resAttackerOrderAccess } = mockReqRes({
    params: { orderId: victimOrder.orderId },
    headers: { authorization: `Bearer ${attackerRiderToken}` }
  });
  orderController.getOrderDetails(reqAttackerOrderAccess, resAttackerOrderAccess);
  testAssert(
    resAttackerOrderAccess.getStatusCode() === 403,
    '32c. [Attack Step 2 Mitigation] Rider role attempting to access victim Customer order is REJECTED (403 Forbidden - Not assigned rider)',
    `Status: ${resAttackerOrderAccess.getStatusCode()}, Message: ${resAttackerOrderAccess.getResponse()?.message}`
  );

  // Step 4: Even when a rider IS assigned to the order, deliveryOtp is NEVER leaked to the rider
  const dbForAssign = readDb();
  const dbVictimOrder = dbForAssign.orders.find(o => o.orderId === victimOrder.orderId);
  dbVictimOrder.assignedRider = {
    userId: 'usr_rd_assigned_legit',
    permanentRiderId: 'legitperm789',
    phone: '9826044444',
    name: 'Legitimate Assigned Rider'
  };
  writeDb(dbForAssign);

  const assignedRiderToken = generateUserJwt({
    id: 'usr_rd_assigned_legit',
    phone: '9826044444',
    role: 'rider',
    name: 'Legitimate Assigned Rider',
    permanentRiderId: 'legitperm789'
  });
  const { req: reqLegitRiderAccess, res: resLegitRiderAccess } = mockReqRes({
    params: { orderId: victimOrder.orderId },
    headers: { authorization: `Bearer ${assignedRiderToken}` }
  });
  orderController.getOrderDetails(reqLegitRiderAccess, resLegitRiderAccess);
  const legitRiderOrder = resLegitRiderAccess.getResponse()?.order;
  testAssert(
    resLegitRiderAccess.getStatusCode() === 200 && legitRiderOrder && legitRiderOrder.deliveryOtp === undefined,
    '32d. [Delivery OTP Sanitization] Assigned Rider receives sanitized order with sensitive deliveryOtp stripped',
    `Status: ${resLegitRiderAccess.getStatusCode()}, deliveryOtp present: ${legitRiderOrder?.deliveryOtp !== undefined}`
  );

  // Step 5: Genuine Customer owner accesses their order and receives deliveryOtp
  const { req: reqVictimOwnerAccess, res: resVictimOwnerAccess } = mockReqRes({
    params: { orderId: victimOrder.orderId },
    headers: { authorization: `Bearer ${victimCustToken}` }
  });
  orderController.getOrderDetails(reqVictimOwnerAccess, resVictimOwnerAccess);
  const victimOwnerOrder = resVictimOwnerAccess.getResponse()?.order;
  testAssert(
    resVictimOwnerAccess.getStatusCode() === 200 && victimOwnerOrder && Boolean(victimOwnerOrder.deliveryOtp),
    '32e. [Genuine Owner Access] Genuine Customer owner successfully accesses order with verified deliveryOtp intact',
    `Status: ${resVictimOwnerAccess.getStatusCode()}, deliveryOtp: ${victimOwnerOrder?.deliveryOtp}`
  );

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passed}/${passed + failed} TESTS PASSED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSecurityTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
