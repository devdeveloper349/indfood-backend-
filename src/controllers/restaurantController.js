const { readDb, writeDb } = require('../models/db');
const { v4: uuidv4 } = require('uuid');

function getAllRestaurants(req, res) {
  const db = readDb();
  return res.json({ success: true, restaurants: db.restaurants });
}

function getRestaurantById(req, res) {
  const { id } = req.params;
  const db = readDb();
  const rest = db.restaurants.find(r => r.id === id);
  if (!rest) {
    return res.status(404).json({ success: false, message: 'Restaurant not found' });
  }
  return res.json({ success: true, restaurant: rest });
}

function registerRestaurant(req, res) {
  const { name, phone, address, cuisine = 'North Indian, Snacks', latitude, longitude, ownerEmail } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ success: false, message: 'Restaurant name and phone are required' });
  }

  const cleanPhone = phone.toString().trim().replace(/\D/g, '').slice(-10);
  const db = readDb();
  let rest = db.restaurants.find(r => r.phone === cleanPhone || (ownerEmail && r.ownerEmail === ownerEmail));
  
  const hasValidLat = latitude !== undefined && latitude !== null && !isNaN(parseFloat(latitude));
  const hasValidLng = longitude !== undefined && longitude !== null && !isNaN(parseFloat(longitude));
  const lat = hasValidLat ? parseFloat(latitude) : null;
  const lng = hasValidLng ? parseFloat(longitude) : null;

  if (!rest) {
    const id = `rest_${Date.now().toString(36)}`;
    rest = {
      id,
      name: name.trim(),
      phone: cleanPhone,
      ownerEmail: ownerEmail || '',
      address: address ? address.trim() : 'Location not set yet',
      cuisine: cuisine.trim(),
      latitude: lat,
      longitude: lng,
      commissionPercent: 15,
      isActive: true,
      isOpen: true,
      menu: [],
      createdAt: new Date().toISOString()
    };
    db.restaurants.push(rest);
    writeDb(db);
  } else {
    // Update existing restaurant with custom owner details
    rest.name = name.trim();
    if (address) rest.address = address.trim();
    if (hasValidLat) rest.latitude = lat;
    if (hasValidLng) rest.longitude = lng;
    if (cuisine) rest.cuisine = cuisine.trim();
    if (ownerEmail) rest.ownerEmail = ownerEmail;
    writeDb(db);
  }

  return res.json({ success: true, message: 'Restaurant registered successfully!', restaurant: rest });
}

function updateRestaurantLocation(req, res) {
  const { restaurantId, latitude, longitude, address } = req.body;
  const db = readDb();
  const rest = db.restaurants.find(r => r.id === restaurantId);
  if (!rest) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  if (latitude !== undefined && latitude !== null && !isNaN(parseFloat(latitude))) {
    rest.latitude = parseFloat(latitude);
  }
  if (longitude !== undefined && longitude !== null && !isNaN(parseFloat(longitude))) {
    rest.longitude = parseFloat(longitude);
  }
  if (address) {
    rest.address = address;
  }
  writeDb(db);

  return res.json({ success: true, message: 'Restaurant location updated successfully!', restaurant: rest });
}

function addMenuItem(req, res) {
  const { restaurantId, name, description = '', price, rating = 4.5, isVeg = true, category = 'Main Course', image = '' } = req.body;
  if (!restaurantId || !name || price === undefined || price === null || price === '') {
    return res.status(400).json({ success: false, message: 'Restaurant ID, item name, and price are required' });
  }

  const db = readDb();
  const rest = db.restaurants.find(r => r.id === restaurantId);
  if (!rest) {
    return res.status(404).json({ success: false, message: 'Restaurant not found' });
  }

  if (!Array.isArray(rest.menu)) {
    rest.menu = [];
  }

  const newItem = {
    id: `m_${Date.now().toString(36)}`,
    name: String(name).trim(),
    description: String(description || '').trim(),
    price: parseFloat(price) || 0,
    rating: parseFloat(rating) || 4.5,
    isVeg: Boolean(isVeg),
    category: category || 'Main Course',
    image: image || '',
    isAvailable: true
  };

  rest.menu.push(newItem);
  writeDb(db);

  return res.json({ success: true, message: 'Menu item added successfully', item: newItem, menu: rest.menu });
}

function toggleItemAvailability(req, res) {
  const { restaurantId, itemId } = req.body;
  const db = readDb();
  const rest = db.restaurants.find(r => r.id === restaurantId);
  if (!rest) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  const item = rest.menu.find(m => m.id === itemId);
  if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

  item.isAvailable = item.isAvailable === false ? true : false;
  writeDb(db);

  return res.json({ success: true, message: `Item is now ${item.isAvailable ? 'In Stock' : 'Out of Stock'}`, item });
}

function toggleRestaurantStatus(req, res) {
  const { restaurantId } = req.body;
  const db = readDb();
  const rest = db.restaurants.find(r => r.id === restaurantId);
  if (!rest) return res.status(404).json({ success: false, message: 'Restaurant not found' });

  rest.isOpen = rest.isOpen === false ? true : false;
  writeDb(db);

  return res.json({ success: true, message: `Restaurant is now ${rest.isOpen ? 'ONLINE' : 'OFFLINE'}`, isOpen: rest.isOpen });
}

module.exports = {
  getAllRestaurants,
  getRestaurantById,
  registerRestaurant,
  updateRestaurantLocation,
  addMenuItem,
  toggleItemAvailability,
  toggleRestaurantStatus
};
