const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '../../data/database.json');
const TMP_FILE = path.join(__dirname, '../../data/database.json.tmp');

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

let memoryDb = null;
let isFlushingDisk = false;
let flushScheduled = false;

function ensureDbFile() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
}

function normalizeDb(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    parsed = JSON.parse(JSON.stringify(defaultData));
  }
  parsed.promocodes = parsed.promocodes || [];
  parsed.users = parsed.users || [];
  parsed.riders = parsed.riders || [];
  parsed.restaurants = parsed.restaurants || [];
  parsed.orders = parsed.orders || [];
  parsed.shifts = parsed.shifts || defaultData.shifts;
  parsed.wallets = parsed.wallets || defaultData.wallets;
  return parsed;
}

function loadDbFromDisk() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeDb(parsed);
  } catch (e) {
    console.error('Error loading DB from disk, attempting backup or defaults:', e.message);
    return normalizeDb(JSON.parse(JSON.stringify(defaultData)));
  }
}

function flushDbToDiskAtomic() {
  if (isFlushingDisk) {
    flushScheduled = true;
    return;
  }
  isFlushingDisk = true;
  flushScheduled = false;

  try {
    ensureDbFile();
    const dataStr = JSON.stringify(memoryDb, null, 2);
    // Write atomically via temporary file then atomic rename
    fs.writeFileSync(TMP_FILE, dataStr, 'utf-8');
    fs.renameSync(TMP_FILE, DB_FILE);
  } catch (err) {
    console.error('Atomic DB flush error:', err.message);
  } finally {
    isFlushingDisk = false;
    if (flushScheduled) {
      setImmediate(flushDbToDiskAtomic);
    }
  }
}

function readDb() {
  if (!memoryDb) {
    memoryDb = loadDbFromDisk();
  }
  return memoryDb;
}

function writeDb(data) {
  if (data) {
    memoryDb = normalizeDb(data);
  }
  flushDbToDiskAtomic();
  return memoryDb;
}

module.exports = {
  readDb,
  writeDb
};
