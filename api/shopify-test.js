// Gradual Shopify integration test
const express = require('express');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test Shopify API imports
let shopifyApi, shopifyApp, Session, ApiVersion;
try {
  console.log('Attempting to import Shopify API...');
  require('@shopify/shopify-api/adapters/node');
  const shopifyModule = require('@shopify/shopify-api');
  shopifyApi = shopifyModule.shopifyApi;
  Session = shopifyModule.Session;
  ApiVersion = shopifyModule.ApiVersion;
  console.log('Shopify API imported successfully');
} catch (error) {
  console.error('Error importing Shopify API:', error);
}

try {
  console.log('Attempting to import Shopify App Express...');
  const shopifyAppModule = require('@shopify/shopify-app-express');
  shopifyApp = shopifyAppModule.shopifyApp;
  console.log('Shopify App Express imported successfully');
} catch (error) {
  console.error('Error importing Shopify App Express:', error);
}

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
    imports: {
      shopifyApi: !!shopifyApi,
      shopifyApp: !!shopifyApp,
      Session: !!Session,
      ApiVersion: !!ApiVersion,
    }
  });
});

// Test Shopify API configuration
app.get('/test-shopify', (req, res) => {
  try {
    if (!shopifyApi || !process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
      return res.status(400).json({
        error: 'Missing Shopify API components',
        hasShopifyApi: !!shopifyApi,
        hasApiKey: !!process.env.SHOPIFY_API_KEY,
        hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
      });
    }

    const shopify = shopifyApi({
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecretKey: process.env.SHOPIFY_API_SECRET,
      scopes: ['read_companies', 'write_companies'],
      hostName: process.env.SHOPIFY_HOSTNAME || 'localhost',
      apiVersion: ApiVersion.January26,
      isEmbeddedApp: true,
    });

    res.json({
      message: 'Shopify API configured successfully',
      apiVersion: '2026-01',
      scopes: ['read_companies', 'write_companies'],
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to configure Shopify API',
      message: error.message,
      stack: error.stack,
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Staff Assignment Manager API - Shopify Test',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: ['/health', '/test-shopify']
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
