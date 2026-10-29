const { readDb, writeDb } = require('../models/db');

/**
 * Admin creates & broadcasts a promo code
 */
function broadcastPromoCode(req, res) {
  try {
    const { code, discount, minOrder = 0, title, description } = req.body;
    if (!code || discount === undefined || discount === null) {
      return res.status(400).json({ success: false, message: 'Promocode name aur discount amount zaroori hai!' });
    }

    const cleanCode = code.toString().trim().toUpperCase();
    const discountVal = parseFloat(discount);
    const minOrderVal = parseFloat(minOrder) || 0;

    if (isNaN(discountVal) || discountVal <= 0) {
      return res.status(400).json({ success: false, message: 'Discount amount valid number hona chahiye!' });
    }

    const db = readDb();
    db.promocodes = db.promocodes || [];

    let existing = db.promocodes.find(p => p.code === cleanCode);
    if (existing) {
      existing.discount = discountVal;
      existing.minOrder = minOrderVal;
      existing.active = true;
      existing.updatedAt = new Date().toISOString();
      if (title) existing.title = title;
      if (description) existing.description = description;
    } else {
      existing = {
        id: `promo_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        code: cleanCode,
        discount: discountVal,
        minOrder: minOrderVal,
        title: title || `Special ₹${discountVal} FLAT OFF!`,
        description: description || `Use code ${cleanCode} and get flat ₹${discountVal} OFF on your order.`,
        active: true,
        usedBy: [], // phone numbers of customers who redeemed
        createdAt: new Date().toISOString()
      };
      db.promocodes.unshift(existing);
    }

    writeDb(db);

    // Real-time broadcast via Socket.IO to all connected customer apps
    if (req.io) {
      req.io.emit('promocode_splash', {
        id: existing.id,
        code: existing.code,
        discount: existing.discount,
        minOrder: existing.minOrder,
        title: existing.title,
        description: existing.description,
        timestamp: new Date().toISOString()
      });
      console.log(`📢 Real-time Promo Code Broadcasted: ${existing.code} (₹${existing.discount} OFF)`);
    }

    return res.json({
      success: true,
      message: `🎉 Promocode '${cleanCode}' successfully broadcasted to all customer apps!`,
      promo: existing
    });
  } catch (err) {
    console.error('Broadcast promocode error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Get all active promocodes (for customer app launch & splash check)
 */
function getActivePromoCodes(req, res) {
  try {
    const db = readDb();
    const active = (db.promocodes || []).filter(p => p.active !== false);
    return res.json({
      success: true,
      promocodes: active
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Get all promocodes for Admin dashboard
 */
function getAllPromoCodesAdmin(req, res) {
  try {
    const db = readDb();
    return res.json({
      success: true,
      promocodes: db.promocodes || []
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Apply and validate promo code for customer
 */
function applyPromoCode(req, res) {
  try {
    const { code, customerPhone, customerEmail, cartTotal = 0 } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Promocode enter kijiye!' });
    }

    const cleanCode = code.toString().trim().toUpperCase();
    const userIdentifier = (customerPhone || customerEmail || 'guest_user').toString().trim();
    const total = parseFloat(cartTotal) || 0;

    const db = readDb();
    const promo = (db.promocodes || []).find(p => p.code === cleanCode && p.active !== false);

    if (!promo) {
      return res.status(404).json({ success: false, message: 'Promocode galat hai ya expire ho chuka hai!' });
    }

    // Check single-use restriction per customer
    if (promo.usedBy && userIdentifier !== 'guest_user' && promo.usedBy.includes(userIdentifier)) {
      return res.status(400).json({
        success: false,
        message: `Aap yeh promocode '${cleanCode}' pehle hi 1 baar use kar chuke hain! Yeh single-use offer hai.`
      });
    }

    // Check minimum order restriction
    if (promo.minOrder && total < promo.minOrder) {
      return res.status(400).json({
        success: false,
        message: `Yeh code minimum ₹${promo.minOrder} ke cart total par valid hai! (Current total: ₹${total})`
      });
    }

    const discountAmount = Math.min(promo.discount, total > 0 ? total : promo.discount);
    return res.json({
      success: true,
      message: `Coupon '${cleanCode}' applied! Flat ₹${discountAmount} discount mila.`,
      code: promo.code,
      discount: discountAmount,
      minOrder: promo.minOrder
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Admin toggles or deletes a promocode
 */
function togglePromoStatus(req, res) {
  try {
    const { promoId } = req.body;
    const db = readDb();
    const promo = (db.promocodes || []).find(p => p.id === promoId || p.code === promoId);
    if (!promo) {
      return res.status(404).json({ success: false, message: 'Promocode not found' });
    }
    promo.active = !promo.active;
    writeDb(db);
    return res.json({ success: true, message: `Promo code ${promo.active ? 'Activated' : 'Deactivated'}`, promo });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  broadcastPromoCode,
  getActivePromoCodes,
  getAllPromoCodesAdmin,
  applyPromoCode,
  togglePromoStatus
};
