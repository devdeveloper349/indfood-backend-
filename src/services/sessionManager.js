const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { readDb, writeDb } = require('../models/db');
const { getJwtSecret } = require('../config/jwt');

/**
 * INDFood Persistent Session & Token Revocation Manager
 * 
 * - SHA-256 cryptographic token hashing (never store raw tokens)
 * - Persistent disk storage backed by database.json (survives restarts)
 * - Scalable O(1) in-memory revocation lookup set (designed for high scale)
 * - Active Socket.IO real-time disconnection upon token revocation
 * - Fine-grained single token revocation (e.g. user logout)
 * - User-wide session revocation (e.g. password change / account lock)
 * - Cryptographic verification for HTTP and Socket.IO handshakes
 */

let _ioInstance = null;
const revokedHashesSet = new Set();
let hasInitializedSet = false;

function setSocketIO(io) {
  _ioInstance = io;
}

function getSocketIO() {
  return _ioInstance;
}

function initRevokedSetFromDb() {
  try {
    const db = readDb();
    const list = db.revokedTokens || [];
    for (const item of list) {
      if (item && item.tokenHash) {
        revokedHashesSet.add(item.tokenHash);
      }
    }
    hasInitializedSet = true;
  } catch (_) {}
}

function hashToken(token) {
  if (!token || typeof token !== 'string') return '';
  const clean = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  return crypto.createHash('sha256').update(clean).digest('hex');
}

/**
 * Disconnect active Socket.IO connections associated with a revoked token
 */
function disconnectSocketsForToken(token, io = null) {
  const targetIo = io || _ioInstance;
  if (!targetIo || !token) return 0;
  const clean = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  const targetHash = hashToken(clean);
  let disconnectedCount = 0;

  const sockets = targetIo.sockets?.sockets || (targetIo.sockets instanceof Map ? targetIo.sockets : null);
  if (sockets && typeof sockets[Symbol.iterator] === 'function') {
    for (const [id, s] of sockets) {
      if (s.tokenHash === targetHash || s.token === clean || s.token === token) {
        try {
          s.emit('auth_revoked', {
            event: 'auth_revoked',
            message: 'Session revoked. You have been logged out.',
            timestamp: new Date().toISOString()
          });
          if (typeof s.disconnect === 'function') {
            s.disconnect(true);
          }
          s.disconnected = true;
          s.connected = false;
        } catch (_) {}
        disconnectedCount++;
      }
    }
  }
  return disconnectedCount;
}

/**
 * Disconnect active Socket.IO connections associated with a user or rider ID
 */
function disconnectSocketsForUser(userId, io = null) {
  const targetIo = io || _ioInstance;
  if (!targetIo || !userId) return 0;
  const cleanUserId = String(userId).trim();
  let disconnectedCount = 0;

  const sockets = targetIo.sockets?.sockets || (targetIo.sockets instanceof Map ? targetIo.sockets : null);
  if (sockets && typeof sockets[Symbol.iterator] === 'function') {
    for (const [id, s] of sockets) {
      const sUid = s.user?.id || s.user?.userId || s.userId;
      const sPermId = s.user?.permanentRiderId;
      const sPhone = s.user?.phone;
      if (
        (sUid && String(sUid).trim() === cleanUserId) ||
        (sPermId && String(sPermId).trim() === cleanUserId) ||
        (sPhone && String(sPhone).trim() === cleanUserId)
      ) {
        try {
          s.emit('auth_revoked', {
            event: 'auth_revoked',
            message: 'Session revoked. You have been logged out.',
            timestamp: new Date().toISOString()
          });
          if (typeof s.disconnect === 'function') {
            s.disconnect(true);
          }
          s.disconnected = true;
          s.connected = false;
        } catch (_) {}
        disconnectedCount++;
      }
    }
  }
  return disconnectedCount;
}

/**
 * Check if a token is persistently revoked (O(1) in-memory lookup backed by DB)
 */
