const { v4: uuidv4 } = require('uuid');
const { readDb, writeDb } = require('../models/db');

// Register or Login with Mobile Number
function loginOrRegister(req, res) {
  const { phone, name, role = 'customer' } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  const db = readDb();
  let user = db.users.find(u => u.phone === phone);

  if (!user) {
    user = {
      id: `usr_${uuidv4().substring(0, 8)}`,
      name: name || (role === 'rider' ? 'New Rider' : 'Valued Customer'),
      phone,
      role, // 'customer', 'rider', 'restaurant', 'admin'
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    writeDb(db);
  }

  let riderInfo = db.riders.find(r => r.userId === user.id || r.phone === phone);

  return res.json({
    success: true,
    message: 'Login successful',
    user,
    riderInfo,
    token: `dummy_jwt_token_${user.id}`
  });
}

function getUserProfile(req, res) {
  const { userId } = req.params;
  const db = readDb();
  let user = db.users.find(u => u.id === userId || u.phone === userId);
  let riderInfo = db.riders.find(r => r.userId === userId || r.phone === userId);

  if (!user && !riderInfo) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  res.json({
    success: true,
    user: user || { id: userId, name: riderInfo ? riderInfo.name : 'Rider', phone: riderInfo ? riderInfo.phone : '', role: 'rider' },
    riderInfo: riderInfo || null
  });
}

module.exports = {
  loginOrRegister,
  getUserProfile
};
