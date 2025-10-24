// Simplified Staff Assignment Manager - Just display staff and companies
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Shopify API imports
require('@shopify/shopify-api/adapters/node');
const { shopifyApi, Session, ApiVersion } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');

const app = express();

// Basic middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set required environment variables for Shopify API
process.env.SHOPIFY_HOSTNAME = process.env.SHOPIFY_HOSTNAME || 'localhost';
process.env.SHOPIFY_HOST = process.env.SHOPIFY_HOSTNAME || 'localhost';
process.env.SHOPIFY_API_VERSION = '2026-01';

// Configure Shopify API
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_companies', 'write_companies'],
  hostName: process.env.SHOPIFY_HOSTNAME || 'localhost',
  apiVersion: ApiVersion.January26,
  isEmbeddedApp: true,
});

// Simple in-memory session storage
const memorySessionStorage = {
  sessions: new Map(),
  storeSession: (sessionData) => new Promise((resolve) => {
    const payload = JSON.stringify(sessionData.toPropertyArray());
    const expires = sessionData.expires ? sessionData.expires.getTime() : null;
    memorySessionStorage.sessions.set(sessionData.id, { payload, expires });
    resolve(true);
  }),
  loadSession: (id) => new Promise((resolve) => {
    if (!id) return resolve(null);
    const sessionData = memorySessionStorage.sessions.get(id);
    if (!sessionData) return resolve(null);
    if (sessionData.expires && sessionData.expires < Date.now()) {
      memorySessionStorage.sessions.delete(id);
      return resolve(null);
    }
    try {
      const entries = JSON.parse(sessionData.payload);
      resolve(Session.fromPropertyArray(entries));
    } catch (parseError) {
      console.error('Error parsing session data:', parseError);
      resolve(null);
    }
  }),
  deleteSession: (id) => new Promise((resolve) => {
    memorySessionStorage.sessions.delete(id);
    resolve(true);
  }),
};

// Initialize Shopify App
const shopifyAppMiddleware = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_companies', 'write_companies'],
  hostName: process.env.SHOPIFY_HOSTNAME || 'localhost',
  apiVersion: ApiVersion.January26,
  isEmbeddedApp: true,
  auth: {
    path: '/auth',
    callbackPath: '/auth/callback',
    async afterAuth({ session: shopifySession, req, res }) {
      console.log('Authentication successful for shop:', shopifySession.shop);
      return res.redirect(`/?shop=${shopifySession.shop}`);
    },
  },
  webhooks: {
    path: '/webhooks',
  },
  sessionStorage: memorySessionStorage,
});

// Use Shopify middleware
app.use(shopifyAppMiddleware);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasApiKey: !!process.env.SHOPIFY_API_KEY,
      hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
      hasAppUrl: !!process.env.SHOPIFY_APP_URL,
      apiVersion: process.env.SHOPIFY_API_VERSION,
    },
  });
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    const sessionData = await memorySessionStorage.loadSession(req.query.shop);
    res.json({
      hasSession: !!sessionData,
      sessionShop: sessionData?.shop,
      sessionId: sessionData?.id,
      sessionExpires: sessionData?.expires,
      query: req.query,
      headers: {
        authorization: req.headers.authorization,
        cookie: req.headers.cookie ? 'present' : 'missing',
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Debug endpoint error',
      details: error.message,
    });
  }
});

// Get GraphQL client
const getGraphqlClient = async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) {
      console.log('No shop parameter provided');
      return null;
    }

    const sessionData = await memorySessionStorage.loadSession(shop);
    if (!sessionData) {
      console.log('No session found for shop:', shop);
      return null;
    }

    console.log('Creating GraphQL client for shop:', shop);
    return new shopify.clients.Graphql({ session: sessionData });
  } catch (error) {
    console.error('Error creating GraphQL client:', error);
    return null;
  }
};

// Fetch all companies
const fetchAllCompanies = async (client) => {
  if (!client) {
    console.log('No GraphQL client available, returning empty array');
    return [];
  }

  const query = `
    query getCompanies($first: Int!, $after: String) {
      companies(first: $first, after: $after) {
        edges {
          node {
            id
            name
            externalId
            locations {
              id
              name
              address {
                address1
                address2
                city
                province
                country
                zip
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let hasNextPage = true;
  let cursor = null;
  const all = [];

  while (hasNextPage) {
    try {
      console.log('Fetching companies with cursor:', cursor);
      const response = await client.query({
        data: {
          query,
          variables: { first: 50, after: cursor },
        },
      });

      console.log('Companies response:', JSON.stringify(response.body, null, 2));
      
      if (response.body.errors) {
        console.error('GraphQL errors:', response.body.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(response.body.errors)}`);
      }

      if (!response.body.data || !response.body.data.companies) {
        console.error('No companies data in response');
        throw new Error('No companies data in GraphQL response');
      }

      const { edges, pageInfo } = response.body.data.companies;
      all.push(...edges.map((edge) => edge.node));
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    } catch (error) {
      console.error('Error fetching companies:', error);
      throw error;
    }
  }

  return all;
};

// Fetch all staff (users)
const fetchAllStaff = async (client) => {
  if (!client) {
    console.log('No GraphQL client available, returning empty array');
    return [];
  }

  const query = `
    query getUsers($first: Int!, $after: String) {
      users(first: $first, after: $after) {
        edges {
          node {
            id
            firstName
            lastName
            email
            locale
            permissions
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let hasNextPage = true;
  let cursor = null;
  const all = [];

  while (hasNextPage) {
    try {
      console.log('Fetching staff with cursor:', cursor);
      const response = await client.query({
        data: {
          query,
          variables: { first: 50, after: cursor },
        },
      });

      console.log('Staff response:', JSON.stringify(response.body, null, 2));
      
      if (response.body.errors) {
        console.error('GraphQL errors:', response.body.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(response.body.errors)}`);
      }

      if (!response.body.data || !response.body.data.users) {
        console.error('No users data in response');
        throw new Error('No users data in GraphQL response');
      }

      const { edges, pageInfo } = response.body.data.users;
      all.push(...edges.map((edge) => edge.node));
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    } catch (error) {
      console.error('Error fetching staff:', error);
      throw error;
    }
  }

  return all;
};

// API Routes

// Get companies
app.get('/api/companies', async (req, res) => {
  try {
    console.log('Companies API called');
    const client = await getGraphqlClient(req, res);
    const companies = await fetchAllCompanies(client);
    
    console.log('Returning companies:', companies.length);
    res.json({
      success: true,
      data: companies,
      count: companies.length,
    });
  } catch (error) {
    console.error('Error in companies API:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
    });
  }
});

// Get staff
app.get('/api/staff', async (req, res) => {
  try {
    console.log('Staff API called');
    const client = await getGraphqlClient(req, res);
    const staff = await fetchAllStaff(client);
    
    console.log('Returning staff:', staff.length);
    res.json({
      success: true,
      data: staff,
      count: staff.length,
    });
  } catch (error) {
    console.error('Error in staff API:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
    });
  }
});

// Root endpoint - serve the simplified HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'simple.html'));
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
