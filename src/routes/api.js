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
router.get('/rider/dashboard-stats', kycController.getRiderDashboardStats);
router.post('/rider/toggle-status', kycController.toggleRiderOnlineStatus);
router.post('/kyc/approve', adminController.requireAdmin, kycController.approveKyc); // Admin gated
router.post('/kyc/reject', adminController.requireAdmin, kycController.rejectKyc);   // Admin gated
router.get('/kyc/pending', adminController.requireAdmin, kycController.getPendingKycList); // Admin gated

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
router.post('/orders/generate-cod-qr', orderController.generateCodQr);
router.post('/orders/check-cod-qr', orderController.checkCodQrPayment);
router.post('/orders/cancel-unpaid', orderController.cancelUnpaidOrder);
router.post('/orders/verify-payment', paymentController.verifyPayment);

// 4b. Promo Code & Flash Discount routes
router.post('/promocodes/broadcast', promoController.broadcastPromoCode);
router.get('/promocodes/active', promoController.getActivePromoCodes);
router.get('/promocodes/admin', promoController.getAllPromoCodesAdmin);
router.post('/promocodes/apply', promoController.applyPromoCode);
router.post('/promocodes/toggle', promoController.togglePromoStatus);

// 5. Razorpay Payment routes
router.get('/payment/key', paymentController.getRazorpayKey);
router.post('/payment/verify', paymentController.verifyPayment);
router.post('/orders/razorpay-webhook', paymentController.handleRazorpayWebhook);
router.post('/payments/webhook', paymentController.handleRazorpayWebhook);

// 6. Restaurant routes
router.get('/restaurants', restaurantController.getAllRestaurants);
router.post('/restaurants/register', restaurantController.registerRestaurant);
router.post('/restaurants/update-location', restaurantController.updateRestaurantLocation);
router.get('/restaurants/:id', restaurantController.getRestaurantById);
router.post('/restaurants/menu', restaurantController.addMenuItem);
router.post('/restaurants/menu/toggle', restaurantController.toggleItemAvailability);
router.post('/restaurants/toggle-status', restaurantController.toggleRestaurantStatus);

// 7. Admin routes (Protected by requireAdmin)
router.get('/settings', adminController.getSettings);
router.get('/admin/dashboard', adminController.requireAdmin, adminController.getDashboardStats);
router.get('/admin/settings', adminController.requireAdmin, adminController.getSettings);
router.post('/admin/settings', adminController.requireAdmin, adminController.updateSettings);
router.get('/admin/restaurants', adminController.requireAdmin, adminController.getAdminRestaurants);
router.post('/admin/restaurant-commission', adminController.requireAdmin, adminController.updateRestaurantCommission);
router.post('/admin/commission', adminController.requireAdmin, adminController.updatePlatformCommission);
router.post('/admin/reset-database', adminController.requireAdmin, adminController.resetDatabase);
router.get('/admin/rider-lookup', adminController.requireAdmin, adminController.lookupRider);
router.post('/admin/rider-toggle-block', adminController.requireAdmin, adminController.toggleBlockRider);

module.exports = router;
