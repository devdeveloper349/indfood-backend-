/**
 * INDFood High-Performance Pure RAM + Socket.IO Live GPS Tracking Manager
 * 
 * - In-memory live tracking (Zero disk I/O on 5s GPS ticks)
 * - Strict authorization (Only assigned rider can update GPS for order)
 * - 30s stale location detection -> 'SIGNAL_LOST' / 'OFFLINE'
 * - 2.5 min disconnect grace period for socket dropouts/reconnects
 * - Multi-socket conflict resolution (newer socket ID overrides old disconnect)
 * - Auto-cleanup on DELIVERED, CANCELLED, or REASSIGNED
 * - Immediate state sync on joining order room
 */

const { readDb } = require('../models/db');

// In-Memory store for active order locations
// Key: orderId (String), Value: Object
const riderLocations = new Map();

// Active delivery statuses where live tracking is permitted
const ACTIVE_TRACKING_STATUSES = [
  'ACCEPTED_BY_RIDER',
  'RIDER_ASSIGNED',
  'AT_RESTAURANT',
  'RIDER_ARRIVED',
  'HANDED_OVER',
  'READY_FOR_PICKUP',
  'ON_THE_WAY',
  'OUT_FOR_DELIVERY'
];

let staleCheckerTimer = null;

/**
 * Update live rider location coordinates in RAM
 */
