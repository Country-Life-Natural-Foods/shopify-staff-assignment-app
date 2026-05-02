// Simplified Staff Assignment Manager — separate Vercel function at /api/simple
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('@shopify/shopify-api/adapters/node');

const { Session, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  frameGuard: false,
}));
app.use(cors());
app.use(cookieParser());

app.use((req, res, next) => {
  const shop = req.query.shop;
  const frameAncestors = shop
    ? `https://${shop} https://admin.shopify.com`
    : 'https://admin.shopify.com https://*.myshopify.com';
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors};`);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// VERCEL_URL is auto-set (hostname only, no protocol). Avoid empty hostName on Vercel.
const vercelHost = process.env.VERCEL_URL
  ? process.env.VERCEL_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')
  : '';

const hostName =
  process.env.SHOPIFY_HOSTNAME ||
  process.env.HOST?.replace(/^https?:\/\//, '') ||
  process.env.SHOPIFY_APP_URL?.replace(/^https?:\/\//, '') ||
  vercelHost ||
  'localhost';

const hostScheme =
  process.env.HOST?.startsWith('https') ? 'https'
    : process.env.NODE_ENV === 'production' ? 'https'
      : 'http';

const memorySessionStorage = {
  sessions: new Map(),
  storeSession(sessionData) {
    return new Promise((resolve) => {
      const payload = JSON.stringify(sessionData.toPropertyArray());
      const expires = sessionData.expires ? sessionData.expires.getTime() : null;
      this.sessions.set(sessionData.id, { payload, expires });
      resolve(true);
    });
  },
  loadSession(id) {
    return new Promise((resolve) => {
      if (!id) return resolve(null);
      const sessionData = this.sessions.get(id);
      if (!sessionData) return resolve(null);
      if (sessionData.expires && sessionData.expires < Date.now()) {
        this.sessions.delete(id);
        return resolve(null);
      }
      try {
        const entries = JSON.parse(sessionData.payload);
        resolve(Session.fromPropertyArray(entries));
      } catch (parseError) {
        console.error('Error parsing session data:', parseError);
        resolve(null);
      }
    });
  },
  deleteSession(id) {
    return new Promise((resolve) => {
      this.sessions.delete(id);
      resolve(true);
    });
  },
  async findSessionsByShop(shopDomain) {
    const needle = String(shopDomain || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '');
    const matches = [];
    for (const id of this.sessions.keys()) {
      const s = await this.loadSession(id);
      if (s && String(s.shop || '').toLowerCase() === needle) {
        matches.push(s);
      }
    }
    return matches;
  },
  async deleteSessions(ids) {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
  },
};

// Must use nested `api: { ... }` — flat keys are ignored and hostName stays missing.
const shopifyAppInstance = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY || 'dummy_key',
    apiSecretKey: process.env.SHOPIFY_API_SECRET || 'dummy_secret',
    scopes: ['read_companies', 'write_companies', 'read_users'],
    hostName,
    hostScheme,
    apiVersion: LATEST_API_VERSION,
    isEmbeddedApp: true,
  },
  auth: {
    path: '/auth',
    callbackPath: '/auth/callback',
    async afterAuth({ session: shopifySession, req, res }) {
      req.session.shop = shopifySession.shop;
      req.session.shopSessionId = shopifySession.id;
      console.log('Authentication successful for shop:', shopifySession.shop);
      return res.redirect(`/?shop=${shopifySession.shop}`);
    },
  },
  webhooks: {
    path: '/webhooks',
  },
  sessionStorage: memorySessionStorage,
});

const shopify = shopifyAppInstance.api;

app.get(shopifyAppInstance.config.auth.path, shopifyAppInstance.auth.begin());
app.get(
  shopifyAppInstance.config.auth.callbackPath,
  shopifyAppInstance.auth.callback(),
  shopifyAppInstance.redirectToShopifyOrAppRoot(),
);
app.post(
  shopifyAppInstance.config.webhooks.path,
  ...shopifyAppInstance.processWebhooks({ webhookHandlers: {} }),
);

const loadActiveSession = async (req, res) => {
  if (res?.locals?.shopify?.session) {
    return res.locals.shopify.session;
  }
  const rawShop = req.query.shop;
  if (rawShop) {
    try {
      const shop = shopify.utils.sanitizeShop(rawShop);
      const offlineId = shopify.session.getOfflineId(shop);
      const offlineSession = await memorySessionStorage.loadSession(offlineId);
      if (offlineSession) return offlineSession;
    } catch (e) {
      console.warn('loadActiveSession: offline lookup failed', e.message);
    }
  }
  const sessionId = req.session?.shopSessionId;
  if (!sessionId) return null;
  return memorySessionStorage.loadSession(sessionId);
};

const getGraphqlClient = async (req, res) => {
  const sessionData = await loadActiveSession(req, res);
  if (!sessionData) return null;
  return new shopify.clients.Graphql({ session: sessionData });
};

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hostName,
    env: {
      hasApiKey: !!process.env.SHOPIFY_API_KEY,
      hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
      hasAppUrl: !!process.env.SHOPIFY_APP_URL,
      hasVercelUrl: !!process.env.VERCEL_URL,
    },
  });
});

app.get('/debug', async (req, res) => {
  try {
    const s = await loadActiveSession(req, res);
    res.json({
      hasSession: !!s,
      sessionShop: s?.shop,
      sessionId: s?.id,
      hostName,
      query: req.query,
      cookie: req.headers.cookie ? 'present' : 'missing',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
    const response = await client.query({
      data: {
        query,
        variables: { first: 50, after: cursor },
      },
    });

    if (response.body.errors?.length) {
      throw new Error(response.body.errors.map((e) => e.message).join('; '));
    }
    if (!response.body.data?.companies) {
      throw new Error('No companies data in GraphQL response');
    }

    const { edges, pageInfo } = response.body.data.companies;
    all.push(...edges.map((edge) => edge.node));
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return all;
};

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
    const response = await client.query({
      data: {
        query,
        variables: { first: 50, after: cursor },
      },
    });

    if (response.body.errors?.length) {
      throw new Error(response.body.errors.map((e) => e.message).join('; '));
    }
    if (!response.body.data?.users) {
      throw new Error('No users data in GraphQL response');
    }

    const { edges, pageInfo } = response.body.data.users;
    all.push(...edges.map((edge) => edge.node));
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return all;
};

app.get('/api/companies', async (req, res) => {
  try {
    console.log('Companies API called');
    const client = await getGraphqlClient(req, res);
    if (!client) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized — open the app from Shopify Admin or complete OAuth.',
      });
    }
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
    });
  }
});

app.get('/api/staff', async (req, res) => {
  try {
    console.log('Staff API called');
    const client = await getGraphqlClient(req, res);
    if (!client) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized — open the app from Shopify Admin or complete OAuth.',
      });
    }
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
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'simple.html'));
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

module.exports = app;
