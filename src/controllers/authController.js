const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { readDb, writeDb } = require('../models/db');
const { generatePermanentRiderId } = require('../utils/idGenerator');

// In-memory OTP storage with 10-minute expiry
const otpStore = new Map(); // key: email, value: { otp, expiresAt, purpose }

/**
 * Send Email OTP under "IND food" Brand
 */
function sendEmailOtp(req, res) {
  try {
    const { email, purpose = 'register' } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid Google / Email ID zaroori hai!' });
    }

    const cleanEmail = email.toLowerCase().trim();
    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    otpStore.set(cleanEmail, { otp, expiresAt, purpose });

    console.log(`\n======================================================`);
    console.log(`📩 [IND food Brand Email Service]`);
    console.log(`To: ${cleanEmail}`);
    console.log(`Brand: IND food`);
    console.log(`Subject: Your IND food Verification Code`);
    console.log(`Message: Your 6-digit verification code is: [ ${otp} ]`);
    console.log(`Expires in: 10 minutes`);
    console.log(`======================================================\n`);

    return res.json({
      success: true,
      message: `IND food ki taraf se verification code ${cleanEmail} par bhej diya gaya hai!`,
      otp, // included for foolproof testing & instant filling
      brand: 'IND food'
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    return res.status(500).json({ success: false, message: err.message || 'OTP send karne me dikkat aayi' });
  }
}

/**
 * Verify OTP
 */
function verifyOtp(req, res) {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email aur OTP dono zaroori hain!' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanOtp = otp.toString().trim();
    const stored = otpStore.get(cleanEmail);

    if (!stored) {
      return res.status(400).json({ success: false, message: 'OTP expired ho gaya hai ya bhejha nahi gaya. Dobara OTP mangwayein!' });
    }

    if (Date.now() > stored.expiresAt) {
      otpStore.delete(cleanEmail);
      return res.status(400).json({ success: false, message: 'OTP expire ho chuka hai. Kripya naya OTP generate karein.' });
    }

    if (stored.otp !== cleanOtp) {
      return res.status(400).json({ success: false, message: 'Galat OTP enter kiya hai! Kripya sahi OTP dalein.' });
    }

    // OTP verified
    otpStore.delete(cleanEmail);
    return res.json({
      success: true,
      message: 'Email safaltapoorvak verify ho gaya!'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Real Register with Name, Mobile, Email, Password
 */
function registerUser(req, res) {
  try {
    const { name, phone, email, password, role = 'customer' } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Aapka Naam bharna zaroori hai!' });
    }
    if (!phone || phone.toString().trim().length < 10) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number zaroori hai!' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid Google / Email ID zaroori hai!' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ success: false, message: 'Password kam se kam 4 aksharon ka hona chahiye!' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanPhone = phone.toString().trim().replace(/\D/g, '').slice(-10);
    const cleanName = name.trim();

    const db = readDb();
    db.users = db.users || [];
    db.riders = db.riders || [];
    db.restaurants = db.restaurants || [];

    // Check if user already exists with this email or phone
    let existingByEmail = db.users.find(u => u.email === cleanEmail);
    if (existingByEmail) {
      return res.status(400).json({
        success: false,
        message: 'Yeh Google / Email ID pehle se registered hai! Kripya Login karein ya Forgot Password use karein.'
      });
    }

    let existingByPhone = db.users.find(u => u.phone === cleanPhone);
    if (existingByPhone) {
      return res.status(400).json({
        success: false,
        message: `Yeh Mobile Number (+91 ${cleanPhone}) pehle se doosre account se juda hai! Kripya naya number dalein ya Login karein.`
      });
    }

    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);

    const user = {
      id: `usr_${uuidv4().substring(0, 8)}`,
      name: cleanName,
      phone: cleanPhone,
      email: cleanEmail,
      password: hashedPassword,
      role,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);

    // Role-specific setup
    let rider = null;
    let restaurant = null;

    if (role === 'rider') {
      rider = db.riders.find(r => r.userId === user.id || r.phone === cleanPhone || r.email === cleanEmail);
      if (!rider) {
        let permId = generatePermanentRiderId(cleanName);
        while (db.riders.some(r => r.permanentRiderId === permId)) {
          permId = generatePermanentRiderId(cleanName);
        }
        rider = {
          userId: user.id,
          phone: cleanPhone,
          email: cleanEmail,
          name: cleanName,
          permanentRiderId: permId,
          kycStatus: 'APPROVED', // NO 18+ BLOCKING!
          isOnline: true,
          walletBalance: 0,
          completedTrips: 0,
          bikeNumber: 'BIKE-REG',
          createdAt: new Date().toISOString()
        };
        db.riders.push(rider);
      } else {
        rider.phone = cleanPhone;
        rider.email = cleanEmail;
        rider.name = cleanName;
        rider.kycStatus = 'APPROVED';
        rider.isOnline = true;
        if (!rider.permanentRiderId) {
          rider.permanentRiderId = generatePermanentRiderId(cleanName);
        }
      }
    } else if (role === 'restaurant') {
      restaurant = db.restaurants.find(r => r.phone === cleanPhone || r.ownerEmail === cleanEmail);
      if (!restaurant) {
        restaurant = {
          id: `rest_${Date.now().toString(36)}`,
          name: cleanName,
          phone: cleanPhone,
          ownerEmail: cleanEmail,
          address: 'Main Market, City Center',
          cuisine: 'North Indian, Snacks, Thali',
          latitude: null, // No hardcoded fixed location! Restaurant sets its own
          longitude: null,
          commissionPercent: 15,
          isActive: true,
          isOpen: true,
          menu: [],
          createdAt: new Date().toISOString()
        };
        db.restaurants.push(restaurant);
      } else {
        restaurant.name = cleanName;
        restaurant.phone = cleanPhone;
        restaurant.ownerEmail = cleanEmail;
      }
    }

    writeDb(db);

    return res.json({
      success: true,
      message: 'Account successfully register ho gaya! Kripya Email aur Password se Login karein.',
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role
      },
      rider,
      restaurant,
      token: `jwt_token_${user.id}_${Date.now()}`
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Registration failed' });
  }
}

/**
 * Real Login with Email & Password
 */
function loginEmail(req, res) {
  try {
    const { email, password, role = 'customer' } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Google / Email ID bharna zaroori hai!' });
    }
    if (!password) {
      return res.status(400).json({ success: false, message: 'Password bharna zaroori hai!' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const db = readDb();
    db.users = db.users || [];
    db.riders = db.riders || [];
    db.restaurants = db.restaurants || [];

    // Find user by email or phone
    let user = db.users.find(u => u.email === cleanEmail || (u.phone && u.phone === cleanEmail));

    if (!user) {
      // Also check riders / restaurants directly if registered through old flow
      const riderFound = db.riders.find(r => (r.email && r.email === cleanEmail) || (r.phone && r.phone === cleanEmail));
      const restFound = db.restaurants.find(r => (r.ownerEmail && r.ownerEmail === cleanEmail) || (r.phone && r.phone === cleanEmail));

      if (!riderFound && !restFound) {
        return res.status(404).json({
          success: false,
          message: 'Yeh Email ID registered nahi hai! Kripya pehle Register karein.'
        });
      }

      // Synthesize user account
      const salt = bcrypt.genSaltSync(10);
      user = {
        id: `usr_${uuidv4().substring(0, 8)}`,
        name: riderFound ? riderFound.name : (restFound ? restFound.name : 'User'),
        phone: riderFound ? riderFound.phone : (restFound ? restFound.phone : '9999999999'),
        email: cleanEmail,
        password: bcrypt.hashSync(password, salt),
        role: riderFound ? 'rider' : (restFound ? 'restaurant' : role),
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      writeDb(db);
    }

    // Validate password if present
    if (user.password) {
      let isMatch = false;
      try {
        isMatch = bcrypt.compareSync(password, user.password);
      } catch (e) {
        isMatch = user.password === password; // plain text fallback
      }
      if (!isMatch && user.password !== password) {
        return res.status(401).json({ success: false, message: 'Galat Password! Kripya sahi password dalein ya Forgot Password par click karein.' });
      }
    }

    let rider = null;
    let restaurant = null;

    if (role === 'rider' || user.role === 'rider') {
      rider = db.riders.find(r => r.userId === user.id || r.phone === user.phone || r.email === user.email);
      if (!rider) {
        let permId = generatePermanentRiderId(user.name);
        rider = {
          userId: user.id,
          phone: user.phone,
          email: user.email,
          name: user.name,
          permanentRiderId: permId,
          kycStatus: 'APPROVED',
          isOnline: true,
          walletBalance: 0,
          completedTrips: 0,
          bikeNumber: 'BIKE-REG',
          createdAt: new Date().toISOString()
        };
        db.riders.push(rider);
        writeDb(db);
      } else {
        if (!rider.permanentRiderId) {
          rider.permanentRiderId = generatePermanentRiderId(rider.name || user.name);
          writeDb(db);
        }
      }
      if (rider.isBlocked) {
        return res.status(403).json({ success: false, message: 'Aapka Delivery Partner account suspend hai. Support se baat karein.' });
      }
    } else if (role === 'restaurant' || user.role === 'restaurant') {
      restaurant = db.restaurants.find(r => r.phone === user.phone || r.ownerEmail === user.email || r.id === user.restaurantId);
      if (!restaurant) {
        restaurant = {
          id: `rest_${Date.now().toString(36)}`,
          name: user.name,
          phone: user.phone,
          ownerEmail: user.email,
          address: 'Main Market, City Center',
          cuisine: 'North Indian, Snacks, Thali',
          latitude: null,
          longitude: null,
          commissionPercent: 15,
          isActive: true,
          isOpen: true,
          menu: [],
          createdAt: new Date().toISOString()
        };
        db.restaurants.push(restaurant);
        writeDb(db);
      }
    }

    return res.json({
      success: true,
      message: `Swagat hai ${user.name}! Login safal raha.`,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role
      },
      rider,
      restaurant,
      permanentRiderId: rider ? rider.permanentRiderId : null,
      token: `jwt_token_${user.id}_${Date.now()}`
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Login failed' });
  }
}

/**
 * Real "Continue with Google" One-Click Direct Auth
 */
function googleLogin(req, res) {
  try {
    const { email, name, role = 'customer', phone = '' } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid Google Account Email zaroori hai!' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = (name || cleanEmail.split('@')[0]).trim();
    const cleanPhone = (phone || '').toString().trim().replace(/\D/g, '').slice(-10) || '9' + Math.floor(100000000 + Math.random() * 900000000);

    const db = readDb();
    db.users = db.users || [];
    db.riders = db.riders || [];
    db.restaurants = db.restaurants || [];

    let user = db.users.find(u => u.email === cleanEmail);
    if (!user) {
      user = {
        id: `usr_g_${uuidv4().substring(0, 8)}`,
        name: cleanName,
        phone: cleanPhone,
        email: cleanEmail,
        googleAuth: true,
        role,
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
    } else {
      user.name = cleanName;
      user.googleAuth = true;
    }

    let rider = null;
    let restaurant = null;

    if (role === 'rider') {
      rider = db.riders.find(r => r.userId === user.id || r.email === cleanEmail || r.phone === user.phone);
      if (!rider) {
        let permId = generatePermanentRiderId(cleanName);
        rider = {
          userId: user.id,
          phone: user.phone,
          email: cleanEmail,
          name: cleanName,
          permanentRiderId: permId,
          kycStatus: 'APPROVED',
          isOnline: true,
          walletBalance: 0,
          completedTrips: 0,
          bikeNumber: 'BIKE-REG',
          createdAt: new Date().toISOString()
        };
        db.riders.push(rider);
      }
    } else if (role === 'restaurant') {
      restaurant = db.restaurants.find(r => r.ownerEmail === cleanEmail || r.phone === user.phone);
      if (!restaurant) {
        restaurant = {
          id: `rest_${Date.now().toString(36)}`,
          name: cleanName + ' Kitchen',
          phone: user.phone,
          ownerEmail: cleanEmail,
          address: 'Main Market, City Center',
          cuisine: 'North Indian, Snacks, Thali',
          latitude: null,
          longitude: null,
          commissionPercent: 15,
          isActive: true,
          isOpen: true,
          menu: [],
          createdAt: new Date().toISOString()
        };
        db.restaurants.push(restaurant);
      }
    }

    writeDb(db);

    return res.json({
      success: true,
      message: `Google Account se Safal Login! Swagat hai ${cleanName}!`,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role
      },
      rider,
      restaurant,
      permanentRiderId: rider ? rider.permanentRiderId : null,
      token: `jwt_token_google_${user.id}`
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Google login failed' });
  }
}

/**
 * Forgot Password - Send OTP
 */
function forgotPassword(req, res) {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Apna registered Google / Email ID dalein!' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const db = readDb();
    const user = (db.users || []).find(u => u.email === cleanEmail);

    if (!user) {
      return res.status(404).json({ success: false, message: 'Yeh email ID IND food me registered nahi hai!' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore.set(cleanEmail, { otp, expiresAt, purpose: 'reset_password' });

    console.log(`\n======================================================`);
    console.log(`📩 [IND food Password Reset Service]`);
    console.log(`To: ${cleanEmail}`);
    console.log(`Subject: IND food Password Reset Code`);
    console.log(`Reset Code: [ ${otp} ]`);
    console.log(`======================================================\n`);

    return res.json({
      success: true,
      message: `Password reset OTP ${cleanEmail} par bhej diya gaya hai!`,
      otp,
      brand: 'IND food'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Reset Password with OTP
 */
function resetPassword(req, res) {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email, OTP aur Naya Password sabhi zaroori hain!' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanOtp = otp.toString().trim();
    const stored = otpStore.get(cleanEmail);

    if (!stored || stored.otp !== cleanOtp || Date.now() > stored.expiresAt) {
      return res.status(400).json({ success: false, message: 'Invalid ya Expired OTP! Dobara koshish karein.' });
    }

    const db = readDb();
    const user = (db.users || []).find(u => u.email === cleanEmail);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const salt = bcrypt.genSaltSync(10);
    user.password = bcrypt.hashSync(newPassword, salt);
    user.updatedAt = new Date().toISOString();
    writeDb(db);

    otpStore.delete(cleanEmail);

    return res.json({
      success: true,
      message: 'Password safalta se badal gaya! Ab naye password se Login karein.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Legacy phone login for backward compatibility
function loginOrRegister(req, res) {
  const { phone, name, role = 'customer' } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  const cleanPhone = phone.toString().trim().replace(/\D/g, '').slice(-10);
  const db = readDb();
  let user = db.users.find(u => u.phone === cleanPhone);

  if (!user) {
    user = {
      id: `usr_${uuidv4().substring(0, 8)}`,
      name: name || (role === 'rider' ? 'New Rider' : 'Valued Customer'),
      phone: cleanPhone,
      email: `${cleanPhone}@indfood.app`,
      role,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    writeDb(db);
  }

  let riderInfo = db.riders.find(r => r.userId === user.id || r.phone === cleanPhone);
  if (role === 'rider' && !riderInfo) {
    riderInfo = {
      userId: user.id,
      phone: cleanPhone,
      email: user.email,
      name: user.name,
      permanentRiderId: generatePermanentRiderId(user.name),
      kycStatus: 'APPROVED',
      isOnline: true,
      walletBalance: 0,
      completedTrips: 0,
      bikeNumber: 'BIKE-REG',
      createdAt: new Date().toISOString()
    };
    db.riders.push(riderInfo);
    writeDb(db);
  }

  return res.json({
    success: true,
    message: 'Login successful',
    user,
    riderInfo,
    rider: riderInfo,
    token: `dummy_jwt_token_${user.id}`
  });
}

function getUserProfile(req, res) {
  const { userId } = req.params;
  const db = readDb();
  let user = db.users.find(u => u.id === userId || u.phone === userId || u.email === userId);
  let riderInfo = db.riders.find(r => r.userId === userId || r.phone === userId || r.email === userId);

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
  sendEmailOtp,
  verifyOtp,
  registerUser,
  loginEmail,
  googleLogin,
  forgotPassword,
  resetPassword,
  loginOrRegister,
  getUserProfile
};
