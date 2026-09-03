const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (process.env.SHOPIFY_API_KEY) process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY.trim();
if (process.env.SHOPIFY_API_SECRET) process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET.trim();
if (process.env.SHOPIFY_APP_URL) process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL.trim();
if (process.env.SESSION_SECRET) process.env.SESSION_SECRET = process.env.SESSION_SECRET.trim();
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith('POSTGRES_') ||
    key.startsWith('PG') ||
    key === 'DATABASE_URL' ||
    key === 'DATABASE_URL_UNPOOLED'
  ) {
    const v = process.env[key];
    if (typeof v === 'string') process.env[key] = v.trim();
  }
}

require('@shopify/shopify-api/adapters/node');

const {
  Session,
  ApiVersion,
  GraphqlQueryError,
  HttpResponseError,
} = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');
const {
  applyShopifyDeploymentEnv,
  resolveShopifyHostName,
} = require('../lib/resolve-shopify-hostname');
const { configureSessionStorage } = require('../lib/configure-session-storage');
const { configureStaffStore } = require('../lib/staff-store');
const { shopifyGraphql } = require('../lib/shopify-gql');

applyShopifyDeploymentEnv();

// Simple in-memory cache with TTL for commission data
// Stores expensive query results (commission calculations) for 5 minutes
class CommissionCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  makeKey(shopId, staffId) {
    return `commission:${shopId}:${staffId}`;
  }

  get(shopId, staffId) {
    const key = this.makeKey(shopId, staffId);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(shopId, staffId, data) {
    const key = this.makeKey(shopId, staffId);
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(shopId, staffId) {
    if (staffId) {
      this.cache.delete(this.makeKey(shopId, staffId));
    } else {
      // Clear all for a shop
      const prefix = `commission:${shopId}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    }
  }
}

const commissionCache = new CommissionCache();

// Input validation helpers to prevent common attacks and data issues
const validators = {
  email: (value) => {
    if (typeof value !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 255;
  },

  string: (value, minLen = 1, maxLen = 1000) => {
    if (typeof value !== 'string') return false;
    return value.length >= minLen && value.length <= maxLen;
  },

  number: (value, min = -Infinity, max = Infinity) => {
    const num = Number(value);
    return !isNaN(num) && num >= min && num <= max;
  },

  id: (value) => {
    if (typeof value !== 'string') return false;
    return /^[a-zA-Z0-9_\-:.]+$/.test(value) && value.length <= 255;
  },

  pin: (value) => {
    return /^\d{4}$/.test(String(value || ''));
  },

  role: (value) => {
    return ['manager', 'rep'].includes(value);
  },

  commissionTier: (value) => {
    const num = Number(value);
    return !isNaN(num) && num >= 0 && num <= 100;
  },
};

function formatShopifyClientError(err) {
  if (err instanceof GraphqlQueryError) {
    const gqlErrs = err.body?.errors?.graphQLErrors;
    if (Array.isArray(gqlErrs) && gqlErrs.length > 0) {
      return gqlErrs.map((e) => e.message).join('; ');
    }
  }
  if (err instanceof HttpResponseError && err.response?.body && typeof err.response.body === 'object') {
    try {
      const b = err.response.body;
      const gql = b.errors?.graphQLErrors;
      if (Array.isArray(gql) && gql.length > 0) {
        return gql.map((e) => e.message).join('; ');
      }
    } catch (_) {
      /* ignore */
    }
  }
  return err.message || String(err);
}

function sendShopifyApiError(res, err) {
  const message = formatShopifyClientError(err);
  const lower = message.toLowerCase();
  const accessDenied =
    lower.includes('access denied') ||
    lower.includes('not authorized') ||
    lower.includes('must be installed on a shopify plus') ||
    lower.includes('shopify plus') && lower.includes('required') ||
    lower.includes('advanced') && lower.includes('store') ||
    /doesn't have a valid/i.test(message) ||
    (lower.includes('permission') && lower.includes('required'));

  const status = accessDenied ? 403 : 502;
  res.status(status).json({
    error: message,
    code: accessDenied ? 'SHOPIFY_ACCESS_DENIED' : 'SHOPIFY_API_ERROR',
  });
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const publicDir = path.join(process.cwd(), 'public');

function injectShopifyApiKeyMeta(html) {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  const safe = apiKey.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const mapboxToken = process.env.MAPBOX_PUBLIC_TOKEN || process.env.MAPBOX_ACCESS_TOKEN || '';
  const safeMapbox = mapboxToken.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  if (!html.includes('<head>')) return html;
  const embeddedHead = [
    `<meta name="shopify-api-key" content="${safe}">`,
    `<meta name="mapbox-token" content="${safeMapbox}">`,
    '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>',
  ].join('\n');
  return html.replace('<head>', `<head>\n${embeddedHead}\n`);
}

function sendAppHtmlFile(res, filename) {
  const filePath = path.join(publicDir, filename);
  const html = fs.readFileSync(filePath, 'utf8');
  res.type('html').send(injectShopifyApiKeyMeta(html));
}

app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  frameguard: false,
}));

app.use(cors());
app.use(cookieParser());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware for debugging and monitoring
app.use((req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;

  res.send = function(data) {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    const method = req.method;
    const path = req.path;
    const query = Object.keys(req.query).length ? `?${new URLSearchParams(req.query)}` : '';
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    console.log(`[${level}] ${method} ${path}${query} ${statusCode} ${duration}ms`);
    res.send = originalSend;
    return originalSend.call(this, data);
  };

  next();
});

// Fail fast instead of hanging for the full Vercel maxDuration (300s).
// Production logs showed the embedded app's "/" route stall for the entire
// 300 seconds and come back as a 504 when the Postgres session lookup hit a
// connection hiccup (Neon compute slow to wake, transient network blip) —
// the merchant just sees a blank iframe for five minutes. This guard sends a
// prompt, retryable error well before that so Shopify Admin / the client can
// recover in seconds instead. It doesn't fix a slow/hung DB call itself, but
// bounds how long the merchant waits to find out something went wrong.
const REQUEST_TIMEOUT_MS = 20000;
// Commission rollups legitimately fan out to Shopify per assigned company.
// Keep them well under Vercel's 300s cap, but don't treat a 20s aggregation
// as a hung request the way we do for "/" / session lookups.
const COMMISSION_AGGREGATION_TIMEOUT_MS = 55000;

function isCommissionAggregationRequest(req) {
  if (req.method !== 'GET') return false;
  const p = req.path || '';
  if (p === '/api/commissions') return true;
  if (p === '/api/reports/commissions' || p === '/api/reports/commissions/export.csv') return true;
  return (
    p.startsWith('/api/commissions/') &&
    p !== '/api/commissions/access' &&
    !p.includes('/pin')
  );
}

app.use((req, res, next) => {
  const timeoutMs = isCommissionAggregationRequest(req)
    ? COMMISSION_AGGREGATION_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`[timeout-guard] ${req.method} ${req.originalUrl} exceeded ${timeoutMs}ms`);
      res.status(503).json({ error: 'Temporarily unavailable, please retry.', code: 'TIMEOUT_GUARD' });
    }
  }, timeoutMs);
  timer.unref?.();
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

const {
  shopifySessionStorage,
  expressSessionStore,
  backend: sessionBackend,
  hasPersistentStorage,
} = configureSessionStorage({ Session, isProduction });

// Express session setup
app.use(session({
  store: expressSessionStore,
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

const hostName = resolveShopifyHostName();
if (!hostName) {
  throw new Error(
    'Shopify API: hostName is empty in production. Set SHOPIFY_APP_URL to your deployed origin (https://your-app.vercel.app) — required for hosted apps per Shopify deployment docs — or set SHOPIFY_HOSTNAME. Vercel: also set VERCEL_URL-backed preview or use SHOPIFY_APP_URL explicitly.',
  );
}

const hostScheme =
  process.env.HOST?.startsWith('https') ? 'https'
    : process.env.NODE_ENV === 'production' ? 'https'
      : 'http';

// Single Shopify initialization — shopifyApp() expects an api config object, not a shopifyApi() instance
const shopifyAppInstance = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY || 'dummy_key',
    apiSecretKey: process.env.SHOPIFY_API_SECRET || 'dummy_secret',
    scopes: [
      'read_companies',
      'write_companies',
      'read_customers',
      'write_customers',
      'read_orders',
      'read_metaobjects',
      'write_metaobjects',
    ],
    hostName,
    hostScheme,
    apiVersion: ApiVersion.October24,
    isEmbeddedApp: true,
  },
  auth: {
    path: '/auth',
    callbackPath: '/auth/callback',
  },
  webhooks: {
    path: '/webhooks',
  },
  sessionStorage: shopifySessionStorage,
});

const shopify = shopifyAppInstance.api;

const ensureInstalledOnShop = shopifyAppInstance.ensureInstalledOnShop();
const validateAuthenticatedSession = shopifyAppInstance.validateAuthenticatedSession();
const shopifyCspHeaders = shopifyAppInstance.cspHeaders();

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

// Routes (before static — do not let express.static answer `/` with public/index.html; we inject App Bridge meta)
app.get('/test-ui', (req, res) => sendAppHtmlFile(res, 'index.html'));
app.get('/test-ui/reports', (req, res) => sendAppHtmlFile(res, 'reports.html'));

function sendAppPage(filename) {
  return (req, res) => {
    try {
      sendAppHtmlFile(res, filename);
    } catch (error) {
      console.error('Error loading app page', filename, error);
      res.status(500).send('Internal server error');
    }
  };
}

app.get('/exitiframe', (req, res) => {
  const redirectUri = req.query.redirectUri;
  if (!redirectUri) {
    return res.status(400).send('No redirectUri provided');
  }

  const safeRedirectUri = decodeURIComponent(redirectUri);

  let url;
  try {
    // Support both absolute URLs and relative paths by using the request's origin as fallback base
    url = new URL(safeRedirectUri, `${req.protocol}://${req.get('host')}`);
  } catch (err) {
    console.error('[exitiframe] Failed to parse redirectUri:', safeRedirectUri, err);
    return res.status(400).send(`Invalid redirectUri format: "${safeRedirectUri}"`);
  }

  const hostname = url.hostname;
  const isShopify = hostname.endsWith('.myshopify.com') || hostname === 'admin.shopify.com';
  const isSelf = hostname === req.hostname || hostname === 'localhost';

  if (!isShopify && !isSelf) {
    console.warn('[exitiframe] Domain not allowed:', hostname);
    return res.status(400).send(`Invalid redirectUri: domain "${hostname}" is not allowed.`);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Redirecting...</title>
      <script>
        document.addEventListener("DOMContentLoaded", function() {
          const redirectUri = ${JSON.stringify(safeRedirectUri)};
          if (window.top !== window.self) {
            window.top.location.href = redirectUri;
          } else {
            window.location.href = redirectUri;
          }
        });
      </script>
    </head>
    <body>
      <p>Redirecting to Shopify authentication...</p>
    </body>
    </html>
  `);
});

// Embedded app home: only ensureInstalledOnShop (matches server.js). Session tokens
// are validated on /api/* via validateAuthenticatedSession + App Bridge Bearer JWT.
app.get(
  '/',
  ensureInstalledOnShop,
  shopifyCspHeaders,
  sendAppPage(process.env.APP_HOME_HTML || 'index.html'),
);
app.get('/reports', ensureInstalledOnShop, shopifyCspHeaders, sendAppPage('reports.html'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hostName,
    sessionStorage: sessionBackend,
    persistentSessions: hasPersistentStorage,
    warning: isProduction && !hasPersistentStorage
      ? 'Set REDIS_URL (Upstash) or DATABASE_URL (Neon/Supabase Postgres) for production sessions.'
      : undefined,
  });
});

const staffStore = configureStaffStore({ isProduction });

// Decode the App Bridge session token (already required by validateAuthenticatedSession)
// to get a stable per-user Shopify ID. Offline sessions carry no per-user info, so this
// JWT is the only reliable way to know *who* is making the request, not just *which shop*.
const getShopifyUserId = async (req) => {
  const match = req.headers.authorization?.match(/Bearer (.+)/);
  if (!match) return null;
  try {
    const payload = await shopify.session.decodeSessionToken(match[1]);
    return payload.sub || null;
  } catch (err) {
    console.warn('Failed to decode session token', err.message);
    return null;
  }
};

// Get current user from session
const getCurrentUser = async (req, res) => {
  const session = res.locals.shopify?.session;
  if (!session) return null;
  const shopifyUserId = await getShopifyUserId(req);
  return {
    shop: session.shop,
    id: session.id,
    shopifyUserId,
  };
};

// Check if user is manager
const isManager = async (user) => {
  if (!user?.shopifyUserId) return false;
  const staffRecord = await staffStore.findByShopifyUserId(user.shopifyUserId);
  return staffRecord?.role === 'manager';
};

// Commissions show real pay figures, so viewing them needs a rep's own
// 4-digit code on top of Shopify login — see docs on the self-claim flow
// above staffStore.claim: identity there is self-asserted with no
// verification, so a PIN tied to the staff record (not the Shopify login)
// is what actually keeps someone from seeing another rep's numbers.
const PIN_MAX_ATTEMPTS = 5;
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(pin, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPinHash(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const candidate = await scryptAsync(pin, salt, 64);
    const a = Buffer.from(hash, 'hex');
    const b = candidate;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const getGraphqlClient = async (req, res) => {
  const sessionData = res.locals.shopify?.session;
  if (!sessionData) return null;
  return new shopify.clients.Graphql({ session: sessionData });
};

function decodeRouteParam(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Lightweight single-company read, used only to check the current assignment
// before allowing a rep to self-assign/release (avoids re-fetching every
// company + its orders just to authorize one write).
const getCompanyAssignedStaff = async (client, companyId) => {
  const query = `
    query getCompanyAssignment($id: ID!) {
      company(id: $id) {
        id
        metafield(namespace: "clnf", key: "assigned_staff") {
          value
        }
      }
    }
  `;
  const data = await shopifyGraphql(client, query, { id: companyId }, 'fetch company assignment');
  const value = data?.company?.metafield?.value;
  if (!value) return null;
  try {
    return JSON.parse(value) || null;
  } catch (e) {
    return null;
  }
};

const getCompanyAssignedStaffId = async (client, companyId) => {
  const assigned = await getCompanyAssignedStaff(client, companyId);
  return assigned?.staffId || null;
};

// Metafields are written via the resource-agnostic metafieldsSet mutation.
// (companyUpdate's CompanyInput no longer accepts an `id` or `metafields` field.)
const setCompanyMetafield = async (client, companyId, key, value) => {
  const mutation = `
    mutation setCompanyMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphql(client, mutation, {
    metafields: [
      {
        ownerId: companyId,
        namespace: 'clnf',
        key,
        type: 'json',
        value,
      },
    ],
  }, `set company metafield ${key}`);

  const userErrors = data?.metafieldsSet?.userErrors;
  if (userErrors && userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join('; '));
  }
};

// Helper: calculate days between orders and stats
const calculateOrderStats = (orderDates) => {
  if (!orderDates || orderDates.length === 0) {
    return { lastOrderDate: null, daysSinceLastOrder: null, avgDaysBetweenOrders: null };
  }

  const dates = orderDates.map(d => new Date(d)).sort((a, b) => b - a);
  const lastOrderDate = dates[0];
  const now = new Date();
  const daysSinceLastOrder = Math.floor((now - lastOrderDate) / (1000 * 60 * 60 * 24));

  let avgDaysBetweenOrders = null;
  if (dates.length >= 2) {
    const gaps = [];
    for (let i = 0; i < dates.length - 1; i++) {
      const gap = (dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24);
      gaps.push(gap);
    }
    avgDaysBetweenOrders = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }

  return { lastOrderDate: lastOrderDate.toISOString(), daysSinceLastOrder, avgDaysBetweenOrders };
};

// Company.orders only lists orders whose purchasingEntity is the B2B company.
// Wholesale contacts often keep ordering as regular customers (draft invoices,
// online store), so Company.totalSpent / a contact's lastOrder can be populated
// while Company.orders is empty. Using only Company.orders for the CRM badge
// then shows "Never" next to a growing spend total.
const uniqueContactCustomers = (company) => {
  const raw = [
    company.mainContact?.customer,
    ...(company.contacts?.edges || []).map((edge) => edge?.node?.customer),
  ].filter(Boolean);
  const seen = new Set();
  const customers = [];
  for (const customer of raw) {
    const key = customer.id || `anon-${customers.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    customers.push(customer);
  }
  return customers;
};

const contactOrderStats = (company) => {
  const customers = uniqueContactCustomers(company);
  let maxOrders = 0;
  const lastOrderDates = [];
  for (const customer of customers) {
    const n = parseInt(customer.numberOfOrders, 10);
    if (Number.isFinite(n) && n > maxOrders) maxOrders = n;
    if (customer.lastOrder?.createdAt) lastOrderDates.push(customer.lastOrder.createdAt);
  }
  return { maxOrders, lastOrderDates };
};

// Fetch real companies with performance data.
//
// totalSpent/ordersCount come straight from Shopify's own Company aggregates —
// accurate regardless of order volume. An earlier version of this query tried
// to compute these itself via the top-level `orders(query: "company_id:X")`
// search filter, but `company_id` isn't a real order search field: Shopify
// silently ignored it and returned the shop's most recent orders overall for
// every company (hence identical "last order: today" results with numbers
// that weren't actually that company's).
//
// recentOrders (Company.orders) is scoped correctly by construction — it's a
// connection *on the company*, not a top-level search filter — and per
// shopify.dev's Order reference it needs `read_orders` OR read_marketplace_orders
// OR read_quick_sale (not all three; a prior version of this query added the
// latter two "in addition to" read_orders, which was never necessary and is
// what triggered an infinite reauth loop — see the revert of that change).
// read_orders is already in this app's scope list below and was never removed,
// so no scope/reauth change is needed for this field.
//
// Shopify GraphQL is one HTTP round-trip per query. Commissions used to
// await fetchCompanyRevenueSince sequentially and trip the timeout-guard.
// A small pool stays inside Shopify's leaky bucket while finishing in seconds.
const COMMISSION_SHOPIFY_CONCURRENCY = 5;

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        results[i] = await mapper(items[i], i);
      }
    }),
  );
  return results;
}

// Contact customer.lastOrder fills in cadence when Company.orders is empty but
// the linked buyer accounts have real order history (see uniqueContactCustomers).
//
// `mode: 'commissions'` skips CRM-only fields (notes, contacts, spend stats)
// so the commission rollup doesn't pay for a full Customers-tab payload
// before it even starts the per-company revenue queries.
const fetchAllCompanies = async (client, { mode = 'full' } = {}) => {
  if (!client) return [];
  const query = mode === 'commissions'
    ? `
    query getCompaniesForCommissions($first: Int!, $after: String) {
      companies(first: $first, after: $after) {
        edges {
          node {
            id
            name
            recentOrders: orders(first: 1, reverse: true) {
              edges {
                node {
                  createdAt
                }
              }
            }
            assignedStaffMetafield: metafield(namespace: "clnf", key: "assigned_staff") {
              value
              updatedAt
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `
    : `
    query getCompanies($first: Int!, $after: String) {
      companies(first: $first, after: $after) {
        edges {
          node {
            id
            name
            externalId
            createdAt
            customerSince
            updatedAt
            totalSpent {
              amount
              currencyCode
            }
            ordersCount {
              count
            }
            recentOrders: orders(first: 10, reverse: true) {
              edges {
                node {
                  createdAt
                }
              }
            }
            mainContact {
              customer {
                id
                numberOfOrders
                lastOrder {
                  createdAt
                }
              }
            }
            contacts(first: 10) {
              edges {
                node {
                  customer {
                    id
                    numberOfOrders
                    lastOrder {
                      createdAt
                    }
                  }
                }
              }
            }
            metafield(namespace: "clnf", key: "crm_notes") {
              value
            }
            assignedStaffMetafield: metafield(namespace: "clnf", key: "assigned_staff") {
              value
              updatedAt
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

  const enrichCompany = (company) => {

    const totalSpend = parseFloat(company.totalSpent?.amount || '0') || 0;
    const companyOrderCount = company.ordersCount?.count || 0;
    const companyOrderDates = (company.recentOrders?.edges || [])
      .map((e) => e?.node?.createdAt)
      .filter(Boolean);
    const contacts = contactOrderStats(company);
    const orderCount = Math.max(companyOrderCount, contacts.maxOrders);
    const orderDates = [...companyOrderDates, ...contacts.lastOrderDates];
    const orderStats = calculateOrderStats(orderDates);
    const hasOrdered = orderCount > 0 || totalSpend > 0 || Boolean(orderStats.lastOrderDate);

    // Parse notes from metafield
    let notes = [];
    try {
      const notesValue = company.metafield?.value;
      if (notesValue) {
        notes = JSON.parse(notesValue);
        if (!Array.isArray(notes)) notes = [];
      }
    } catch (e) {
      console.warn('Failed to parse notes for company', company.id, e.message);
    }

    // Parse assigned rep from metafield (app-owned; Shopify's native staff
    // assignments require the protected read_users scope, which this app doesn't have)
    let assignedStaff = null;
    try {
      const assignedValue = company.assignedStaffMetafield?.value;
      if (assignedValue) {
        assignedStaff = JSON.parse(assignedValue);
        // Assignments written before commission math was tied to an assignment
        // date won't have `assignedAt` in the JSON. Fall back to the metafield's
        // own updatedAt (when Shopify last saw this assignment change) so those
        // reps aren't retroactively credited with the company's entire order
        // history — see fetchCompanyRevenueSince.
        if (assignedStaff && !assignedStaff.assignedAt) {
          assignedStaff.assignedAt = company.assignedStaffMetafield?.updatedAt || null;
        }
      }
    } catch (e) {
      console.warn('Failed to parse assigned staff for company', company.id, e.message);
    }

    company.performance = {
      totalSpend,
      orderCount,
      lastOrderDate: orderStats.lastOrderDate,
      daysSinceLastOrder: orderStats.daysSinceLastOrder,
      avgDaysBetweenOrders: orderStats.avgDaysBetweenOrders,
      avgOrderValue: orderCount > 0 ? totalSpend / orderCount : 0,
      hasOrdered,
    };

    company.notes = notes;
    company.assignedStaff = assignedStaff;

    return company;
  };

  let hasNextPage = true;
  let cursor = null;
  const all = [];

  while (hasNextPage) {
    const data = await shopifyGraphql(client, query, { first: 50, after: cursor }, 'companies');
    const companiesData = data?.companies;
    if (!companiesData) {
      break;
    }
    const edges = companiesData.edges || [];
    const pageInfo = companiesData.pageInfo || { hasNextPage: false, endCursor: null };

    // In commissions mode, skip expensive enrichment (notes, performance stats);
    // we only need id, name, and assigned staff data for commission calculations
    if (mode === 'commissions') {
      all.push(...edges.map((edge) => {
        const company = edge.node;
        let assignedStaff = null;
        try {
          const assignedValue = company.assignedStaffMetafield?.value;
          if (assignedValue) {
            assignedStaff = JSON.parse(assignedValue);
            if (assignedStaff && !assignedStaff.assignedAt) {
              assignedStaff.assignedAt = company.assignedStaffMetafield?.updatedAt || null;
            }
          }
        } catch (e) {
          console.warn('Failed to parse assigned staff for company', company.id, e.message);
        }
        return { id: company.id, name: company.name, assignedStaff };
      }));
    } else {
      all.push(...edges.map((edge) => enrichCompany(edge.node)));
    }

    hasNextPage = Boolean(pageInfo.hasNextPage);
    cursor = pageInfo.endCursor || null;
  }
  return all;
};

// Commission payouts are earned on a rep's *own* work, not whatever the
// company happened to spend before they were assigned. This walks the
// company's orders newest-first and sums only the ones placed on/after
// `sinceIso` (the assignment date), stopping as soon as it reaches an order
// older than that cutoff — no need to paginate further once we're past it.
// A null/undefined `sinceIso` (shouldn't normally happen — see enrichCompany's
// assignedAt backfill) falls back to lifetime revenue rather than crediting nothing.
//
// `untilIso`, when given, caps the other end (used for monthly reports, which
// need "this rep's revenue *during* July" rather than "since assignment to
// today"). Orders newer than `untilIso` are skipped, not treated as a stop
// condition — pagination continues past them until it reaches the window.
const fetchCompanyRevenueSince = async (client, companyId, sinceIso, untilIso = null) => {
  const sinceTime = sinceIso ? new Date(sinceIso).getTime() : null;
  const untilTime = untilIso ? new Date(untilIso).getTime() : null;
  const query = `
    query getCompanyOrdersSince($id: ID!, $first: Int!, $after: String) {
      company(id: $id) {
        orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              createdAt
              currentTotalPriceSet {
                shopMoney {
                  amount
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
    }
  `;

  let cursor = null;
  let hasNextPage = true;
  let totalSpend = 0;
  let orderCount = 0;
  let lastOrderDate = null;

  while (hasNextPage) {
    const data = await shopifyGraphql(
      client,
      query,
      { id: companyId, first: 100, after: cursor },
      'company orders since assignment',
    );
    const ordersData = data?.company?.orders;
    if (!ordersData) break;

    for (const edge of ordersData.edges || []) {
      const createdAt = edge.node.createdAt;
      const createdTime = new Date(createdAt).getTime();
      if (sinceTime !== null && createdTime < sinceTime) {
        return { totalSpend, orderCount, lastOrderDate };
      }
      if (untilTime !== null && createdTime > untilTime) {
        continue;
      }
      totalSpend += parseFloat(edge.node.currentTotalPriceSet?.shopMoney?.amount || '0') || 0;
      orderCount += 1;
      if (!lastOrderDate || createdAt > lastOrderDate) lastOrderDate = createdAt;
    }

    hasNextPage = Boolean(ordersData.pageInfo?.hasNextPage);
    cursor = ordersData.pageInfo?.endCursor || null;
  }

  return { totalSpend, orderCount, lastOrderDate };
};

async function fetchCompaniesRevenueSince(client, jobs) {
  return mapWithConcurrency(jobs, COMMISSION_SHOPIFY_CONCURRENCY, (job) =>
    fetchCompanyRevenueSince(client, job.companyId, job.sinceIso, job.untilIso || null),
  );
}

// API Endpoints
app.get('/api/companies', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const companies = await fetchAllCompanies(client);
    res.json({ edges: companies.map(c => ({ node: c })) });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/companies', error);
    res.status(500).json({ error: error.message });
  }
});

// Get notes for a specific company
app.get('/api/companies/:companyId/notes', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const companyId = decodeRouteParam(req.params.companyId);
    const query = `
      query getCompanyNotes($id: ID!) {
        company(id: $id) {
          id
          metafield(namespace: "clnf", key: "crm_notes") {
            value
          }
        }
      }
    `;

    const data = await shopifyGraphql(client, query, { id: companyId }, 'company notes');

    if (!data?.company) {
      return res.json({ notes: [] });
    }

    let notes = [];
    const metafield = data?.company?.metafield;
    if (metafield?.value) {
      try {
        notes = JSON.parse(metafield.value);
        if (!Array.isArray(notes)) notes = [];
      } catch (e) {
        console.warn('Failed to parse notes', e.message);
      }
    }

    res.json({ notes });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/companies/:companyId/notes', error);
    res.status(500).json({ error: error.message });
  }
});

// Add a note to a company
app.post('/api/companies/:companyId/notes', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const companyId = decodeRouteParam(req.params.companyId);
    const { body, author } = req.body;

    if (!body || !author) {
      return res.status(400).json({ error: 'body and author required' });
    }

    // Fetch existing notes
    const getQuery = `
      query getCompanyNotes($id: ID!) {
        company(id: $id) {
          id
          metafield(namespace: "clnf", key: "crm_notes") {
            value
          }
        }
      }
    `;

    const getData = await shopifyGraphql(client, getQuery, { id: companyId }, 'fetch company notes');

    let notes = [];
    const metafield = getData?.company?.metafield;
    if (metafield?.value) {
      try {
        notes = JSON.parse(metafield.value);
        if (!Array.isArray(notes)) notes = [];
      } catch (e) {
        notes = [];
      }
    }

    // Create new note
    const newNote = {
      id: `note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      body,
      author,
      createdAt: new Date().toISOString()
    };

    notes.unshift(newNote);

    await setCompanyMetafield(client, companyId, 'crm_notes', JSON.stringify(notes));

    res.json({ note: newNote });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('POST /api/companies/:companyId/notes', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a note from a company
app.delete('/api/companies/:companyId/notes/:noteId', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const companyId = decodeRouteParam(req.params.companyId);
    const noteId = decodeRouteParam(req.params.noteId);

    // Fetch existing notes
    const getQuery = `
      query getCompanyNotes($id: ID!) {
        company(id: $id) {
          id
          metafield(namespace: "clnf", key: "crm_notes") {
            value
          }
        }
      }
    `;

    const getData = await shopifyGraphql(client, getQuery, { id: companyId }, 'fetch company notes');

    let notes = [];
    const metafield = getData?.company?.metafield;
    if (metafield?.value) {
      try {
        notes = JSON.parse(metafield.value);
        if (!Array.isArray(notes)) notes = [];
      } catch (e) {
        notes = [];
      }
    }

    // Remove the note
    notes = notes.filter(n => n.id !== noteId);

    await setCompanyMetafield(client, companyId, 'crm_notes', JSON.stringify(notes));

    res.json({ success: true });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('DELETE /api/companies/:companyId/notes/:noteId', error);
    res.status(500).json({ error: error.message });
  }
});

// STAFF MANAGEMENT ENDPOINTS

// Get all staff (managers only) or current user's staff info
app.get('/api/staff', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const isUserManager = await isManager(user);

    if (isUserManager) {
      // Managers see all staff
      res.json({ staff: await staffStore.list() });
    } else {
      // Reps see only their own linked record, if any
      const staffMember = await staffStore.findByShopifyUserId(user?.shopifyUserId);
      res.json({ staff: staffMember ? [staffMember] : [] });
    }
  } catch (error) {
    console.error('GET /api/staff', error);
    res.status(500).json({ error: error.message });
  }
});

// Create/update staff member (managers only)
app.post('/api/staff', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    if (!(await isManager(user))) {
      return res.status(403).json({ error: 'Only managers can manage staff' });
    }

    const { name, email, commissionTier, role, pin } = req.body;

    if (!validators.string(name, 1, 255) || !validators.email(email) ||
        !validators.commissionTier(commissionTier) || !validators.role(role)) {
      return res.status(400).json({ error: 'Invalid input: check name, email, commissionTier (0-100), and role (manager/rep)' });
    }

    if (pin !== undefined && pin !== null && pin !== '' && !validators.pin(pin)) {
      return res.status(400).json({ error: 'Starter code must be exactly 4 digits.' });
    }

    const existingList = await staffStore.list();
    const existing = existingList.find((s) => s.email === email);
    const record = await staffStore.upsert({
      id: existing?.id || `staff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      email,
      commissionTier,
      role,
      shopifyUserId: existing?.shopifyUserId || null,
      createdAt: existing?.createdAt || new Date().toISOString(),
    });

    // A manager can hand a rep a starter code (e.g. "your code is 4821") so
    // the first Commissions visit isn't a cold "set a code" prompt — the rep
    // can change it to something memorable later via /api/commissions/pin/change.
    // Blank/omitted leaves an existing code untouched (an edit-staff save
    // must not silently wipe a code the rep already set for themselves).
    if (pin !== undefined && pin !== null && pin !== '') {
      const pinHash = await hashPin(String(pin));
      await staffStore.forceSetPin(record.id, pinHash);
      record.hasPin = true;
    }

    res.json({ staff: record });
  } catch (error) {
    console.error('POST /api/staff', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete staff member (managers only)
app.delete('/api/staff/:staffId', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    if (!(await isManager(user))) {
      return res.status(403).json({ error: 'Only managers can manage staff' });
    }

    const { staffId } = req.params;
    const removed = await staffStore.remove(staffId);
    if (!removed) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/staff/:staffId', error);
    res.status(500).json({ error: error.message });
  }
});

// One-time bootstrap: the first authenticated user can claim the manager role
// while no manager exists yet. After that, admin management happens via the
// Staff Management UI.
app.post('/api/staff/claim-admin', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    if (!user?.shopifyUserId) {
      return res.status(400).json({ error: 'Could not identify your Shopify account from this session.' });
    }
    if (await staffStore.hasManager()) {
      return res.status(409).json({ error: 'An admin has already been set up for this app. Ask them to add you as staff.' });
    }

    const { name } = req.body || {};
    const record = await staffStore.upsert({
      id: `staff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: name || 'Admin',
      email: '',
      commissionTier: 0,
      role: 'manager',
      shopifyUserId: user.shopifyUserId,
      createdAt: new Date().toISOString(),
    });

    res.json({ staff: record });
  } catch (error) {
    console.error('POST /api/staff/claim-admin', error);
    res.status(500).json({ error: error.message });
  }
});

// A manager adding a rep via POST /api/staff only knows their name/email —
// there's no scope-safe way for the app to look up which Shopify login that
// corresponds to, so the record is created with shopifyUserId unset. These two
// endpoints let the rep self-identify and link their own login to it, the same
// way claim-admin bootstraps the first manager.
app.get('/api/staff/unclaimed', validateAuthenticatedSession, async (req, res) => {
  try {
    const unclaimed = await staffStore.findUnclaimed();
    res.json({ staff: unclaimed.map((s) => ({ id: s.id, name: s.name, role: s.role })) });
  } catch (error) {
    console.error('GET /api/staff/unclaimed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/staff/:staffId/claim', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    if (!user?.shopifyUserId) {
      return res.status(400).json({ error: 'Could not identify your Shopify account from this session.' });
    }

    const already = await staffStore.findByShopifyUserId(user.shopifyUserId);
    if (already) {
      return res.status(409).json({ error: 'This Shopify login is already linked to a staff record.' });
    }

    const { staffId } = req.params;
    const record = await staffStore.claim(staffId, user.shopifyUserId);
    if (!record) {
      return res.status(409).json({ error: 'That staff record was not found or has already been claimed.' });
    }

    res.json({ staff: record });
  } catch (error) {
    console.error('POST /api/staff/:staffId/claim', error);
    res.status(500).json({ error: error.message });
  }
});

// Lightweight endpoint for the frontend to check role + whether admin bootstrap is needed
app.get('/api/session-info', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const isUserManager = await isManager(user);
    const hasAnyManager = await staffStore.hasManager();
    res.json({ isManager: isUserManager, hasAnyManager, shop: user?.shop || null });
  } catch (error) {
    console.error('GET /api/session-info', error);
    res.status(500).json({ error: error.message });
  }
});

// Assign (or clear) which staff member is responsible for a company.
// Managers can assign/reassign anyone. Reps can only claim an unassigned
// company for themselves, or release their own assignment.
app.post('/api/companies/:companyId/assignment', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const isUserManager = await isManager(user);
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const companyId = decodeRouteParam(req.params.companyId);
    const { staffId } = req.body;

    const currentAssignment = await getCompanyAssignedStaff(client, companyId);

    let assignedStaff = null;
    if (staffId) {
      const staffRecord = await staffStore.findById(staffId);
      if (!staffRecord) return res.status(400).json({ error: 'Unknown staff member' });
      // Only reset the commission clock when the rep actually changes — a
      // no-op re-save of the same rep must not zero out revenue they've
      // already earned credit for since their real assignment date.
      const assignedAt = currentAssignment?.staffId === staffId && currentAssignment?.assignedAt
        ? currentAssignment.assignedAt
        : new Date().toISOString();
      assignedStaff = { staffId: staffRecord.id, name: staffRecord.name, email: staffRecord.email, assignedAt };
    }

    if (!isUserManager) {
      const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
      if (!ownStaff) {
        return res.status(403).json({ error: 'Ask a manager to add you as staff before you can assign yourself to companies' });
      }
      if (staffId && staffId !== ownStaff.id) {
        return res.status(403).json({ error: 'You can only assign yourself' });
      }

      if (currentAssignment?.staffId && currentAssignment.staffId !== ownStaff.id) {
        return res.status(403).json({ error: 'This company is already assigned to another rep. Ask a manager to reassign it.' });
      }
    }

    await setCompanyMetafield(client, companyId, 'assigned_staff', JSON.stringify(assignedStaff));

    // Clear commission cache since assignment changed
    const shopId = res.locals.shopify?.session?.shop || 'unknown';
    commissionCache.clear(shopId);

    res.json({ success: true, assignedStaff });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('POST /api/companies/:companyId/assignment', error);
    res.status(500).json({ error: error.message });
  }
});

// Tells the frontend which of the three Commissions gate states to show:
// no staff record yet, needs to set a code, needs to enter it, or already
// unlocked for this browser session.
app.get('/api/commissions/access', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
    if (!ownStaff) {
      return res.json({ hasStaffRecord: false, hasPin: false, unlocked: false, locked: false });
    }
    const pinInfo = await staffStore.getPinInfo(ownStaff.id);
    res.json({
      hasStaffRecord: true,
      hasPin: Boolean(pinInfo?.pinHash),
      unlocked: req.session?.commissionsUnlockedFor === ownStaff.id,
      locked: (pinInfo?.pinFailedAttempts || 0) >= PIN_MAX_ATTEMPTS,
    });
  } catch (error) {
    console.error('GET /api/commissions/access', error);
    res.status(500).json({ error: error.message });
  }
});

// First-time code set. Only succeeds while no code exists yet — changing an
// existing one requires a manager reset (POST /api/staff/:staffId/pin/reset),
// by design: no self-service "forgot code" flow.
app.post('/api/commissions/pin/set', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
    if (!ownStaff) {
      return res.status(403).json({ error: 'Ask a manager to add you as staff before setting a code.' });
    }

    const pin = String(req.body?.pin || '');
    if (!validators.pin(pin)) {
      return res.status(400).json({ error: 'Code must be exactly 4 digits.' });
    }

    const pinHash = await hashPin(pin);
    const didSet = await staffStore.setPin(ownStaff.id, pinHash);
    if (!didSet) {
      return res.status(409).json({ error: 'A code is already set. Ask a manager to reset it if you forgot yours.' });
    }

    req.session.commissionsUnlockedFor = ownStaff.id;
    res.json({ success: true });
  } catch (error) {
    console.error('POST /api/commissions/pin/set', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify an existing code to unlock Commissions for the rest of this
// browser session (the express-session cookie already expires after 24h,
// so there's no separate expiry to track here).
app.post('/api/commissions/pin/verify', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
    if (!ownStaff) {
      return res.status(403).json({ error: 'Ask a manager to add you as staff before entering a code.' });
    }

    const pinInfo = await staffStore.getPinInfo(ownStaff.id);
    if ((pinInfo?.pinFailedAttempts || 0) >= PIN_MAX_ATTEMPTS) {
      return res.status(423).json({ error: 'Too many incorrect attempts. Ask a manager to reset your code.' });
    }

    const pin = String(req.body?.pin || '');
    if (!validators.pin(pin)) {
      return res.status(400).json({ error: 'Invalid code format.' });
    }

    const ok = await verifyPinHash(pin, pinInfo?.pinHash);
    const attempts = await staffStore.recordPinAttempt(ownStaff.id, ok);

    if (!ok) {
      const remaining = Math.max(0, PIN_MAX_ATTEMPTS - attempts);
      return res.status(401).json({
        error: remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
          : 'Too many incorrect attempts. Ask a manager to reset your code.',
      });
    }

    req.session.commissionsUnlockedFor = ownStaff.id;
    res.json({ success: true });
  } catch (error) {
    console.error('POST /api/commissions/pin/verify', error);
    res.status(500).json({ error: error.message });
  }
});

// Self-service change — lets a rep replace a manager-assigned starter code
// (or any existing code) with one of their own choosing, as long as they can
// prove the current one. Reuses the same failed-attempt counter as verify,
// so this can't be used as a side-channel to brute-force the current code.
app.post('/api/commissions/pin/change', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
    if (!ownStaff) {
      return res.status(403).json({ error: 'Ask a manager to add you as staff before changing your code.' });
    }

    const pinInfo = await staffStore.getPinInfo(ownStaff.id);
    if (!pinInfo?.pinHash) {
      return res.status(409).json({ error: 'No code is set yet — open Commissions to set one first.' });
    }
    if ((pinInfo.pinFailedAttempts || 0) >= PIN_MAX_ATTEMPTS) {
      return res.status(423).json({ error: 'Too many incorrect attempts. Ask a manager to reset your code.' });
    }

    const newPin = String(req.body?.newPin || '');
    if (!/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ error: 'New code must be exactly 4 digits.' });
    }

    const currentPin = String(req.body?.currentPin || '');
    const ok = await verifyPinHash(currentPin, pinInfo.pinHash);
    if (!ok) {
      const attempts = await staffStore.recordPinAttempt(ownStaff.id, false);
      const remaining = Math.max(0, PIN_MAX_ATTEMPTS - attempts);
      return res.status(401).json({
        error: remaining > 0
          ? `Current code is incorrect. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
          : 'Too many incorrect attempts. Ask a manager to reset your code.',
      });
    }

    const newPinHash = await hashPin(newPin);
    await staffStore.forceSetPin(ownStaff.id, newPinHash);
    req.session.commissionsUnlockedFor = ownStaff.id;
    res.json({ success: true });
  } catch (error) {
    console.error('POST /api/commissions/pin/change', error);
    res.status(500).json({ error: error.message });
  }
});

// Manager-only: clears a staff member's code (e.g. they forgot it) so
// they're prompted to set a new one next time they open Commissions.
app.post('/api/staff/:staffId/pin/reset', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    if (!(await isManager(user))) {
      return res.status(403).json({ error: 'Only managers can reset a staff code.' });
    }
    const didReset = await staffStore.resetPin(req.params.staffId);
    if (!didReset) {
      return res.status(404).json({ error: 'Staff member not found.' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('POST /api/staff/:staffId/pin/reset', error);
    res.status(500).json({ error: error.message });
  }
});

// Resolves a "YYYY-MM" query param to a calendar-month window. Reports are
// meant to be pulled on the 1st to look back at the month that just closed,
// so no param at all defaults to *last* month, not the current (still-open) one.
function resolveReportMonth(monthParam) {
  let year;
  let month; // 1-12
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    [year, month] = monthParam.split('-').map(Number);
  } else {
    const now = new Date();
    year = now.getUTCFullYear();
    month = now.getUTCMonth(); // 0-based current month == 1-based previous month
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { month: monthStr, label, start, end };
}

// Shared by the JSON and CSV report endpoints below. Reports are a
// manager-only, finance-facing view of everyone's pay, so — same as
// Commissions — the viewer (manager included) must have verified their own
// 4-digit code this session before any figures come back.
async function buildCommissionReport(req, res, monthParam) {
  const user = await getCurrentUser(req, res);
  const isUserManager = await isManager(user);
  if (!isUserManager) {
    return { status: 403, error: 'Only managers can view commission reports.' };
  }

  const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
  if (!ownStaff) {
    return { status: 403, error: 'Ask a manager to add you as staff before viewing reports.' };
  }
  if (req.session?.commissionsUnlockedFor !== ownStaff.id) {
    const pinInfo = await staffStore.getPinInfo(ownStaff.id);
    return {
      status: 403,
      error: pinInfo?.pinHash ? 'Enter your 4-digit code to view reports.' : 'Set a 4-digit code to view reports.',
      code: pinInfo?.pinHash ? 'PIN_REQUIRED' : 'PIN_NOT_SET',
    };
  }

  const client = await getGraphqlClient(req, res);
  if (!client) return { status: 401, error: 'Unauthorized' };

  const period = resolveReportMonth(monthParam);
  const companies = await fetchAllCompanies(client, { mode: 'commissions' });
  const allStaff = await staffStore.list();

  // Every staff member gets an entry — including reps with $0 this period —
  // so finance sees a complete roster rather than wondering if someone was
  // missed off the export.
  const repsMap = {};
  for (const staffRecord of allStaff) {
    repsMap[staffRecord.id] = {
      staffId: staffRecord.id,
      name: staffRecord.name,
      email: staffRecord.email,
      commissionTier: staffRecord.commissionTier,
      companies: [],
      totalRevenue: 0,
      totalCommission: 0,
    };
  }

  const reportJobs = [];
  for (const company of companies) {
    const assigned = company.assignedStaff;
    const rep = assigned?.staffId ? repsMap[assigned.staffId] : null;
    if (!rep) continue;

    const assignedAt = assigned.assignedAt ? new Date(assigned.assignedAt) : null;
    const effectiveSince = assignedAt && assignedAt > period.start ? assignedAt : period.start;
    if (effectiveSince > period.end) continue; // assigned after this period closed — nothing earned yet

    reportJobs.push({
      company,
      assigned,
      rep,
      sinceIso: effectiveSince.toISOString(),
      untilIso: period.end.toISOString(),
    });
  }

  const revenues = await fetchCompaniesRevenueSince(
    client,
    reportJobs.map((job) => ({
      companyId: job.company.id,
      sinceIso: job.sinceIso,
      untilIso: job.untilIso,
    })),
  );

  reportJobs.forEach((job, i) => {
    const revenue = revenues[i].totalSpend;
    const commission = (revenue * job.rep.commissionTier) / 100;

    job.rep.companies.push({
      companyId: job.company.id,
      companyName: job.company.name,
      revenue,
      commission,
      assignedAt: job.assigned.assignedAt || null,
    });
    job.rep.totalRevenue += revenue;
    job.rep.totalCommission += commission;
  });

  const reps = Object.values(repsMap).sort((a, b) => b.totalCommission - a.totalCommission);
  const totals = reps.reduce(
    (acc, r) => {
      acc.totalRevenue += r.totalRevenue;
      acc.totalCommission += r.totalCommission;
      return acc;
    },
    { totalRevenue: 0, totalCommission: 0 },
  );

  return {
    status: 200,
    period: {
      month: period.month,
      label: period.label,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    reps,
    totals,
    generatedAt: new Date().toISOString(),
  };
}

app.get('/api/reports/commissions', validateAuthenticatedSession, async (req, res) => {
  try {
    const report = await buildCommissionReport(req, res, req.query.month);
    if (report.status !== 200) {
      return res.status(report.status).json({ error: report.error, code: report.code });
    }
    const { status, ...body } = report;
    res.json(body);
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/reports/commissions', error);
    res.status(500).json({ error: error.message });
  }
});

// CSV rather than a server-rendered PDF: it's zero new dependencies (no
// headless-browser/PDF library to keep working on Vercel's serverless
// runtime), and it opens directly in whatever finance already uses
// (Excel/Sheets) instead of a fixed layout they'd have to re-key. The
// reports.html page itself is print-styled for a "Save as PDF" option
// when a formatted one-pager is what's actually wanted.
function csvField(value) {
  const str = String(value ?? '');
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

app.get('/api/reports/commissions/export.csv', validateAuthenticatedSession, async (req, res) => {
  try {
    const report = await buildCommissionReport(req, res, req.query.month);
    if (report.status !== 200) {
      return res.status(report.status).json({ error: report.error, code: report.code });
    }

    // Same caveat shown on the report page — the "Commission Rate %" column
    // below is each rep's tier as of *right now*, not a historical snapshot,
    // so a tier change after this period closed isn't reflected retroactively.
    const rows = [
      [`Note: Commission Rate % reflects each rep's tier as of ${new Date().toLocaleDateString('en-US')}, not necessarily what was in effect during ${report.period.label}.`],
      [],
      ['Rep', 'Email', 'Company', 'Revenue', 'Commission Rate %', 'Commission Owed', 'Assigned Since'],
    ];
    for (const rep of report.reps) {
      if (rep.companies.length === 0) {
        rows.push([rep.name, rep.email, '(no companies assigned)', '0.00', rep.commissionTier, '0.00', '']);
      } else {
        for (const c of rep.companies) {
          rows.push([
            rep.name,
            rep.email,
            c.companyName,
            c.revenue.toFixed(2),
            rep.commissionTier,
            c.commission.toFixed(2),
            c.assignedAt ? new Date(c.assignedAt).toLocaleDateString('en-US') : '',
          ]);
        }
      }
      rows.push([`${rep.name} — Total`, '', '', rep.totalRevenue.toFixed(2), '', rep.totalCommission.toFixed(2), '']);
    }
    rows.push(['GRAND TOTAL', '', '', report.totals.totalRevenue.toFixed(2), '', report.totals.totalCommission.toFixed(2), '']);

    const csv = rows.map((row) => row.map(csvField).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="commissions-${report.period.month}.csv"`);
    res.send(csv);
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/reports/commissions/export.csv', error);
    res.status(500).json({ error: error.message });
  }
});

// Get commissions for a period (with role-based access)
app.get('/api/commissions', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const isUserManager = await isManager(user);
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    // Resolved up front for two reasons: (1) reps can only see their own
    // commissions, so companies not theirs are skipped before the expensive
    // per-company revenue-since-assignment fetch below runs; (2) commissions
    // show real pay figures, so *every* viewer — manager included — must
    // have verified their own 4-digit code this session (see
    // /api/commissions/pin/verify) before this endpoint returns anything.
    const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
    if (!ownStaff) {
      return res.status(403).json({ error: 'Ask a manager to add you as staff before viewing commissions.' });
    }
    if (req.session?.commissionsUnlockedFor !== ownStaff.id) {
      const pinInfo = await staffStore.getPinInfo(ownStaff.id);
      return res.status(403).json({
        error: pinInfo?.pinHash ? 'Enter your 4-digit code to view commissions.' : 'Set a 4-digit code to view commissions.',
        code: pinInfo?.pinHash ? 'PIN_REQUIRED' : 'PIN_NOT_SET',
      });
    }

    // Check cache for manager data (reps only see their own, no cache needed)
    const shopId = res.locals.shopify?.session?.shop || 'unknown';
    if (isUserManager) {
      const cached = commissionCache.get(shopId, 'all');
      if (cached) {
        return res.json(cached);
      }
    }

    // Fetch all companies with their app-owned rep assignment and revenue
    const companies = await fetchAllCompanies(client, { mode: 'commissions' });
    const allStaff = await staffStore.list();
    const staffById = new Map(allStaff.map((s) => [s.id, s]));

    const commissionJobs = [];
    for (const company of companies) {
      const assigned = company.assignedStaff;
      if (!assigned?.staffId) continue;
      if (!isUserManager && assigned.staffId !== ownStaff.id) continue;
      const staffRecord = staffById.get(assigned.staffId);
      if (!staffRecord) continue;
      commissionJobs.push({ company, assigned, staffRecord });
    }

    const revenues = await fetchCompaniesRevenueSince(
      client,
      commissionJobs.map((job) => ({
        companyId: job.company.id,
        sinceIso: job.assigned.assignedAt,
      })),
    );

    const commissionsMap = {};
    commissionJobs.forEach((job, i) => {
      const { company, assigned, staffRecord } = job;
      if (!commissionsMap[staffRecord.id]) {
        commissionsMap[staffRecord.id] = {
          staffId: staffRecord.id,
          name: staffRecord.name,
          email: staffRecord.email,
          commissionTier: staffRecord.commissionTier,
          companies: [],
          totalRevenue: 0,
          totalCommission: 0
        };
      }

      // Commission is earned only on orders placed since this rep took over the
      // account (see fetchCompanyRevenueSince) — not the company's lifetime spend.
      const revenue = revenues[i].totalSpend;
      const commission = (revenue * staffRecord.commissionTier) / 100;

      commissionsMap[staffRecord.id].companies.push({
        companyId: company.id,
        companyName: company.name,
        revenue,
        commission,
        assignedAt: assigned.assignedAt || null,
        lastOrderDate: company.performance?.lastOrderDate
      });

      commissionsMap[staffRecord.id].totalRevenue += revenue;
      commissionsMap[staffRecord.id].totalCommission += commission;
    });

    // Non-managers with no linked staff record see nothing (handled by the
    // per-company skip above never populating commissionsMap for them).
    const commissions = Object.values(commissionsMap);

    // Sort by total commission descending
    commissions.sort((a, b) => b.totalCommission - a.totalCommission);

    const response = {
      commissions,
      isManager: isUserManager,
      generatedAt: new Date().toISOString()
    };

    // Cache manager data for 5 minutes (reps see personal data, less cacheable)
    if (isUserManager && shopId !== 'unknown') {
      commissionCache.set(shopId, 'all', response);
    }

    res.json(response);
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/commissions', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single rep's commission details (with privacy check)
app.get('/api/commissions/:staffId', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = await getCurrentUser(req, res);
    const isUserManager = await isManager(user);
    const { staffId } = req.params;

    // Commissions show real pay figures, so every viewer — manager included
    // — must have verified their own 4-digit code this session before this
    // endpoint returns anything, on top of the existing privacy check below.
    const ownStaff = user?.shopifyUserId ? await staffStore.findByShopifyUserId(user.shopifyUserId) : null;
    if (!ownStaff) {
      return res.status(403).json({ error: 'Ask a manager to add you as staff before viewing commissions.' });
    }
    if (req.session?.commissionsUnlockedFor !== ownStaff.id) {
      const pinInfo = await staffStore.getPinInfo(ownStaff.id);
      return res.status(403).json({
        error: pinInfo?.pinHash ? 'Enter your 4-digit code to view commissions.' : 'Set a 4-digit code to view commissions.',
        code: pinInfo?.pinHash ? 'PIN_REQUIRED' : 'PIN_NOT_SET',
      });
    }

    // Privacy check: reps can only see their own, managers can see all
    if (!isUserManager && ownStaff.id !== staffId) {
      return res.status(403).json({ error: 'You can only view your own commissions' });
    }

    const staffRecord = await staffStore.findById(staffId);
    if (!staffRecord) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const companies = await fetchAllCompanies(client, { mode: 'commissions' });
    const assignedCompanies = companies.filter(
      (company) => company.assignedStaff?.staffId === staffId,
    );
    const revenues = await fetchCompaniesRevenueSince(
      client,
      assignedCompanies.map((company) => ({
        companyId: company.id,
        sinceIso: company.assignedStaff.assignedAt,
      })),
    );

    const repCommissions = {
      staffId: staffRecord.id,
      name: staffRecord.name,
      email: staffRecord.email,
      commissionTier: staffRecord.commissionTier,
      companies: [],
      totalRevenue: 0,
      totalCommission: 0
    };

    assignedCompanies.forEach((company, i) => {
      const revenue = revenues[i].totalSpend;
      const commission = (revenue * repCommissions.commissionTier) / 100;

      repCommissions.companies.push({
        companyId: company.id,
        companyName: company.name,
        revenue,
        commission,
        assignedAt: company.assignedStaff.assignedAt || null,
        lastOrderDate: company.performance?.lastOrderDate,
        daysSinceLastOrder: company.performance?.daysSinceLastOrder
      });

      repCommissions.totalRevenue += revenue;
      repCommissions.totalCommission += commission;
    });

    if (repCommissions.companies.length === 0) {
      return res.status(404).json({ error: 'No commissions found for this staff member' });
    }

    res.json({ commissions: repCommissions });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/commissions/:staffId', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/locations', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const query = `
      query getMetaobjects($first: Int!, $after: String) {
        metaobjects(type: "b2b_map_location", first: $first, after: $after) {
          edges {
            node {
              id
              handle
              fields {
                key
                value
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
    let allLocations = [];
    let hasNextPage = true;
    let cursor = null;
    while (hasNextPage) {
      const data = await shopifyGraphql(client, query, { first: 100, after: cursor }, 'metaobjects');
      const moData = data?.metaobjects;
      if (!moData) {
        hasNextPage = false;
        break;
      }
      const edges = moData.edges || [];
      allLocations = allLocations.concat(edges.map((edge) => edge.node));
      hasNextPage = Boolean(moData.pageInfo?.hasNextPage);
      cursor = moData.pageInfo?.endCursor ?? null;
    }
    res.json({
      edges: allLocations.map((node) => ({ node })),
      pageInfo: { hasNextPage: false }
    });
  } catch (error) {
    const message = formatShopifyClientError(error);
    if (/ACCESS_DENIED|Access denied for metaobjects|UndefinedObject/i.test(message)) {
      console.warn('GET /api/locations:', message);
      return res.json({ edges: [], pageInfo: { hasNextPage: false }, warning: message });
    }
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/locations', error);
    res.status(500).json({ error: error.message });
  }
});

// B2B Sync Route — uses the authenticated shop session (no SHOPIFY_SHOP_DOMAIN required).
app.post('/api/sync-b2b-map', validateAuthenticatedSession, async (req, res) => {
  try {
    const session = res.locals.shopify?.session;
    if (!session?.shop || !session?.accessToken) {
      return res.status(401).json({ error: 'No authenticated Shopify session' });
    }
    const { runSync } = require('../lib/sync-b2b-map');
    const stats = await runSync({
      shop: session.shop,
      accessToken: session.accessToken,
    });
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('B2B Map Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(publicDir, { index: false }));

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Vercel Node serverless: export the Express app directly (see Vercel Express docs).
module.exports = app;