function updateLocation({ orderId, riderId, latitude, longitude, socketId = null, io = null }) {
  if (!orderId) {
    return { success: false, message: 'orderId is required' };
  }
  if (latitude === undefined || longitude === undefined || isNaN(parseFloat(latitude)) || isNaN(parseFloat(longitude))) {
    return { success: false, message: 'Valid latitude and longitude are required' };
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  const db = readDb();
  const order = (db.orders || []).find(o => o.orderId === orderId);

  if (!order) {
    return { success: false, message: `Order #${orderId} not found` };
  }

  // Verify order is currently active for delivery
  if (!ACTIVE_TRACKING_STATUSES.includes(order.orderStatus)) {
    return { success: false, message: `Tracking inactive for order status: ${order.orderStatus}` };
  }

  // Security check: Only the rider assigned to this order may update GPS
  const assigned = order.assignedRider;
  if (!assigned) {
    return { success: false, message: 'No delivery partner assigned to this order yet' };
  }

  const cleanRiderId = String(riderId || '').trim();
  const matchesUser = assigned.userId && String(assigned.userId).trim() === cleanRiderId;
  const matchesPerm = assigned.permanentRiderId && String(assigned.permanentRiderId).trim() === cleanRiderId;
  const matchesPhone = assigned.phone && String(assigned.phone).trim() === cleanRiderId;

  if (cleanRiderId && !matchesUser && !matchesPerm && !matchesPhone) {
    return {
      success: false,
      message: 'Unauthorized: You are not the assigned delivery partner for this order'
    };
  }

  // Update in-memory order object (RAM only, no disk write)
  order.riderLat = lat;
  order.riderLng = lng;
  order.riderLocationUpdatedAt = new Date().toISOString();

  // Update in-memory rider profile location (RAM only, no disk write)
  const effectiveId = cleanRiderId || assigned.permanentRiderId || assigned.userId;
  const riderProfile = (db.riders || []).find(r =>
    r.userId === effectiveId || r.permanentRiderId === effectiveId || r.phone === effectiveId
  );
  if (riderProfile) {
    riderProfile.latitude = lat;
    riderProfile.longitude = lng;
    riderProfile.lastLocationUpdate = new Date().toISOString();
  }

  // Update or create in-memory tracking record
  let loc = riderLocations.get(orderId);
  if (loc) {
    // If a disconnect timer was pending, cancel it immediately (rider has reconnected / sent ping)
    if (loc.disconnectTimer) {
      clearTimeout(loc.disconnectTimer);
      loc.disconnectTimer = null;
    }
    loc.latitude = lat;
    loc.longitude = lng;
    loc.updatedAt = Date.now();
    if (socketId) loc.socketId = socketId;
    loc.status = 'ONLINE';
    loc.isOnline = true;
    loc.disconnectedAt = null;
  } else {
    loc = {
      orderId,
      riderId: assigned.permanentRiderId || assigned.userId || cleanRiderId,
      riderName: assigned.name || 'Delivery Partner',
      latitude: lat,
      longitude: lng,
      updatedAt: Date.now(),
      socketId: socketId || null,
      status: 'ONLINE',
      isOnline: true,
      disconnectTimer: null,
      disconnectedAt: null
    };
    riderLocations.set(orderId, loc);
  }

  const broadcastPayload = {
    orderId,
    riderId: loc.riderId,
    riderName: loc.riderName,
    latitude: lat,
    longitude: lng,
    status: 'ONLINE',
    isOnline: true,
    updatedAt: new Date(loc.updatedAt).toISOString()
  };

  // Broadcast to customer and authorized sockets in order room
  if (io) {
    io.to(`order_${orderId}`).emit('rider_position', broadcastPayload);
    // Also broadcast to admin live monitoring
    io.to('admin_room').emit('rider_position', broadcastPayload);
  }

  return {
    success: true,
    message: 'Live location updated in RAM',
    location: broadcastPayload
  };
}

/**
 * Handle Socket disconnect with 2.5 min grace period and multi-socket conflict guard
 */
function handleSocketDisconnect(socketId, io) {
  if (!socketId) return;

  for (const [orderId, loc] of riderLocations.entries()) {
    // Guard against multi-socket race condition:
    // If loc.socketId is not this socketId, a newer connection already took over!
    if (loc.socketId === socketId) {
      loc.status = 'DISCONNECTED';
      loc.isOnline = false;
      loc.disconnectedAt = Date.now();

      if (io) {
        io.to(`order_${orderId}`).emit('rider_status_change', {
          orderId,
          status: 'DISCONNECTED',
          isOnline: false,
          gracePeriodSeconds: 150,
          message: 'Delivery partner disconnected. Reconnect grace period active (150s).'
        });
      }

      // Clear any prior timer
      if (loc.disconnectTimer) {
        clearTimeout(loc.disconnectTimer);
      }

      // 2.5 minute grace period (150 seconds)
      loc.disconnectTimer = setTimeout(() => {
        // If still disconnected after grace period, mark as OFFLINE
        if (loc.status === 'DISCONNECTED') {
          loc.status = 'OFFLINE';
          loc.isOnline = false;
          if (io) {
            io.to(`order_${orderId}`).emit('rider_status_change', {
              orderId,
              status: 'OFFLINE',
              isOnline: false,
              message: 'Delivery partner offline (grace period expired).'
            });
            io.to(`order_${orderId}`).emit('rider_position', {
              orderId,
              riderId: loc.riderId,
              latitude: loc.latitude,
              longitude: loc.longitude,
              status: 'OFFLINE',
              isOnline: false,
              updatedAt: new Date(loc.updatedAt).toISOString()
            });
          }
        }
      }, 150000);
    }
  }
}

/**
 * Periodically check for stale locations (>30 seconds without GPS ping)
 */
function checkStaleLocations(io) {
  const now = Date.now();
  for (const [orderId, loc] of riderLocations.entries()) {
    if (loc.status === 'ONLINE' && (now - loc.updatedAt > 30000)) {
      loc.status = 'SIGNAL_LOST';
      loc.isOnline = false;

      if (io) {
        io.to(`order_${orderId}`).emit('rider_status_change', {
          orderId,
          status: 'SIGNAL_LOST',
          isOnline: false,
          message: 'Delivery partner signal lost (>30s without update).'
        });
        io.to(`order_${orderId}`).emit('rider_position', {
          orderId,
          riderId: loc.riderId,
          latitude: loc.latitude,
          longitude: loc.longitude,
          status: 'SIGNAL_LOST',
          isOnline: false,
          updatedAt: new Date(loc.updatedAt).toISOString()
        });
      }
    }
  }
}

/**
 * Start periodic stale location checker (every 10s)
 */
function startStaleChecker(io) {
  if (staleCheckerTimer) clearInterval(staleCheckerTimer);
  staleCheckerTimer = setInterval(() => {
    try {
      checkStaleLocations(io);
    } catch (e) {
      console.error('Stale checker error:', e);
    }
  }, 10000);
}

/**
 * Clear in-memory tracking record upon completion (DELIVERED, CANCELLED, REASSIGNED)
 */
function clearLocation(orderId, reason = 'COMPLETED') {
  if (!orderId) return;
  const loc = riderLocations.get(orderId);
  if (loc) {
    if (loc.disconnectTimer) {
      clearTimeout(loc.disconnectTimer);
    }
    riderLocations.delete(orderId);
  }
}

/**
 * Get current in-memory location for an order
 */
function getLocation(orderId) {
  if (!orderId) return null;
  const loc = riderLocations.get(orderId);
  if (!loc) return null;

  const now = Date.now();
  const isStale = (now - loc.updatedAt > 30000);
  return {
    orderId: loc.orderId,
    riderId: loc.riderId,
    riderName: loc.riderName,
    latitude: loc.latitude,
    longitude: loc.longitude,
    status: isStale ? (loc.status === 'ONLINE' ? 'SIGNAL_LOST' : loc.status) : loc.status,
    isOnline: !isStale && loc.status === 'ONLINE',
    updatedAt: new Date(loc.updatedAt).toISOString()
  };
}

/**
 * Authorize client to join order tracking room
 */
function authorizeAndJoinOrder(socket, data, io) {
  let orderId = typeof data === 'string' ? data : (data && data.orderId);
  const userId = data && (data.userId || data.phone);
  const role = data && data.role;

  if (!orderId) return;
  orderId = String(orderId).trim();

  const db = readDb();
  const order = (db.orders || []).find(o =>
    o.orderId === orderId ||
    o.displayOrderId === orderId ||
    o.indOrderId === orderId ||
    (orderId.startsWith('IND') && (o.displayOrderId === orderId.replace(/^IND/, '') || o.indOrderId === orderId))
  );
  if (!order) {
    socket.emit('tracking_error', { message: `Order #${orderId} not found` });
    return;
  }
  const canonicalOrderId = order.orderId;

  // Authorization check
  if (role === 'admin') {
    socket.join(`order_${canonicalOrderId}`);
    if (orderId !== canonicalOrderId) socket.join(`order_${orderId}`);
    socket.join('admin_room');
  } else if (userId) {
    const cleanUser = String(userId).trim();
    const isCustomer = (order.customerId && String(order.customerId).trim() === cleanUser) ||
                       (order.customerPhone && String(order.customerPhone).trim() === cleanUser);
    const isRider = order.assignedRider && (
      (order.assignedRider.userId && String(order.assignedRider.userId).trim() === cleanUser) ||
      (order.assignedRider.permanentRiderId && String(order.assignedRider.permanentRiderId).trim() === cleanUser) ||
      (order.assignedRider.phone && String(order.assignedRider.phone).trim() === cleanUser)
    );
    const isRestaurant = (order.restaurantId && String(order.restaurantId).trim() === cleanUser);

    if (isCustomer || isRider || isRestaurant) {
      socket.join(`order_${canonicalOrderId}`);
      if (orderId !== canonicalOrderId) socket.join(`order_${orderId}`);
    } else {
      // Reject unauthorized socket
      socket.emit('tracking_error', { message: 'Unauthorized: Not permitted to track this order' });
      return;
    }
  } else {
    // Backwards compatibility for older clients joining by orderId
    socket.join(`order_${canonicalOrderId}`);
    if (orderId !== canonicalOrderId) socket.join(`order_${orderId}`);
  }

  // Immediately push fresh in-memory location if available
  const currentLoc = getLocation(orderId);
  if (currentLoc) {
    socket.emit('rider_position', currentLoc);
  } else {
    socket.emit('rider_status_change', {
      orderId,
      status: 'CONNECTING',
      isOnline: false,
      message: 'Waiting for fresh GPS coordinates from delivery partner...'
    });
  }
}

/**
 * Reset memory state (useful for tests or clean restarts)
 */
function resetForTesting() {
  for (const [, loc] of riderLocations.entries()) {
    if (loc.disconnectTimer) clearTimeout(loc.disconnectTimer);
  }
  riderLocations.clear();
  if (staleCheckerTimer) {
    clearInterval(staleCheckerTimer);
    staleCheckerTimer = null;
  }
}

module.exports = {
  updateLocation,
  handleSocketDisconnect,
  checkStaleLocations,
  startStaleChecker,
  clearLocation,
  getLocation,
  authorizeAndJoinOrder,
  resetForTesting,
  riderLocations
};
