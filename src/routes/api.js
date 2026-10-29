const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const kycController = require('../controllers/kycController');
const shiftController = require('../controllers/shiftController');
const orderController = require('../controllers/orderController');
const paymentController = require('../controllers/paymentController');
const restaurantController = require('../controllers/restaurantController');
const adminController = require('../controllers/adminController');
const promoController = require('../controllers/promoController');

// 1. Auth routes (Real Google & Email Authentication)
router.post('/auth/send-otp', authController.sendEmailOtp);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/register', authController.registerUser);
router.post('/auth/login-email', authController.loginEmail);
router.post('/auth/google', authController.googleLogin);
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/reset-password', authController.resetPassword);
router.post('/auth/login', authController.loginOrRegister);
router.get('/auth/profile/:userId', authController.getUserProfile);

// 2. KYC & Rider Auth routes (Delivery Partner)
router.post('/kyc/submit', kycController.submitKyc);
router.post('/rider/login', kycController.riderLogin);
router.get('/kyc/status', kycController.getRiderStatus);
router.post('/kyc/approve', kycController.approveKyc); // generates permanent random ID (INDF-RD-XXXXX)
router.post('/kyc/reject', kycController.rejectKyc);
router.get('/kyc/pending', kycController.getPendingKycList);

// 3. Shift routes (Delivery Partner)
router.get('/shifts', shiftController.getShifts);
router.post('/shifts/book', shiftController.bookShift);
router.post('/shifts/cancel', shiftController.cancelShift);
router.post('/shifts/slots', shiftController.updateShiftSlots);

// 4. Order routes (Customer, Restaurant, Delivery Partner)
router.post('/orders', orderController.createOrder);
router.get('/orders', orderController.listOrders);
router.get('/orders/:orderId', orderController.getOrderDetails);
router.post('/orders/status', orderController.updateOrderStatus);
router.post('/orders/accept-rider', orderController.riderAcceptOrder);
router.post('/orders/arrive-restaurant', orderController.riderArriveRestaurant);
router.post('/orders/handover', orderController.restaurantConfirmHandover);
router.post('/orders/pickup', orderController.riderPickupOrder);
router.post('/orders/reject-rider', orderController.riderRejectOrder);
router.post('/orders/deliver', orderController.completeDelivery);
router.post('/orders/verify-otp', orderController.verifyDeliveryOtp);
router.post('/orders/rider-location', orderController.updateRiderLocation);

// 4b. Promo Code & Flash Discount routes
router.post('/promocodes/broadcast', promoController.broadcastPromoCode);
router.get('/promocodes/active', promoController.getActivePromoCodes);
router.get('/promocodes/admin', promoController.getAllPromoCodesAdmin);
router.post('/promocodes/apply', promoController.applyPromoCode);
router.post('/promocodes/toggle', promoController.togglePromoStatus);

// 5. Razorpay Payment routes
router.get('/payment/key', paymentController.getRazorpayKey);
router.post('/payment/verify', paymentController.verifyPayment);

// 6. Restaurant routes
router.get('/restaurants', restaurantController.getAllRestaurants);
router.post('/restaurants/register', restaurantController.registerRestaurant);
router.post('/restaurants/update-location', restaurantController.updateRestaurantLocation);
router.get('/restaurants/:id', restaurantController.getRestaurantById);
router.post('/restaurants/menu', restaurantController.addMenuItem);
router.post('/restaurants/menu/toggle', restaurantController.toggleItemAvailability);
router.post('/restaurants/toggle-status', restaurantController.toggleRestaurantStatus);

// 7. Admin routes
router.get('/admin/dashboard', adminController.getDashboardStats);
router.post('/admin/commission', adminController.updatePlatformCommission);
router.post('/admin/reset-database', adminController.resetDatabase);
router.get('/admin/rider-lookup', adminController.lookupRider);
router.post('/admin/rider-toggle-block', adminController.toggleBlockRider);

module.exports = router;
