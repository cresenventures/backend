require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');

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

app.use(cors());
app.use(bodyParser.json());

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
    // Upsert user with role 'customer'
    const update = {
      $setOnInsert: { createdAt: new Date() },
      $set: { email, role: 'customer', updatedAt: new Date() }
    };
    const result = await collection.findOneAndUpdate(
      { email },
      update,
      { upsert: true, returnDocument: 'after' }
    );
    if (result.lastErrorObject && result.lastErrorObject.updatedExisting) {
      console.log('User updated:', result.value);
    } else {
      console.log('User created:', result.value);
    }
    res.json({ success: true, user: result.value });
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

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
