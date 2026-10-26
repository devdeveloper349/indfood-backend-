const { readDb, writeDb } = require('../models/db');
const { generatePermanentRiderId } = require('../utils/idGenerator');

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

/**
 * Rider registers / submits KYC:
 * 1. Selfie Photo
 * 2. Full Name
 * 3. Mobile Number
 * 4. PAN Card Number (Identity check)
 * 5. Date of Birth (Age check: must be 18+)
 * 6. Bike / Vehicle Number
 */
function submitKyc(req, res) {
  const { userId, name, mobileNumber, phone, panNumber, aadhaarNumber, dob, selfiePhoto, bikeNumber, vehicleNumber } = req.body;
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

  // 18+ Age verification
  const age = calculateAge(riderDob);
  if (age < 18) {
    return res.status(400).json({
      success: false,
      message: `Aapki umar 18 saal se kam hai (${age} saal). Shram kanoon aur INDFood policy ke anusaar delivery partner banne ke liye 18+ hona anivarya hai!`
    });
  }

  const db = readDb();
  let rider = db.riders.find(r => (userId && r.userId === userId) || r.phone === riderPhone);

  if (!rider) {
    const uid = userId || `usr_rd_${Date.now().toString(36)}`;
    rider = {
      userId: uid,
      phone: riderPhone,
      name: riderName,
      permanentRiderId: null,
      kycStatus: 'APPROVED',
      isOnline: true,
      walletBalance: 0,
      completedTrips: 0,
      createdAt: new Date().toISOString()
    };
    db.riders.push(rider);
  }

  rider.phone = riderPhone;
  rider.name = riderName;
  rider.panNumber = riderPan;
  rider.dob = riderDob;
  rider.age = age;
  rider.bikeNumber = riderBike || rider.bikeNumber || 'BIKE-REG';
  if (riderSelfie) {
    rider.selfiePhoto = riderSelfie;
  }
  rider.isBlocked = rider.isBlocked || false;

  // Auto-generate official 12-char permanent ID tied to their name (e.g., devraj683992)
  if (!rider.permanentRiderId) {
    let newId = generatePermanentRiderId(rider.name);
    while (db.riders.some(r => r.permanentRiderId === newId)) {
      newId = generatePermanentRiderId(rider.name);
    }
    rider.permanentRiderId = newId;
  }

  rider.kycStatus = 'APPROVED';
  rider.kycApprovedAt = new Date().toISOString();

  rider.kycDocuments = {
    mobileNumber: riderPhone,
    panNumber: riderPan,
    dob: riderDob,
    age: age,
    bikeNumber: rider.bikeNumber,
    hasSelfie: Boolean(rider.selfiePhoto),
    submittedAt: new Date().toISOString()
  };

  writeDb(db);

  return res.json({
    success: true,
    message: `KYC & 18+ Identity Verified! Permanent Delivery Partner ID: ${rider.permanentRiderId}`,
    permanentRiderId: rider.permanentRiderId,
    rider
  });
}

/**
 * Check rider approval status by userId or phone
 */
function getRiderStatus(req, res) {
  const { userId, phone } = req.query;
  const db = readDb();
  const rider = db.riders.find(r => (userId && r.userId === userId) || (phone && r.phone === phone.toString().trim()));
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }
  return res.json({
    success: true,
    rider,
    isApproved: rider.kycStatus === 'APPROVED' || Boolean(rider.permanentRiderId),
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

  writeDb(db);

  return res.json({
    success: true,
    message: `Rider KYC Approved! Official Permanent ID generated: ${rider.permanentRiderId}`,
    permanentRiderId: rider.permanentRiderId,
    rider
  });
}

/**
 * Admin rejects Rider KYC
 */
function rejectKyc(req, res) {
  const { userId, phone, reason } = req.body;
  const db = readDb();
  const rider = db.riders.find(r => (userId && r.userId === userId) || (phone && r.phone === phone));
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider profile not found' });
  }

  rider.kycStatus = 'REJECTED';
  rider.rejectionReason = reason || 'Documents invalid or unclear';

  writeDb(db);

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
  const pending = db.riders.filter(r => (r.kycStatus === 'SUBMITTED' || r.kycStatus === 'PENDING') && !r.permanentRiderId);
  return res.json({ success: true, pending });
}

module.exports = {
  submitKyc,
  getRiderStatus,
  approveKyc,
  rejectKyc,
  getPendingKycList
};
