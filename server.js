require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const ENCRYPTION_KEY = 'pypyabcd'; // 8 chars for DES, 16/24/32 for AES
const IV = '1234567890123456'; // 16 chars for AES

function encrypt(text) {
  const cipher = crypto.createCipheriv('aes-128-cbc', ENCRYPTION_KEY, IV);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decrypt(encrypted) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', ENCRYPTION_KEY, IV);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Make sure you have a .env file in backend/ with:
// MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/<dbname>?retryWrites=true&w=majority

const app = express();
const PORT = process.env.PORT || 5000;

// MongoDB setup
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error('MONGODB_URI not set in environment. Please create a .env file in backend/ with your MongoDB connection string.');
}
const mongoClient = new MongoClient(mongoUri);
let mongoDb;

mongoClient.connect()
  .then(client => {
    mongoDb = client.db(); // DB name is in URI
    console.log('Connected to MongoDB');
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
  });

// Allow CORS only from your frontend domain
app.use(cors({
  origin: 'https://cresenthermalpaperrolls.com',
  credentials: true,
}));
app.use(bodyParser.json());

// Log all incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Initialize Razorpay SDK
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Example function to save customer data
async function saveCustomerData(customer) {
  if (!mongoDb) throw new Error('MongoDB not connected');
  const collection = mongoDb.collection('customers');
  await collection.insertOne(customer);
  console.log('Customer data saved:', customer);
}

