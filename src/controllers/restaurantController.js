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
  const { name, phone, address, cuisine = 'North Indian, Snacks' } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ success: false, message: 'Restaurant name and phone are required' });
  }

  const db = readDb();
  let rest = db.restaurants.find(r => r.phone === phone);
  if (!rest) {
    const id = `rest_${Date.now().toString(36)}`;
    rest = {
      id,
      name,
      phone,
      address: address || 'Main Market, City Center',
      cuisine,
      latitude: 28.6139,
      longitude: 77.2090,
      commissionPercent: 15,
      isActive: true,
      isOpen: true,
      menu: [],
      createdAt: new Date().toISOString()
    };
    db.restaurants.push(rest);
    writeDb(db);
  }

  return res.json({ success: true, message: 'Restaurant registered successfully!', restaurant: rest });
}

function addMenuItem(req, res) {
  const { restaurantId, name, price, isVeg = true, category = 'Main Course', image = '' } = req.body;
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
    price: parseFloat(price) || 0,
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
  addMenuItem,
  toggleItemAvailability,
  toggleRestaurantStatus
};
