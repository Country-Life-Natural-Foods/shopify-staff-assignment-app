// Minimal test version to isolate the FUNCTION_INVOCATION_FAILED error
const express = require('express');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasApiKey: !!process.env.SHOPIFY_API_KEY,
      hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
      hasAppUrl: !!process.env.SHOPIFY_APP_URL,
      nodeEnv: process.env.NODE_ENV,
    },
  });
});

// Simple test endpoint
app.get('/test', (req, res) => {
  res.json({ message: 'Test endpoint working' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Staff Assignment Manager API',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

// Export for Vercel
module.exports = app;
