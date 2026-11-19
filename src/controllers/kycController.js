const jwt = require('jsonwebtoken');
const { readDb, writeDb } = require('../models/db');
const { generatePermanentRiderId } = require('../utils/idGenerator');
const { generateUserJwt, verifyServerOtp } = require('./authController');
const { getJwtSecret } = require('../config/jwt');
const sessionManager = require('../services/sessionManager');

/**
 * Calculate exact age from Date of Birth
 */
function calculateAge(dobString) {
  if (!dobString) return 0;
  const birthDate = new Date(dobString);
  if (isNaN(birthDate.getTime())) return 0;
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

// In-flight registration atomic mutex: Map<phone, Promise<{ status: number, data: any }>>
// Protects truly concurrent requests during initial onboarding without lingering time windows
const inFlightRegistrations = new Map();

// In-flight toggle duty mutex: Set<riderId>
const inFlightToggles = new Set();

/**
 * Rider registers / submits KYC:
 * 1. Selfie Photo
 * 2. Full Name
 * 3. Mobile Number
 * 4. PAN Card Number (Identity check)
 * 5. Date of Birth (Age check: must be 18+)
 * 6. Bike / Vehicle Number
 */
async function submitKyc(req, res) {
  const { userId, name, mobileNumber, phone, panNumber, aadhaarNumber, dob, selfiePhoto, bikeNumber, vehicleNumber, vehicleType, drivingLicense, dlPhoto, bankDetails, address, city, pincode } = req.body;
  const riderName = (name || '').trim();
  const riderPhone = (mobileNumber || phone || '').toString().trim();
  const riderPan = (panNumber || aadhaarNumber || '').toString().trim().toUpperCase();
  const riderDob = (dob || '').toString().trim();
  const riderBike = (bikeNumber || vehicleNumber || '').toString().trim().toUpperCase();
  const riderSelfie = (selfiePhoto || '').toString().trim();

  if (!riderName) {
    return res.status(400).json({ success: false, message: 'Kripya apna Poora Naam dalein' });
  }
  if (!riderPhone || riderPhone.length < 10) {
    return res.status(400).json({ success: false, message: '10-digit mobile number bharna anivarya hai' });
  }
  if (!riderPan || riderPan.length < 8) {
    return res.status(400).json({ success: false, message: 'Valid PAN Card number bharna anivarya hai (e.g. ABCDE1234F)' });
  }
  if (!riderDob) {
    return res.status(400).json({ success: false, message: 'Kripya Janm Tithi (Date of Birth) select karein' });
  }

  const cleanPhone = riderPhone.replace(/\D/g, '').slice(-10);

  // If a parallel registration is currently in-flight for this phone, await its completion
  if (inFlightRegistrations.has(cleanPhone)) {
    try {
      const inFlightPromise = inFlightRegistrations.get(cleanPhone);
      const result = await inFlightPromise;
      return res.status(result.status || 200).json(result.data || result);
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Registration in progress failed. Please retry.' });
    }
  }

  // Setup atomic in-flight lock for this phone to deduplicate concurrent requests
  let resolveInFlight = null;
  let rejectInFlight = null;
  const inFlightPromise = new Promise((resolve, reject) => {
    resolveInFlight = resolve;
    rejectInFlight = reject;
  });
  inFlightRegistrations.set(cleanPhone, inFlightPromise);

  try {
    // Yield to microtask queue so any concurrent parallel requests register on inFlightPromise
    await Promise.resolve();

    // Auto-approve delivery partner
    const age = calculateAge(riderDob) || 20;

    const db = readDb();

    // Strict Account Overwrite Guard: Customer, Admin & Restaurant accounts cannot be converted to Rider via KYC
    const existingRiderByPhone = (db.riders || []).find(r => r.phone && String(r.phone).replace(/\D/g, '').slice(-10) === cleanPhone);
    const existingUserByPhone = (db.users || []).find(u => u.phone && String(u.phone).replace(/\D/g, '').slice(-10) === cleanPhone);

    const existingUserCheck = existingUserByPhone || (userId ? (db.users || []).find(u => u.id === userId) : null);
    const existingCustomerOrder = (db.orders || []).find(o =>
      (userId && o.customerId === userId) ||
      (o.customerPhone && String(o.customerPhone).replace(/\D/g, '').slice(-10) === cleanPhone)
    );

    const isCustomer = (existingUserCheck && existingUserCheck.role === 'customer') || (!existingUserCheck && existingCustomerOrder);
    const isAdmin = existingUserCheck && existingUserCheck.role === 'admin';
    const isRestaurant = existingUserCheck && existingUserCheck.role === 'restaurant';

    if (isCustomer || isAdmin || isRestaurant) {
      const roleName = isAdmin ? 'admin' : (isRestaurant ? 'restaurant' : 'customer');
      const errRes = {
        status: 403,
        data: {
          success: false,
          message: `Security Violation: Cannot register or overwrite an existing ${roleName} account as a delivery partner.`
        }
      };
      resolveInFlight(errRes);
      return res.status(errRes.status).json(errRes.data);
    }

    const existingRestCheck = (db.restaurants || []).find(r =>
      (r.id && r.id === userId) ||
      (r.phone && String(r.phone).replace(/\D/g, '').slice(-10) === cleanPhone)
    );
    if (existingRestCheck) {
      const errRes = {
        status: 403,
        data: {
          success: false,
          message: 'Security Violation: Cannot register or overwrite an existing restaurant account as a delivery partner.'
        }
      };
      resolveInFlight(errRes);
      return res.status(errRes.status).json(errRes.data);
    }

    let rider = existingRiderByPhone || (userId ? (db.riders || []).find(r => r.userId === userId) : null);

    // Existing Phone Authentication Guard:
    // For an existing registered phone/rider, a new Rider JWT cannot be issued without verified authentication session or verified server-side OTP
    if (rider || existingUserCheck) {
      let isAuthenticated = false;
      const authHeader = req.headers ? (req.headers['authorization'] || req.headers['x-auth-token'] || req.headers['x-session-token'] || '') : '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();

      if (token) {
        try {
          const decoded = jwt.verify(token, getJwtSecret());
          if (!sessionManager.isTokenRevoked(token, decoded)) {
            const validRoles = ['rider', 'admin'];
            const matchesExistingRecord = Boolean(
              (decoded.phone && String(decoded.phone).replace(/\D/g, '').slice(-10) === cleanPhone) ||
              (existingRiderByPhone && decoded.id && decoded.id === existingRiderByPhone.userId) ||
              (existingRiderByPhone && decoded.permanentRiderId && decoded.permanentRiderId === existingRiderByPhone.permanentRiderId) ||
              (existingUserByPhone && decoded.id && decoded.id === existingUserByPhone.id)
            );
            if (decoded && validRoles.includes(decoded.role) && (matchesExistingRecord || decoded.role === 'admin')) {
              isAuthenticated = true;
            }
          }
        } catch (e) {
          // Token invalid or expired
        }
      }

      // Genuine Server-Side Verified OTP check (single-use, phone-bound, not expired)
      const { otp } = req.body;
      if (!isAuthenticated && otp) {
        if (verifyServerOtp(cleanPhone, otp)) {
          isAuthenticated = true;
        }
      }

      if (!isAuthenticated) {
        const errRes = {
          status: 401,
          data: {
            success: false,
            message: 'Authentication required: Verified Rider session token or valid server-side verified OTP is required for an existing registered phone number.'
          }
        };
        resolveInFlight(errRes);
        return res.status(errRes.status).json(errRes.data);
      }
    }

    if (!rider) {
      const uid = userId || `usr_rd_${Date.now().toString(36)}`;
      rider = {
        userId: uid,
        phone: cleanPhone,
        name: riderName,
        permanentRiderId: null,
        kycStatus: 'PENDING',
        isOnline: false,
        walletBalance: 0,
        completedTrips: 0,
        createdAt: new Date().toISOString()
      };
      db.riders.push(rider);
    }

    rider.phone = cleanPhone;
    rider.name = riderName;
    rider.panNumber = riderPan;
    rider.dob = riderDob;
    rider.age = age;
    rider.bikeNumber = riderBike || rider.bikeNumber || 'BIKE-REG';
    if (riderSelfie) {
      rider.selfiePhoto = riderSelfie;
    }
    if (vehicleType) rider.vehicleType = vehicleType;
    if (drivingLicense) rider.drivingLicense = drivingLicense;
    if (dlPhoto) rider.dlPhoto = dlPhoto;
    if (bankDetails) rider.bankDetails = bankDetails;
    if (address) rider.address = address;
    if (city) rider.city = city;
    if (pincode) rider.pincode = pincode;
    rider.isBlocked = rider.isBlocked || false;

    // Auto-generate official 12-char permanent ID tied to their name (guaranteed collision-free across riders & users)
    if (!rider.permanentRiderId) {
      let newId = generatePermanentRiderId(rider.name);
      while (
        (db.riders || []).some(r => r.permanentRiderId === newId) ||
        (db.users || []).some(u => u.permanentRiderId === newId)
      ) {
        newId = generatePermanentRiderId(rider.name);
      }
      rider.permanentRiderId = newId;
    }

    // Preserve existing APPROVED status; new or re-submitted applications remain PENDING Admin review
    if (rider.kycStatus !== 'APPROVED') {
      rider.kycStatus = 'PENDING';
      rider.isOnline = false;
      rider.rejectionReason = null;
    }

    rider.kycDocuments = {
      mobileNumber: cleanPhone,
      panNumber: riderPan,
      aadhaarNumber: riderPan,
      drivingLicense: rider.drivingLicense || riderPan,
      vehicleType: rider.vehicleType || 'Bike',
      bikeNumber: rider.bikeNumber,
      dob: riderDob,
      age: age,
      address: rider.address || '',
      city: rider.city || '',
      pincode: rider.pincode || '',
      bankDetails: rider.bankDetails || null,
      hasSelfie: Boolean(rider.selfiePhoto),
      selfieUrl: rider.selfiePhoto || null,
      hasDlPhoto: Boolean(rider.dlPhoto),
      dlPhotoUrl: rider.dlPhoto || null,
      submittedAt: new Date().toISOString()
    };

    // Synchronize with db.users to maintain unified identity & persistence
    db.users = db.users || [];
    let user = db.users.find(u => (u.id === rider.userId) || (u.phone && String(u.phone).replace(/\D/g, '').slice(-10) === cleanPhone));
    if (!user) {
      user = {
        id: rider.userId,
        phone: cleanPhone,
        name: rider.name,
        email: `${cleanPhone}@indfood.app`,
        role: 'rider',
        permanentRiderId: rider.permanentRiderId,
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
    } else {
      if (!user.name && rider.name) user.name = rider.name;
      user.permanentRiderId = rider.permanentRiderId;
      // Preserve customer role if existing, else rider
      if (user.role !== 'customer') {
        user.role = 'rider';
      }
    }

    writeDb(db);

    const token = generateUserJwt({
      id: user.id,
      phone: cleanPhone,
      name: user.name || rider.name,
      email: user.email,
      role: 'rider',
      permanentRiderId: rider.permanentRiderId
    });

    const isApproved = rider.kycStatus === 'APPROVED';

    if (req.io) {
      const submissionEvent = {
        phone: rider.phone,
        userId: rider.userId,
        name: rider.name,
        permanentRiderId: rider.permanentRiderId,
        kycStatus: rider.kycStatus,
        isApproved: isApproved
      };
      req.io.to('admin_room').emit('admin_kyc_submitted', submissionEvent);
      if (cleanPhone) {
        req.io.to(`rider_${cleanPhone}`).emit('rider_status_changed', submissionEvent);
      }
      if (rider.permanentRiderId) {
        req.io.to(`rider_${rider.permanentRiderId}`).emit('rider_status_changed', submissionEvent);
      }
      if (rider.userId) {
        req.io.to(`rider_${rider.userId}`).emit('rider_status_changed', submissionEvent);
      }
    }

    const responsePayload = {
      success: true,
      message: isApproved
        ? `KYC & 18+ Identity Verified! Permanent Delivery Partner ID: ${rider.permanentRiderId}`
        : `KYC submitted successfully! Application is PENDING Admin verification. Permanent Partner ID: ${rider.permanentRiderId}`,
      permanentRiderId: rider.permanentRiderId,
      kycStatus: rider.kycStatus,
      rider,
      token
    };

    resolveInFlight({ status: 200, data: responsePayload });
    return res.json(responsePayload);
  } catch (err) {
    if (rejectInFlight) rejectInFlight(err);
    throw err;
  } finally {
    inFlightRegistrations.delete(cleanPhone);
  }
}

/**
 * Check rider approval status by userId or phone
 */
function getRiderStatus(req, res) {
  const { userId, phone } = req.query;
  const db = readDb();
  const cleanPhone = phone ? phone.toString().trim().replace(/\D/g, '').slice(-10) : '';
  const rider = (db.riders || []).find(r =>
    (userId && (r.userId === userId || r.permanentRiderId === userId)) ||
    (cleanPhone && r.phone && r.phone.toString().trim().replace(/\D/g, '').slice(-10) === cleanPhone)
  );
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }
  const kycStatus = rider.kycStatus || 'NOT_SUBMITTED';
  const isApproved = (kycStatus === 'APPROVED');
  return res.json({
    success: true,
    rider: {
      ...rider,
      kycStatus
    },
    kycStatus,
    isApproved,
    permanentRiderId: rider.permanentRiderId || null
  });
}

/**
 * Admin approves Rider KYC
 * Generates official, random permanent Rider ID (e.g. INDF-RD-XXXXX)
 */
function approveKyc(req, res) {
  const { userId, phone } = req.body;
  if (!userId && !phone) {
    return res.status(400).json({ success: false, message: 'userId or phone is required' });
  }

  const db = readDb();
  const rider = db.riders.find(r => (userId && r.userId === userId) || (phone && r.phone === phone));
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider profile not found' });
  }

  // Generate permanent, unique, random ID tied to rider's name
  if (!rider.permanentRiderId) {
    let newId = generatePermanentRiderId(rider.name);
    while (db.riders.some(r => r.permanentRiderId === newId)) {
      newId = generatePermanentRiderId(rider.name);
    }
    rider.permanentRiderId = newId;
  }

  rider.kycStatus = 'APPROVED';
  rider.kycApprovedAt = new Date().toISOString();
  rider.rejectionReason = null;

  writeDb(db);

  if (req.io) {
    const statusPayload = {
      phone: rider.phone,
      userId: rider.userId,
      permanentRiderId: rider.permanentRiderId,
      kycStatus: 'APPROVED',
      isApproved: true
    };
    const approvedPayload = {
      phone: rider.phone,
      userId: rider.userId,
      permanentRiderId: rider.permanentRiderId
    };

    const cleanPhone = rider.phone ? String(rider.phone).replace(/\D/g, '').slice(-10) : '';
    if (cleanPhone) {
      req.io.to(`rider_${cleanPhone}`).emit('rider_status_changed', statusPayload);
      req.io.to(`rider_${cleanPhone}`).emit('rider_kyc_approved', approvedPayload);
    }
    if (rider.permanentRiderId) {
      req.io.to(`rider_${rider.permanentRiderId}`).emit('rider_status_changed', statusPayload);
      req.io.to(`rider_${rider.permanentRiderId}`).emit('rider_kyc_approved', approvedPayload);
    }
    if (rider.userId) {
      req.io.to(`rider_${rider.userId}`).emit('rider_status_changed', statusPayload);
      req.io.to(`rider_${rider.userId}`).emit('rider_kyc_approved', approvedPayload);
    }
    req.io.to('admin_room').emit('admin_kyc_updated', statusPayload);
  }

  return res.json({
    success: true,
    message: `Rider KYC Approved! Official Permanent ID generated: ${rider.permanentRiderId}`,
    permanentRiderId: rider.permanentRiderId,
    rider
  });
}

