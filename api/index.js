const express = require('express');
const app = express();

// Basic test route
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Shopify Staff Assignment App is running!',
    timestamp: new Date().toISOString(),
    env: {
      hasApiKey: !!process.env.SHOPIFY_API_KEY,
      hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
      hasAppUrl: !!process.env.SHOPIFY_APP_URL,
      hasSessionSecret: !!process.env.SESSION_SECRET
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Test route for Shopify auth
app.get('/auth', (req, res) => {
  res.json({ 
    message: 'Auth endpoint reached',
    shop: req.query.shop || 'no shop parameter',
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

module.exports = app;