// Add API endpoint to create or update user on Google login
app.post('/api/google-login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    if (!mongoDb) return res.status(500).json({ error: 'DB not connected' });
    const collection = mongoDb.collection('users');
    // Case-insensitive email match
    let user = await collection.findOne({ email: { $regex: `^${email}$`, $options: 'i' } });
    if (!user) {
      // If user does not exist, create as customer by default
      const insertResult = await collection.insertOne({ email, role: 'customer', createdAt: new Date(), updatedAt: new Date() });
      user = await collection.findOne({ _id: insertResult.insertedId });
    }
    res.json({ success: true, user });
  } catch (err) {
    console.error('Google login DB error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Save cart for a user
app.post('/api/save-cart', async (req, res) => {
  const { email, cart } = req.body;
  if (!email || !Array.isArray(cart)) return res.status(400).json({ error: 'Email and cart are required' });
  try {
    if (!mongoDb) return res.status(500).json({ error: 'DB not connected' });
    const collection = mongoDb.collection('cart');
    const update = {
      $set: { email, cart, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() }
    };
    const result = await collection.findOneAndUpdate(
      { email },
      update,
      { upsert: true, returnDocument: 'after' }
    );
    console.log('Cart saved for user:', email, cart);
    res.json({ success: true });
  } catch (err) {
    console.error('Save cart DB error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Get cart for a user
app.post('/api/get-cart', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    if (!mongoDb) return res.status(500).json({ error: 'DB not connected' });
    const collection = mongoDb.collection('cart');
    const doc = await collection.findOne({ email });
    res.json({ success: true, cart: doc ? doc.cart : [] });
  } catch (err) {
    console.error('Get cart DB error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Save shipping address for a user
app.post('/api/save-shipping', async (req, res) => {
  const { email, shipping } = req.body;
  if (!email || !shipping) return res.status(400).json({ error: 'Email and shipping details are required' });
  try {
    if (!mongoDb) return res.status(500).json({ error: 'Database not connected' });
    const collection = mongoDb.collection('customers');
    // Update or insert the shipping address for the user
    await collection.updateOne(
      { email },
      { $set: { shipping } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save shipping address' });
  }
});

// Calculate shipping fee using Shiprocket API
app.post('/api/calculate-shipping', async (req, res) => {
  const { email, shipping, cart } = req.body;
  if (!email || !shipping) return res.status(400).json({ error: 'Email and shipping details are required' });

  try {
    // Save shipping address as before (optional)
    const collection = mongoDb.collection('customers');
    await collection.updateOne(
      { email },
      { $set: { shipping } },
      { upsert: true }
    );

    // Prepare Shiprocket API request
    const shiprocketToken = 'YOUR_SHIPROCKET_TOKEN'; // Replace with your Shiprocket token
    const shiprocketUrl = 'https://apiv2.shiprocket.in/v1/external/courier/serviceability/';
    const payload = {
      pickup_postcode: '683572', // Always use this as pickup pin
      delivery_postcode: shipping.pincode,
      cod: 0,
      weight: 1, // in kg, adjust as needed
      // ...other required fields
    };

    const shiprocketRes = await fetch(shiprocketUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${shiprocketToken}`
      },
      body: JSON.stringify(payload)
    });

    const shiprocketData = await shiprocketRes.json();
    const shippingFee = shiprocketData.data?.available_courier_companies?.[0]?.rate || 0;

    res.json({ success: true, shippingFee });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate shipping fee' });
  }
});

// Save attempted order to database
app.post('/api/save-attempted-order', async (req, res) => {
  let { name, email, phone, items, shippingAddress, shippingFee } = req.body;
  if (!name || !email || !phone || !items || !shippingAddress) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  try {
    if (!mongoDb) return res.status(500).json({ success: false, error: 'DB not connected' });
    // Ensure shippingAddress contains name and phone
    shippingAddress = {
      ...shippingAddress,
      name: shippingAddress.name || name,
      phone: shippingAddress.phone || phone,
    };
    const collection = mongoDb.collection('attempted_orders');
    const doc = {
      name,
      email,
      phone,
      items,
      shippingAddress, // Always save shipping details
      shippingFee,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // Upsert: update if exists, else insert (one attempted order per email)
    const existing = await collection.findOne({ email });
    if (existing) {
      await collection.updateOne(
        { email },
        {
          $set: {
            name,
            phone,
            items,
            shippingAddress,
            shippingFee,
            updatedAt: new Date(),
          }
        }
      );
    } else {
      await collection.insertOne(doc);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Save attempted order error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Save paid order to database
app.post('/api/save-order', async (req, res) => {
  console.log('Received order:', req.body); // Debug log
  const { name, email, phone, items, shippingAddress, shippingFee, paymentId } = req.body;
  if (!name || !email || !phone || !items || !shippingAddress || !paymentId) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  try {
    if (!mongoDb) return res.status(500).json({ success: false, message: 'DB not connected' });
    const collection = mongoDb.collection('orders');
    const doc = {
      name,
      email,
      phone,
      items,
      shippingAddress,
      shippingFee,
      paymentId,
      status: 'placed',
      createdAt: new Date()
    };
    await collection.insertOne(doc);
    // Remove attempted order for this user and items
    const attemptedCollection = mongoDb.collection('attempted_orders');
    await attemptedCollection.deleteMany({ email, 'items.title': { $in: items.map(i => i.title) } });
    res.json({ success: true });
  } catch (err) {
    console.error('Save order DB error:', err);
    res.status(500).json({ success: false, message: 'DB error' });
  }
});

// Copy attempted order to orders with status 'preparing' (no paymentId required)
app.post('/api/confirm-order', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
  try {
    if (!mongoDb) return res.status(500).json({ success: false, message: 'DB not connected' });
    const attemptedCollection = mongoDb.collection('attempted_orders');
    const orderCollection = mongoDb.collection('orders');
    const attempted = await attemptedCollection.findOne({ email });
    if (!attempted) return res.status(404).json({ success: false, message: 'No attempted order found' });
    // Copy all fields except _id
    const { _id, ...orderData } = attempted;
    orderData.status = 'preparing';
    orderData.createdAt = new Date();
    await orderCollection.insertOne(orderData);
    // Optionally, remove attempted order after copying
    await attemptedCollection.deleteOne({ email });
    res.json({ success: true });
  } catch (err) {
    console.error('Confirm order error:', err);
    res.status(500).json({ success: false, message: 'DB error' });
  }
});

// Get latest attempted order for a user (GET)
app.get('/api/get-latest-attempted-order', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
  try {
    if (!mongoDb) return res.status(500).json({ success: false, error: 'DB not connected' });
    const collection = mongoDb.collection('attempted_orders');
    // Find the latest attempted order for the user, sorted by creation date
    const order = await collection.find({ email }).sort({ createdAt: -1 }).limit(1).toArray();
    if (!order.length) return res.status(404).json({ success: false, error: 'No attempted order found' });
    res.json({ success: true, order: order[0] });
  } catch (err) {
    console.error('Get latest attempted order error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Get all paid orders for a user (GET)
app.get('/api/get-orders', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
  try {
    if (!mongoDb) return res.status(500).json({ success: false, error: 'DB not connected' });
    const collection = mongoDb.collection('orders');
    // Find all paid orders for the user, sorted by creation date (latest first)
    const orders = await collection.find({ email }).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, orders });
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Admin: Get all orders for admin panel
app.get('/api/admin-orders', async (req, res) => {
  const tab = req.query.tab;
  console.log(`[ADMIN ORDERS] Request received. Tab: ${tab}`); // Log incoming request
  if (!mongoDb) return res.status(500).json({ success: false, error: 'DB not connected' });
  try {
    if (tab === 'attempted') {
      // Return all attempted orders
      const attemptedOrders = await mongoDb.collection('attempted_orders').find({}).sort({ createdAt: -1 }).toArray();
      console.log(`[ADMIN ORDERS] Attempted orders count: ${attemptedOrders.length}`);
      return res.json({ success: true, orders: attemptedOrders });
    } else {
      // For 'new' and 'dispatched', return from orders collection, filter by status if needed
      let status = undefined;
      if (tab === 'new') status = 'preparing';
      if (tab === 'dispatched') status = 'dispatched';
      const query = status ? { status } : {};
      const orders = await mongoDb.collection('orders').find(query).sort({ createdAt: -1 }).toArray();
      console.log(`[ADMIN ORDERS] Orders count for status '${status}': ${orders.length}`);
      return res.json({ success: true, orders });
    }
  } catch (err) {
    console.error('Admin orders error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Admin: Update shipping code and status for an order
app.post('/api/admin-update-shipping', async (req, res) => {
  const { orderId, shippingCode } = req.body;
  if (!orderId || !shippingCode) {
    return res.status(400).json({ success: false, error: 'orderId and shippingCode are required' });
  }
  // Validate orderId format
  if (typeof orderId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(orderId)) {
    return res.status(400).json({ success: false, error: 'Invalid orderId format' });
  }
  try {
    if (!mongoDb) return res.status(500).json({ success: false, error: 'DB not connected' });
    const orders = mongoDb.collection('orders');
    const order = await orders.findOne({ _id: new ObjectId(orderId) });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    const update = { shippingCode };
    if (order.status !== 'dispatched') update.status = 'dispatched';
    await orders.updateOne(
      { _id: new ObjectId(orderId) },
      { $set: update }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Admin update shipping error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// API endpoint to create a Razorpay order
app.post('/api/create-razorpay-order', async (req, res) => {
  const { amount, currency = 'INR', receipt } = req.body;
  console.log('Received create-razorpay-order request:', req.body); // Debug log
  if (!amount) {
    console.log('Amount missing in request');
    return res.status(400).json({ success: false, error: 'Amount is required' });
  }
  try {
    const options = {
      amount: Math.round(amount), // amount in paise
      currency,
      receipt: receipt || `rcpt_${Date.now()}`,
    };
    const order = await razorpay.orders.create(options);
    console.log('Razorpay order created:', order); // Debug log
    res.json({ success: true, order });
  } catch (err) {
    console.error('Razorpay order creation error:', err, err && err.error && err.error.description);
    res.status(500).json({ success: false, error: 'Failed to create Razorpay order', details: err && err.error && err.error.description });
  }
});

// Endpoint to provide Razorpay public key to frontend
app.get('/api/get-razorpay-key', (req, res) => {
  if (process.env.RAZORPAY_KEY_ID) {
    res.json({ success: true, key: process.env.RAZORPAY_KEY_ID });
  } else {
    res.status(500).json({ success: false, message: 'Razorpay key not configured' });
  }
});

// TEMPORARY: Clear all orders and attempted_orders collections (for development only)
// Requires a secret token in the request header: x-clear-db-token (encrypted)
app.post('/api/clear-db', async (req, res) => {
  const AUTH_TOKEN = 'pypyabcd';
  const clientTokenEncrypted = req.headers['x-clear-db-token'];
  if (!clientTokenEncrypted) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  let clientToken;
  try {
    clientToken = decrypt(clientTokenEncrypted);
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Invalid token (decrypt failed)' });
  }
  if (clientToken !== AUTH_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (!mongoDb) return res.status(500).json({ success: false, error: 'DB not connected' });
  try {
    await mongoDb.collection('attempted_orders').deleteMany({});
    await mongoDb.collection('orders').deleteMany({});
    res.json({ success: true, message: 'Database cleared' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test POST endpoint to verify POST proxying and backend connectivity
app.post('/api/test-post', (req, res) => {
  console.log('Received test POST:', req.body);
  res.json({ success: true, message: 'POST works', body: req.body });
});

// Catch-all for unhandled API routes: always return JSON, not HTML
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// Catch-all for all other routes (frontend)
app.use((req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