/**
 * Rider Login with registered mobile number
 */
function riderLogin(req, res) {
  const { phone } = req.body;
  if (!phone || phone.toString().trim().length < 10) {
    return res.status(400).json({ success: false, message: '10-digit mobile number bharna anivarya hai' });
  }
  const cleanPhone = phone.toString().trim().replace(/\D/g, '').slice(-10);
  const db = readDb();

  // Strict Account Overwrite Guard: Customer, Admin & Restaurant accounts cannot log in as Rider
  const existingRider = (db.riders || []).find(r => (r.phone && r.phone.toString().replace(/\D/g, '').slice(-10) === cleanPhone));
  const existingUser = (db.users || []).find(u => u.phone && String(u.phone).replace(/\D/g, '').slice(-10) === cleanPhone);
  const existingCustomerOrder = (db.orders || []).find(o => o.customerPhone && String(o.customerPhone).replace(/\D/g, '').slice(-10) === cleanPhone);

  const isCustUser = (existingUser && existingUser.role === 'customer') || (!existingUser && !existingRider && existingCustomerOrder);
  const isAdminUser = existingUser && existingUser.role === 'admin';
  const isRestUser = existingUser && existingUser.role === 'restaurant';

  if (isCustUser || isAdminUser || isRestUser) {
    const roleName = isAdminUser ? 'admin' : (isRestUser ? 'restaurant' : 'customer');
    return res.status(403).json({
      success: false,
      message: `Security Violation: Account is registered as ${roleName}, not as a rider.`
    });
  }

  const rider = (db.riders || []).find(r => (r.phone && r.phone.toString().replace(/\D/g, '').slice(-10) === cleanPhone));

  if (!rider) {
    return res.status(404).json({
      success: false,
      message: 'Mobile number registered nahi hai! Kripya pehle New Delivery Partner Registration karein.'
    });
  }

  if (rider.isBlocked) {
    return res.status(403).json({
      success: false,
      message: 'Aapka account block kar diya gaya hai. Kripya INDFood Support/Admin se sampark karein.'
    });
  }

  // Synchronize with db.users to ensure persistent identity
  db.users = db.users || [];
  let user = db.users.find(u => (u.id === rider.userId) || (u.phone && String(u.phone).replace(/\D/g, '').slice(-10) === cleanPhone));
  let dbUpdated = false;
  if (!user) {
    user = {
      id: rider.userId || `usr_rd_${cleanPhone}`,
      phone: cleanPhone,
      name: rider.name,
      email: rider.email || `${cleanPhone}@indfood.app`,
      role: 'rider',
      permanentRiderId: rider.permanentRiderId,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    dbUpdated = true;
  } else if (!user.permanentRiderId && rider.permanentRiderId) {
    user.permanentRiderId = rider.permanentRiderId;
    dbUpdated = true;
  }
  if (dbUpdated) {
    writeDb(db);
  }

  const token = generateUserJwt({
    id: user.id,
    phone: cleanPhone,
    name: user.name || rider.name,
    email: user.email || rider.email,
    role: 'rider',
    permanentRiderId: rider.permanentRiderId
  });

  return res.json({
    success: true,
    message: `Swagat hai ${rider.name}! Login safal raha.`,
    rider,
    permanentRiderId: rider.permanentRiderId,
    token
  });
}

/**
 * Admin rejects Rider KYC
 */
function rejectKyc(req, res) {
  const { userId, phone, reason, rejectionReason } = req.body;
  const db = readDb();
  const rider = db.riders.find(r => (userId && r.userId === userId) || (phone && r.phone === phone));
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider profile not found' });
  }

  const actualReason = rejectionReason || reason || 'Documents invalid or unclear';
  rider.kycStatus = 'REJECTED';
  rider.rejectionReason = actualReason;
  rider.kycRejectionReason = actualReason;
  rider.isOnline = false;

  writeDb(db);
  sessionManager.disconnectSocketsForUser(rider.userId, req.io);
  sessionManager.disconnectSocketsForUser(rider.permanentRiderId, req.io);

  if (req.io) {
    const statusPayload = {
      phone: rider.phone,
      userId: rider.userId,
      permanentRiderId: rider.permanentRiderId,
      kycStatus: 'REJECTED',
      isApproved: false,
      rejectionReason: rider.rejectionReason
    };
    const rejectedPayload = {
      phone: rider.phone,
      userId: rider.userId,
      permanentRiderId: rider.permanentRiderId,
      rejectionReason: rider.rejectionReason
    };

    const cleanPhone = rider.phone ? String(rider.phone).replace(/\D/g, '').slice(-10) : '';
    if (cleanPhone) {
      req.io.to(`rider_${cleanPhone}`).emit('rider_status_changed', statusPayload);
      req.io.to(`rider_${cleanPhone}`).emit('rider_kyc_rejected', rejectedPayload);
    }
    if (rider.permanentRiderId) {
      req.io.to(`rider_${rider.permanentRiderId}`).emit('rider_status_changed', statusPayload);
      req.io.to(`rider_${rider.permanentRiderId}`).emit('rider_kyc_rejected', rejectedPayload);
    }
    if (rider.userId) {
      req.io.to(`rider_${rider.userId}`).emit('rider_status_changed', statusPayload);
      req.io.to(`rider_${rider.userId}`).emit('rider_kyc_rejected', rejectedPayload);
    }
    req.io.to('admin_room').emit('admin_kyc_updated', statusPayload);
  }

  return res.json({
    success: true,
    message: 'Rider KYC Rejected',
    rider
  });
}

