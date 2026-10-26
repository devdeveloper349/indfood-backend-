const { readDb, writeDb } = require('../models/db');

/**
 * List all available shifts
 */
function getShifts(req, res) {
  const db = readDb();
  const shiftsWithStats = db.shifts.map(s => ({
    ...s,
    availableSlots: Math.max(0, s.maxSlots - s.bookedRiders.length),
    isFull: s.bookedRiders.length >= s.maxSlots
  }));
  return res.json({ success: true, shifts: shiftsWithStats });
}

/**
 * Rider books a shift
 */
function bookShift(req, res) {
  const { userId, shiftId } = req.body;
  if (!userId || !shiftId) {
    return res.status(400).json({ success: false, message: 'userId and shiftId are required' });
  }

  const db = readDb();
  const rider = db.riders.find(r => r.userId === userId);
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }

  if (rider.kycStatus !== 'APPROVED') {
    return res.status(403).json({
      success: false,
      message: 'KYC approval is required before you can book shifts and accept orders.'
    });
  }

  const shift = db.shifts.find(s => s.id === shiftId);
  if (!shift) {
    return res.status(404).json({ success: false, message: 'Shift not found' });
  }

  if (shift.bookedRiders.includes(rider.permanentRiderId || rider.userId)) {
    return res.status(400).json({ success: false, message: 'You have already booked this shift!' });
  }

  if (shift.bookedRiders.length >= shift.maxSlots) {
    return res.status(400).json({ success: false, message: 'This shift is full. Please choose another shift.' });
  }

  shift.bookedRiders.push(rider.permanentRiderId || rider.userId);
  writeDb(db);

  return res.json({
    success: true,
    message: `Shift '${shift.name}' (${shift.time}) successfully booked!`,
    shift
  });
}

/**
 * Rider cancels a booked shift
 */
function cancelShift(req, res) {
  const { userId, shiftId } = req.body;
  const db = readDb();
  const rider = db.riders.find(r => r.userId === userId);
  if (!rider) {
    return res.status(404).json({ success: false, message: 'Rider not found' });
  }

  const shift = db.shifts.find(s => s.id === shiftId);
  if (!shift) {
    return res.status(404).json({ success: false, message: 'Shift not found' });
  }

  const riderKey = rider.permanentRiderId || rider.userId;
  shift.bookedRiders = shift.bookedRiders.filter(id => id !== riderKey);
  writeDb(db);

  return res.json({
    success: true,
    message: `Shift '${shift.name}' cancelled.`,
    shift
  });
}

/**
 * Admin updates shift slots capacity
 */
function updateShiftSlots(req, res) {
  const { shiftId, maxSlots } = req.body;
  const db = readDb();
  const shift = db.shifts.find(s => s.id === shiftId);
  if (!shift) {
    return res.status(404).json({ success: false, message: 'Shift not found' });
  }

  shift.maxSlots = parseInt(maxSlots, 10);
  writeDb(db);

  return res.json({
    success: true,
    message: `Shift capacity updated to ${shift.maxSlots} slots.`,
    shift
  });
}

module.exports = {
  getShifts,
  bookShift,
  cancelShift,
  updateShiftSlots
};
