const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '../../data/database.json');
const TMP_FILE = path.join(__dirname, '../../data/database.json.tmp');
const BAK_FILE = path.join(__dirname, '../../data/database.json.bak');

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
  settings: {
    businessName: 'INDFood',
    businessUpiId: process.env.BUSINESS_UPI_ID || '9174782706@ybl',
    riderPerKmRate: 12.00,
    riderIncentiveBonus: 15.00,
    riderIncentiveActive: true,
    riderMinBasePay: 0.00,
    defaultRestaurantCommission: 15.00,
    defaultPlatformFee: 8.00,
    customerBaseDeliveryFee: 30.00,
    customerPerKmDeliveryFee: 12.50
  },
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
    try { fs.copyFileSync(DB_FILE, BAK_FILE); } catch(e) {}
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
  parsed.settings = Object.assign({
    businessName: process.env.BUSINESS_NAME || 'INDFood',
    businessUpiId: process.env.BUSINESS_UPI_ID || '9174782706@ybl',
    riderPerKmRate: parseFloat(process.env.PER_KM_RIDER_RATE || '12.00'),
    riderIncentiveBonus: 15.00,
    riderIncentiveActive: true,
    riderMinBasePay: 0.00,
    defaultRestaurantCommission: parseFloat(process.env.DEFAULT_RESTAURANT_COMMISSION_PERCENT || '15'),
    defaultPlatformFee: parseFloat(process.env.DEFAULT_PLATFORM_FEE || '8.00'),
    customerBaseDeliveryFee: parseFloat(process.env.BASE_CUSTOMER_DELIVERY_FEE || '30.00'),
    customerPerKmDeliveryFee: parseFloat(process.env.PER_KM_CUSTOMER_DELIVERY_FEE || '12.50')
  }, parsed.settings || {});
  return parsed;
}

function loadDbFromDisk() {
  ensureDbFile();
  // 1. Try reading the primary DB file
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    if (raw && raw.trim().length > 10) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // Keep backup in sync with verified healthy state
        try { fs.copyFileSync(DB_FILE, BAK_FILE); } catch(e) {}
        return normalizeDb(parsed);
      }
    }
  } catch (e) {
    console.error('Primary DB file error, attempting recovery from backup:', e.message);
  }

  // 2. Recovery: Try loading from backup file
  try {
    if (fs.existsSync(BAK_FILE)) {
      const bakRaw = fs.readFileSync(BAK_FILE, 'utf-8');
      if (bakRaw && bakRaw.trim().length > 10) {
        const bakParsed = JSON.parse(bakRaw);
        if (bakParsed && typeof bakParsed === 'object') {
          console.warn('⚠️ Recovered INDFood DB from healthy backup file!');
          fs.writeFileSync(DB_FILE, bakRaw, 'utf-8');
          return normalizeDb(bakParsed);
        }
      }
    }
  } catch (bakErr) {
    console.error('Backup recovery error:', bakErr.message);
  }

  console.warn('⚠️ Both primary and backup DB unavailable, initializing clean schema defaults');
  return normalizeDb(JSON.parse(JSON.stringify(defaultData)));
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
    if (!memoryDb || typeof memoryDb !== 'object') {
      return;
    }
    const dataStr = JSON.stringify(memoryDb, null, 2);
    if (!dataStr || dataStr.length < 50) {
      console.error('Refusing to flush corrupt or empty DB string');
      return;
    }

    // Write atomically via temporary file then atomic rename
    fs.writeFileSync(TMP_FILE, dataStr, 'utf-8');
    
    // Verify tmp file exists and has content before replacement
    const stat = fs.statSync(TMP_FILE);
    if (stat.size > 50) {
      // Rotate existing DB to backup
      try {
        if (fs.existsSync(DB_FILE)) {
          fs.copyFileSync(DB_FILE, BAK_FILE);
        }
      } catch (cpErr) {}

      fs.renameSync(TMP_FILE, DB_FILE);
    }
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

// Ensure flush on process exit
process.on('exit', () => {
  if (memoryDb) {
    try {
      const dataStr = JSON.stringify(memoryDb, null, 2);
      fs.writeFileSync(DB_FILE, dataStr, 'utf-8');
    } catch(e) {}
  }
});

module.exports = {
  readDb,
  writeDb
};