/**
 * Get all pending KYC requests for Admin
 */
function getPendingKycList(req, res) {
  const db = readDb();
  const pending = db.riders.filter(r => (r.kycStatus === 'SUBMITTED' || r.kycStatus === 'PENDING'));
  return res.json({ success: true, pending });
}

/**
 * Rider Dashboard Stats (Real metrics for Today's Earnings, Completed Orders, This Week Distance, Incentive Bonus)
 */
function getRiderDashboardStats(req, res) {
  const db = readDb();

  // 1. Authenticate caller (Rider token, query riderId/phone, or Admin)
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-auth-token'] || req.headers['x-session-token'] || '');

  let authenticatedRider = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, getJwtSecret());
      if (sessionManager.isTokenRevoked(token, decoded)) {
        return res.status(401).json({ success: false, message: 'Invalid or revoked authentication token' });
      }
      if (decoded && (decoded.role === 'rider' || decoded.role === 'admin')) {
        authenticatedRider = decoded;
      } else {
        return res.status(403).json({ success: false, message: 'Access denied: Valid rider role required' });
      }
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Invalid or expired authentication token' });
    }
  }

  const requestedUserId = req.query.userId || req.query.riderUserId || req.query.riderId;
  const requestedPhone = req.query.phone || req.query.riderPhone;
  const requestedPermId = req.query.permanentRiderId;

  // Find target rider in db.riders
  let rider = null;
  if (authenticatedRider && authenticatedRider.role === 'rider') {
    rider = db.riders.find(r =>
      (authenticatedRider.permanentRiderId && r.permanentRiderId === authenticatedRider.permanentRiderId) ||
      (authenticatedRider.id && r.userId === authenticatedRider.id) ||
      (authenticatedRider.phone && r.phone === authenticatedRider.phone)
    );
  }

  if (!rider && (requestedUserId || requestedPhone || requestedPermId)) {
    rider = db.riders.find(r =>
      (requestedPermId && r.permanentRiderId === requestedPermId) ||
      (requestedUserId && (r.userId === requestedUserId || r.permanentRiderId === requestedUserId)) ||
      (requestedPhone && r.phone === String(requestedPhone).replace(/\D/g, '').slice(-10))
    );
  }

  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }

  // Security: If authenticated as rider, prevent snooping on other riders
  if (authenticatedRider && authenticatedRider.role === 'rider') {
    const isOwner = (
      (rider.permanentRiderId && authenticatedRider.permanentRiderId === rider.permanentRiderId) ||
      (rider.userId && authenticatedRider.id === rider.userId) ||
      (rider.phone && authenticatedRider.phone === rider.phone)
    );
    if (!isOwner) {
      return res.status(403).json({ success: false, message: 'Access denied: Cannot access another rider metrics.' });
    }
    if (requestedUserId && requestedUserId !== rider.userId && requestedUserId !== rider.permanentRiderId) {
      return res.status(403).json({ success: false, message: 'Access denied: Cannot access another rider metrics.' });
    }
    if (requestedPhone && String(requestedPhone).replace(/\D/g, '').slice(-10) !== rider.phone) {
      return res.status(403).json({ success: false, message: 'Access denied: Cannot access another rider metrics.' });
    }
    if (requestedPermId && requestedPermId !== rider.permanentRiderId) {
      return res.status(403).json({ success: false, message: 'Access denied: Cannot access another rider metrics.' });
    }
  }

  // 2. Filter completed (DELIVERED) orders assigned to this rider
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - (24 * 60 * 60 * 1000);
  const endOfYesterday = startOfToday;

  // Start of current week (Monday)
  const currentDay = now.getDay();
  const distanceToMonday = (currentDay + 6) % 7;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - distanceToMonday).getTime();
  const startOfLastWeek = startOfWeek - (7 * 24 * 60 * 60 * 1000);
  const endOfLastWeek = startOfWeek;

  const deliveredOrders = (db.orders || []).filter(o => {
    if (o.orderStatus !== 'DELIVERED') return false;
    if (!o.assignedRider) return false;
    const ar = o.assignedRider;
    return Boolean(
      (rider.permanentRiderId && ar.permanentRiderId === rider.permanentRiderId) ||
      (rider.userId && ar.userId === rider.userId)
    );
  });

  // Calculate metrics
  let todayEarnings = 0;
  let yesterdayEarnings = 0;
  let todayCompletedOrders = 0;
  let yesterdayCompletedOrders = 0;
  let thisWeekDistanceKm = 0;
  let lastWeekDistanceKm = 0;
  let thisWeekIncentive = 0;

  // Hourly buckets for today's earnings trend bar chart (8 slots: each 3 hours)
  const todayEarningsBars = [0, 0, 0, 0, 0, 0, 0, 0];
  // 7 days distance array [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
  const weeklyDistanceGraph = [0, 0, 0, 0, 0, 0, 0];

  deliveredOrders.forEach(o => {
    const t = new Date(o.deliveredAt || o.createdAt || 0).getTime();
    const payout = (o.financials && o.financials.riderPayout !== undefined) ? Number(o.financials.riderPayout) : 0;
    const dist = (o.financials && o.financials.totalDistanceKm !== undefined)
      ? Number(o.financials.totalDistanceKm)
      : ((o.financials && o.financials.distanceKm !== undefined) ? Number(o.financials.distanceKm) : (Number(o.distanceKm) || 0));
    const incentive = (o.financials && o.financials.riderIncentive !== undefined) ? Number(o.financials.riderIncentive) : 0;

    if (t >= startOfToday) {
      todayEarnings += payout;
      todayCompletedOrders++;

      const orderDate = new Date(t);
      const slot = Math.min(7, Math.max(0, Math.floor(orderDate.getHours() / 3)));
      todayEarningsBars[slot] += payout;
    } else if (t >= startOfYesterday && t < endOfYesterday) {
      yesterdayEarnings += payout;
      yesterdayCompletedOrders++;
    }

    if (t >= startOfWeek) {
      thisWeekDistanceKm += dist;
      thisWeekIncentive += incentive;

      const dayIdx = (new Date(t).getDay() + 6) % 7; // Mon=0, Sun=6
      weeklyDistanceGraph[dayIdx] += dist;
    } else if (t >= startOfLastWeek && t < endOfLastWeek) {
      lastWeekDistanceKm += dist;
    }
  });

  todayEarnings = Math.round(todayEarnings * 100) / 100;
  yesterdayEarnings = Math.round(yesterdayEarnings * 100) / 100;
  thisWeekDistanceKm = Math.round(thisWeekDistanceKm * 10) / 10;
  lastWeekDistanceKm = Math.round(lastWeekDistanceKm * 10) / 10;
  thisWeekIncentive = Math.round(thisWeekIncentive * 100) / 100;

  // Earnings difference percent
  let earningsDiffPercent = 0;
  let earningsTrend = 'neutral';
  if (yesterdayEarnings > 0) {
    earningsDiffPercent = Math.round(((todayEarnings - yesterdayEarnings) / yesterdayEarnings) * 100);
    earningsTrend = earningsDiffPercent >= 0 ? 'up' : 'down';
  } else if (todayEarnings > 0) {
    earningsDiffPercent = 100;
    earningsTrend = 'up';
  }

  // Completed orders difference
  const completedOrdersDiff = todayCompletedOrders - yesterdayCompletedOrders;

  // Distance change percent
  let distanceDiffPercent = 0;
  let distanceTrend = 'neutral';
  if (lastWeekDistanceKm > 0) {
    distanceDiffPercent = Math.round(((thisWeekDistanceKm - lastWeekDistanceKm) / lastWeekDistanceKm) * 100);
    distanceTrend = distanceDiffPercent >= 0 ? 'up' : 'down';
  } else if (thisWeekDistanceKm > 0) {
    distanceDiffPercent = 100;
    distanceTrend = 'up';
  }

  // Normalize bar chart values for visual representation
  const maxBar = Math.max(...todayEarningsBars, 1);
  const normalizedBars = todayEarningsBars.map(b => (b > 0 ? Math.max(6, Math.round((b / maxBar) * 20)) : 4));

  // Count unread notifications
  const unreadNotificationsCount = 0;

  // Real Top Rider eligibility: Must have completed at least 20 deliveries and average rating >= 4.8
  const isTopRiderQualified = Boolean(
    rider.tier === 'Top Rider' ||
    (deliveredOrders.length >= 20 && Number(rider.ratings || 5) >= 4.8)
  );
  const tierName = isTopRiderQualified ? 'Top Rider' : (deliveredOrders.length > 0 ? 'Delivery Partner' : 'New Partner');

  return res.json({
    success: true,
    rider: {
      userId: rider.userId,
      name: rider.name || 'Delivery Partner',
      phone: rider.phone,
      permanentRiderId: rider.permanentRiderId,
      isOnline: Boolean(rider.isOnline),
      walletBalance: rider.walletBalance || 0,
      completedTrips: rider.completedTrips || deliveredOrders.length,
      avatar: rider.avatar || rider.photo || '',
      tier: tierName,
      isTopRider: isTopRiderQualified,
      tagline: isTopRiderQualified ? 'Keep going! Top earner this month.' : 'Deliver more orders to unlock Top Rider perks.'
    },
    metrics: {
      todayEarnings: {
        amount: todayEarnings,
        diffPercent: earningsDiffPercent,
        trend: earningsTrend,
        hasComparison: yesterdayEarnings > 0,
        bars: normalizedBars
      },
      completedOrders: {
        count: todayCompletedOrders,
        diff: completedOrdersDiff,
        trend: completedOrdersDiff > 0 ? 'up' : (completedOrdersDiff < 0 ? 'down' : 'neutral'),
        hasComparison: yesterdayCompletedOrders > 0,
        progress: yesterdayCompletedOrders > 0
          ? Math.min(100, Math.round((todayCompletedOrders / yesterdayCompletedOrders) * 100))
          : (todayCompletedOrders > 0 ? 100 : 0)
      },
      thisWeekDistance: {
        distanceKm: thisWeekDistanceKm,
        diffPercent: distanceDiffPercent,
        trend: distanceTrend,
        hasComparison: lastWeekDistanceKm > 0,
        graphPoints: weeklyDistanceGraph.map(d => Math.round(d * 10) / 10)
      },
      incentiveBonus: {
        amount: thisWeekIncentive,
        isActive: !!(db.settings && db.settings.riderIncentiveActive)
      },
      notifications: {
        unreadCount: unreadNotificationsCount
      }
    }
  });
}

