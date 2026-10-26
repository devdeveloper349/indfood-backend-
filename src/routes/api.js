const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const kycController = require('../controllers/kycController');
const shiftController = require('../controllers/shiftController');
const orderController = require('../controllers/orderController');
const paymentController = require('../controllers/paymentController');
const restaurantController = require('../controllers/restaurantController');
const adminController = require('../controllers/adminController');

// 1. Auth routes
router.post('/auth/login', authController.loginOrRegister);
router.get('/auth/profile/:userId', authController.getUserProfile);

// 2. KYC routes (Delivery Partner)
router.post('/kyc/submit', kycController.submitKyc);
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
router.post('/orders/reject-rider', orderController.riderRejectOrder);
router.post('/orders/deliver', orderController.completeDelivery);
router.post('/orders/verify-otp', orderController.verifyDeliveryOtp);

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

module.exports = router;
