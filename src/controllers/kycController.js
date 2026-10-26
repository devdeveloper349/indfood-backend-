const { readDb, writeDb } = require('../models/db');
const { generatePermanentRiderId } = require('../utils/idGenerator');

/**
 * Rider submits simplified KYC:
 * 1. Mobile Number
 * 2. Aadhaar Number
 * 3. Bike Number
 */
function submitKyc(req, res) {
  const { userId, name, mobileNumber, phone, aadhaarNumber, bikeNumber, vehicleNumber } = req.body;
  const riderPhone = (mobileNumber || phone || '').toString().trim();
  const riderBike = (bikeNumber || vehicleNumber || '').toString().trim().toUpperCase();
  const riderAadhaar = (aadhaarNumber || '').toString().trim();

  if (!riderPhone || !riderAadhaar || !riderBike) {
    return res.status(400).json({
      success: false,
      message: 'Mobile Number, Aadhaar Number, and Bike Number are required'
    });
  }

  const db = readDb();
  let rider = db.riders.find(r => (userId && r.userId === userId) || r.phone === riderPhone);

  if (!rider) {
    const uid = userId || `usr_rd_${Date.now().toString(36)}`;
    rider = {
      userId: uid,
      phone: riderPhone,
      name: name || 'Delivery Partner',
      permanentRiderId: null,
      kycStatus: 'SUBMITTED',
      isOnline: true,
      walletBalance: 0,
      completedTrips: 0,
      createdAt: new Date().toISOString()
    };
    db.riders.push(rider);
  }

  rider.phone = riderPhone;
  rider.name = name || rider.name || 'Delivery Partner';
  if (!rider.permanentRiderId) {
    rider.kycStatus = 'SUBMITTED';
  } else {
    rider.kycStatus = 'APPROVED';
  }

  rider.kycDocuments = {
    mobileNumber: riderPhone,
    aadhaarNumber: riderAadhaar,
    bikeNumber: riderBike,
    submittedAt: new Date().toISOString()
  };

  writeDb(db);

  return res.json({
    success: true,
    message: 'KYC submitted successfully (Mobile, Aadhaar & Bike Number). Awaiting Admin Approval.',
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

  // Generate permanent, unique, random ID only if not already assigned
  if (!rider.permanentRiderId) {
    let newId = generatePermanentRiderId();
    while (db.riders.some(r => r.permanentRiderId === newId)) {
      newId = generatePermanentRiderId();
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