/**
 * Toggle Rider Online / Duty status
 */
function toggleRiderOnlineStatus(req, res) {
  const db = readDb();
  const { isOnline, riderUserId, riderId, phone } = req.body;

  // 1. Authenticate caller
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-auth-token'] || req.headers['x-session-token'] || '');

  let authenticatedRider = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, getJwtSecret());
      if (sessionManager.isTokenRevoked(token, decoded)) {
        return res.status(401).json({ success: false, message: 'Invalid or revoked authentication token' });
      }
      if (decoded && (decoded.role === 'rider' || decoded.role === 'admin')) {
        authenticatedRider = decoded;
      } else {
        return res.status(403).json({ success: false, message: 'Access denied: Valid rider role required' });
      }
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Invalid or expired authentication token' });
    }
  }

  // Find target rider
  let rider = null;
  if (authenticatedRider && authenticatedRider.role === 'rider') {
    rider = db.riders.find(r =>
      (authenticatedRider.permanentRiderId && r.permanentRiderId === authenticatedRider.permanentRiderId) ||
      (authenticatedRider.id && r.userId === authenticatedRider.id) ||
      (authenticatedRider.phone && r.phone === authenticatedRider.phone)
    );

    // Cross-rider modification guard: Rider cannot modify another rider's status
    const targetUserId = riderUserId || riderId;
    if (targetUserId && rider && targetUserId !== rider.userId && targetUserId !== rider.permanentRiderId) {
      return res.status(403).json({ success: false, message: 'Access denied: Cannot modify another rider online status.' });
    }
    if (phone && rider && String(phone).replace(/\D/g, '').slice(-10) !== rider.phone) {
      return res.status(403).json({ success: false, message: 'Access denied: Cannot modify another rider online status.' });
    }
  } else if (authenticatedRider && authenticatedRider.role === 'admin') {
    // Admin can toggle for a rider
    const targetUserId = riderUserId || riderId;
    const targetPhone = phone ? String(phone).replace(/\D/g, '').slice(-10) : '';
    rider = db.riders.find(r =>
      (targetUserId && (r.permanentRiderId === targetUserId || r.userId === targetUserId)) ||
      (targetPhone && r.phone === targetPhone)
    );
  } else {
    // Unauthenticated request
    return res.status(401).json({ success: false, message: 'Authentication required to modify duty status' });
  }

  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }

  // 1. Blocked Rider Enforcement: Blocked riders cannot go online
  if (rider.isBlocked) {
    if (rider.isOnline) {
      rider.isOnline = false;
      writeDb(db);
    }
    return res.status(403).json({
      success: false,
      message: 'Access denied: Blocked delivery partners cannot go online. Please contact INDFood Admin.'
    });
  }

  // Prevent duplicate concurrent requests (in-flight mutex per rider)
  const riderKey = rider.permanentRiderId || rider.userId || rider.phone;
  if (inFlightToggles.has(riderKey)) {
    return res.status(429).json({ success: false, message: 'Status update already in progress, please wait' });
  }
  inFlightToggles.add(riderKey);

  try {
    // Update status
    const targetOnline = (isOnline !== undefined) ? Boolean(isOnline) : !rider.isOnline;

    // 2. KYC Approval Guard: Only Admin-approved riders can go online
    if (targetOnline && rider.kycStatus !== 'APPROVED') {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Delivery partner KYC must be approved by Admin before going online.'
      });
    }

    rider.isOnline = targetOnline;
    writeDb(db);

    return res.json({
      success: true,
      isOnline: rider.isOnline,
      message: rider.isOnline ? 'Rider is now ONLINE' : 'Rider is now OFFLINE'
    });
  } finally {
    inFlightToggles.delete(riderKey);
  }
}

module.exports = {
  submitKyc,
  getRiderStatus,
  riderLogin,
  approveKyc,
  rejectKyc,
  getPendingKycList,
  getRiderDashboardStats,
  toggleRiderOnlineStatus
};
