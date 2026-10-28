const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);

// Enable Socket.IO
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// JSON / payload error handler
app.use((err, req, res, next) => {
  if (err) {
    console.error('Server error:', err.message);
    return res.status(err.status || 400).json({ success: false, message: err.message });
  }
  next();
});

// Socket.io real-time connection
io.on('connection', (socket) => {
  console.log('⚡ Client connected to INDFood Live Socket:', socket.id);

  socket.on('join_order', (orderId) => {
    socket.join(`order_${orderId}`);
  });

  socket.on('rider_location_update', (data) => {
    const { orderId, latitude, longitude, riderId } = data;
    io.to(`order_${orderId}`).emit('rider_position', {
      latitude,
      longitude,
      riderId,
      updatedAt: new Date().toISOString()
    });
  });

  socket.on('order_status_change', (data) => {
    const { orderId, status } = data;
    io.to(`order_${orderId}`).emit('order_status_updated', {
      orderId,
      status,
      timestamp: new Date().toISOString()
    });
    io.emit('global_order_update', data);
  });

  socket.on('broadcast_promocode', (data) => {
    io.emit('promocode_splash', data);
  });

  socket.on('disconnect', () => {
    // disconnected
  });
});

app.use((req, res, next) => {
  req.io = io;
  next();
});

// Mount API routes
app.use('/api', apiRoutes);

// Health check & Root routes for Render Cloud
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'INDFood Master Backend',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'INDFood Master Backend',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 INDFood Backend Server running on http://0.0.0.0:${PORT}`);
  console.log(`💳 Razorpay Gateway Initialized with Key: ${process.env.RAZORPAY_KEY_ID}`);

  // Self-Ping Keep-Alive: Prevents Render free instance from sleeping
  const https = require('https');
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://indfood-backend-la4k.onrender.com';
  setInterval(() => {
    https.get(`${RENDER_URL}/health`, (res) => {
      // server warm
    }).on('error', () => {});
  }, 8 * 60 * 1000); // ping every 8 mins
});
