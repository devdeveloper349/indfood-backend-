const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '../../data/database.json');

// Initial clean schema defaults - ZERO fake data
const defaultData = {
  users: [
    {
      id: 'usr_admin_1',
      name: 'INDFood Master Admin',
      phone: '9999999999',
      role: 'admin',
      createdAt: new Date().toISOString()
    }
  ],
  riders: [],
  restaurants: [],
  shifts: [
    { id: 'shift_1', name: 'Morning Breakfast', time: '07:30 AM - 11:00 AM', maxSlots: 15, bookedRiders: [] },
    { id: 'shift_2', name: 'Lunch Peak Rush', time: '12:00 PM - 03:30 PM', maxSlots: 30, bookedRiders: [] },
    { id: 'shift_3', name: 'Evening Snacks', time: '04:00 PM - 07:00 PM', maxSlots: 20, bookedRiders: [] },
    { id: 'shift_4', name: 'Dinner Super Peak', time: '07:30 PM - 11:30 PM', maxSlots: 40, bookedRiders: [] },
    { id: 'shift_5', name: 'Late Night Cravings', time: '11:30 PM - 03:00 AM', maxSlots: 10, bookedRiders: [] }
  ],
  orders: [],
  promocodes: [],
  wallets: {
    owner: {
      totalRevenue: 0,
      totalCommission: 0,
      totalPlatformFee: 0,
      totalDeliveryMargin: 0,
      netProfit: 0
    }
  }
};

function ensureDbFile() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
}

function readDb() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    parsed.promocodes = parsed.promocodes || [];
    parsed.users = parsed.users || [];
    parsed.riders = parsed.riders || [];
    parsed.restaurants = parsed.restaurants || [];
    parsed.orders = parsed.orders || [];
    return parsed;
  } catch (e) {
    return defaultData;
  }
}

function writeDb(data) {
  ensureDbFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = {
  readDb,
  writeDb
};