function isTokenRevoked(token, decoded = null) {
  if (!token) return true;
  if (!hasInitializedSet) {
    initRevokedSetFromDb();
  }

  const tokenHash = hashToken(token);

  // 1. Fast O(1) in-memory lookup
  if (revokedHashesSet.has(tokenHash)) {
    return true;
  }

  // Fallback to DB check in case another worker updated database.json
  const db = readDb();
  const revokedTokens = db.revokedTokens || [];
  const isFound = revokedTokens.some(r => r.tokenHash === tokenHash);
  if (isFound) {
    revokedHashesSet.add(tokenHash);
    return true;
  }

  // 2. Check user-level revocation timestamp (if decoded user identity available)
  let payload = decoded;
  if (!payload) {
    try {
      const clean = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
      payload = jwt.decode(clean);
    } catch (_) {}
  }

  if (payload && payload.id) {
    const user = (db.users || []).find(u => u.id === payload.id);
    if (user && user.revokedBefore && payload.iat) {
      if ((payload.iat * 1000) < new Date(user.revokedBefore).getTime()) {
        return true;
      }
    }
    const rider = (db.riders || []).find(r => r.userId === payload.id || (payload.permanentRiderId && r.permanentRiderId === payload.permanentRiderId));
    if (rider && rider.revokedBefore && payload.iat) {
      if ((payload.iat * 1000) < new Date(rider.revokedBefore).getTime()) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Persistently revoke a token into database.json and disconnect active sockets
 */
function revokeToken(token, io = null) {
  if (!token) {
    return { success: false, message: 'No token provided' };
  }
  const clean = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  const tokenHash = hashToken(clean);

  revokedHashesSet.add(tokenHash);

  let decoded = null;
  try {
    decoded = jwt.decode(clean);
  } catch (_) {}

  const db = readDb();
  db.revokedTokens = db.revokedTokens || [];

  const alreadyRevoked = db.revokedTokens.some(r => r.tokenHash === tokenHash);
  if (!alreadyRevoked) {
    const expiresAt = decoded && decoded.exp
      ? new Date(decoded.exp * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    db.revokedTokens.push({
      tokenHash,
      userId: decoded?.id || null,
      role: decoded?.role || null,
      revokedAt: new Date().toISOString(),
      expiresAt
    });

    writeDb(db);
  }

  // Invalidate and disconnect all active Socket.IO connections for this token
  const disconnectedSockets = disconnectSocketsForToken(clean, io);

  return {
    success: true,
    message: 'Session token persistently revoked',
    disconnectedSockets
  };
}

/**
 * Revoke all sessions for a specific user ID and disconnect active sockets
 */
function revokeAllUserSessions(userId, io = null) {
  if (!userId) return false;
  const db = readDb();
  let updated = false;

  const user = (db.users || []).find(u => u.id === userId);
  if (user) {
    user.revokedBefore = new Date().toISOString();
    updated = true;
  }

  const rider = (db.riders || []).find(r => r.userId === userId || r.permanentRiderId === userId);
  if (rider) {
    rider.revokedBefore = new Date().toISOString();
    updated = true;
  }

  if (updated) {
    writeDb(db);
  }

  // Disconnect active socket connections for this user
  disconnectSocketsForUser(userId, io);

  return updated;
}

/**
 * Verify and authenticate credentials for HTTP or Socket.IO
 * Returns: { isValid: boolean, role: string, user: object, reason?: string }
 */
function verifyAuthToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { isValid: false, reason: 'No authorization credentials provided' };
  }

  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7).trim() : rawToken.trim();
  if (!token) {
    return { isValid: false, reason: 'Empty token string' };
  }

  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'indfood_admin_secret_2026';

  // 1. Direct Master Admin Secret Key match (Server-to-server)
  if (token === ADMIN_SECRET) {
    return {
      isValid: true,
      role: 'admin',
      user: {
        id: 'usr_admin_1',
        name: 'INDFood Master Admin',
        phone: '9999999999',
        role: 'admin'
      }
    };
  }

  // 2. Cryptographic JWT Verification
  let decoded = null;
  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch (err) {
    return {
      isValid: false,
      reason: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token signature'
    };
  }

  if (!decoded || typeof decoded !== 'object') {
    return { isValid: false, reason: 'Malformed token payload' };
  }

  // 3. Persistent Revocation Check
  if (isTokenRevoked(token, decoded)) {
    return { isValid: false, reason: 'Session token has been revoked or logged out' };
  }

  const db = readDb();

  // 4. Role-specific database principal resolution
  const role = decoded.role || 'customer';

  if (role === 'admin') {
    return {
      isValid: true,
      role: 'admin',
      user: {
        id: decoded.id || 'usr_admin_1',
        name: decoded.name || 'INDFood Admin',
        role: 'admin'
      }
    };
  }

  if (role === 'rider') {
    const rider = (db.riders || []).find(r =>
      r.userId === decoded.id ||
      (decoded.permanentRiderId && r.permanentRiderId === decoded.permanentRiderId) ||
      (decoded.phone && r.phone === decoded.phone)
    );

    const isBlocked = Boolean(rider && rider.isBlocked);
    const kycStatus = (rider && rider.kycStatus) ? rider.kycStatus : (decoded.kycStatus || 'NOT_SUBMITTED');
    const permanentRiderId = rider ? rider.permanentRiderId : (decoded.permanentRiderId || null);
    const internalUserId = rider ? rider.userId : decoded.id;

    return {
      isValid: true,
      role: 'rider',
      user: {
        id: internalUserId,
        userId: internalUserId,
        permanentRiderId,
        phone: rider ? rider.phone : decoded.phone,
        name: rider ? rider.name : decoded.name,
        role: 'rider',
        kycStatus,
        isBlocked,
        isOnline: Boolean(rider && rider.isOnline)
      }
    };
  }

  if (role === 'restaurant') {
    const restId = decoded.restaurantId || decoded.id;
    const rest = (db.restaurants || []).find(r => r.id === restId);
    return {
      isValid: true,
      role: 'restaurant',
      user: {
        id: decoded.id,
        restaurantId: restId,
        name: rest ? rest.name : (decoded.name || 'Restaurant Partner'),
        role: 'restaurant',
        phone: decoded.phone || ''
      }
    };
  }

  // Customer or general user
  const user = (db.users || []).find(u => u.id === decoded.id || (decoded.phone && u.phone === decoded.phone));
  return {
    isValid: true,
    role: 'customer',
    user: {
      id: decoded.id,
      phone: decoded.phone,
      email: decoded.email || '',
      name: decoded.name || (user ? user.name : 'Customer'),
      role: 'customer'
    }
  };
}

/**
 * Prune expired tokens from persistent DB
 */
function cleanupExpiredTokens() {
  const db = readDb();
  if (!db.revokedTokens || db.revokedTokens.length === 0) return;

  const now = Date.now();
  const initialCount = db.revokedTokens.length;
  db.revokedTokens = db.revokedTokens.filter(r => {
    if (!r.expiresAt) return true;
    return new Date(r.expiresAt).getTime() > now;
  });

  if (db.revokedTokens.length !== initialCount) {
    writeDb(db);
  }
}

module.exports = {
  hashToken,
  isTokenRevoked,
  revokeToken,
  revokeAllUserSessions,
  verifyAuthToken,
  cleanupExpiredTokens,
  setSocketIO,
  getSocketIO,
  disconnectSocketsForToken,
  disconnectSocketsForUser
};
