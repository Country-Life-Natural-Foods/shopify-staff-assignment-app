const express = require('express');
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

applyShopifyDeploymentEnv();

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
  (req, res) => {
    try {
      const homeHtml = process.env.APP_HOME_HTML || 'index.html';
      sendAppHtmlFile(res, homeHtml);
    } catch (error) {
      console.error('Error loading app:', error);
      res.status(500).send('Internal server error');
    }
  },
);

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

// In-memory staff registry (in production, store in database or metafield)
let staffRegistry = {
  staff: [
    {
      id: 'staff_default_admin',
      name: 'Admin',
      email: 'admin@countrylifefoods.com',
      commissionTier: 0,
      role: 'manager',
      createdAt: new Date().toISOString()
    }
  ]
};

// Get current user from session
const getCurrentUser = (req, res) => {
  const session = res.locals.shopify?.session;
  if (!session) return null;
  return {
    shop: session.shop,
    id: session.id,
    email: session.onlineAccessInfo?.associated_user?.email || 'unknown@shopify.com'
  };
};

// Check if user is manager
const isManager = (user) => {
  if (!user) return false;
  // For now, treat admins as managers. In production, check against staffRegistry
  return user.email.includes('countrylifefoods.com') || user.email === 'isaac.lewin@countrylifefoods.com';
};

// Get staff by email
const getStaffByEmail = (email) => {
  return staffRegistry.staff.find(s => s.email === email);
};

// Get staff by ID
const getStaffById = (id) => {
  return staffRegistry.staff.find(s => s.id === id);
};

const getGraphqlClient = async (req, res) => {
  const sessionData = res.locals.shopify?.session;
  if (!sessionData) return null;
  return new shopify.clients.Graphql({ session: sessionData });
};

const throwIfGraphqlErrors = (response, label) => {
  const body = response?.body;
  const gql = body?.errors?.graphQLErrors;
  if (Array.isArray(gql) && gql.length > 0) {
    throw new Error(`${label}: ${gql.map((e) => e.message).join('; ')}`);
  }
  const errs = body?.errors;
  if (Array.isArray(errs) && errs.length) {
    throw new Error(`${label}: ${errs.map((e) => e.message).join('; ')}`);
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

// Fetch real companies with performance data
const fetchAllCompanies = async (client) => {
  if (!client) return [];
  const query = `
    query getCompanies($first: Int!, $after: String) {
      companies(first: $first, after: $after) {
        edges {
          node {
            id
            name
            externalId
            createdAt
            updatedAt
            metafield(namespace: "clnf", key: "crm_notes") {
              value
            }
            locations(first: 10) {
              edges {
                node {
                  id
                  name
                  shippingAddress {
                    address1
                    city
                    province
                    country
                    zip
                  }
                  staffMemberAssignments(first: 50) {
                    edges {
                      node {
                        id
                        staffMember {
                          id
                          firstName
                          lastName
                          email
                        }
                      }
                    }
                  }
                }
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
      data: { query, variables: { first: 50, after: cursor } },
    });
    throwIfGraphqlErrors(response, 'companies');
    const companiesData = response.body?.data?.companies;
    if (!companiesData) {
      break;
    }
    const edges = companiesData.edges || [];
    const pageInfo = companiesData.pageInfo || { hasNextPage: false, endCursor: null };

    // For each company, fetch orders to calculate performance
    for (const edge of edges) {
      const company = edge.node;
      if (company.locations == null) {
        company.locations = { edges: [] };
      }

      let totalSpend = 0;
      let orderCount = 0;
      let orderDates = [];
      try {
        const ordersQuery = `
        query getCompanyOrders($query: String!) {
          orders(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                totalPriceSet {
                  shopMoney {
                    amount
                  }
                }
                createdAt
              }
            }
          }
        }
      `;

        const ordersResponse = await client.query({
          data: {
            query: ordersQuery,
            variables: { query: `company_id:${company.id.split('/').pop()}` }
          }
        });
        throwIfGraphqlErrors(ordersResponse, 'orders');
        const orderEdges = ordersResponse.body?.data?.orders?.edges;
        const orders = orderEdges ? orderEdges.map((e) => e.node) : [];
        totalSpend = orders.reduce((sum, order) => {
          const amt = order?.totalPriceSet?.shopMoney?.amount;
          return sum + (amt != null ? parseFloat(amt) : 0);
        }, 0);
        orderCount = orders.length;
        orderDates = orders.map(o => o.createdAt);
      } catch (orderErr) {
        console.warn('orders for company', company.id, orderErr.message);
      }

      const orderStats = calculateOrderStats(orderDates);

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

      company.performance = {
        totalSpend,
        orderCount,
        lastOrderDate: orderStats.lastOrderDate,
        daysSinceLastOrder: orderStats.daysSinceLastOrder,
        avgDaysBetweenOrders: orderStats.avgDaysBetweenOrders,
        avgOrderValue: orderCount > 0 ? totalSpend / orderCount : 0
      };

      company.notes = notes;

      all.push(company);
    }

    hasNextPage = Boolean(pageInfo.hasNextPage);
    cursor = pageInfo.endCursor || null;
  }
  return all;
};

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

    const { companyId } = req.params;
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

    const response = await client.query({
      data: { query, variables: { id: companyId } },
    });
    throwIfGraphqlErrors(response, 'company notes');

    let notes = [];
    const metafield = response.body?.data?.company?.metafield;
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

    const { companyId } = req.params;
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

    const getResponse = await client.query({
      data: { query: getQuery, variables: { id: companyId } },
    });
    throwIfGraphqlErrors(getResponse, 'fetch company notes');

    let notes = [];
    const metafield = getResponse.body?.data?.company?.metafield;
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

    // Update metafield
    const updateQuery = `
      mutation updateCompanyMetafield($input: CompanyInput!) {
        companyUpdate(input: $input) {
          company {
            id
            metafield(namespace: "clnf", key: "crm_notes") {
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateResponse = await client.query({
      data: {
        query: updateQuery,
        variables: {
          input: {
            id: companyId,
            metafields: [
              {
                namespace: 'clnf',
                key: 'crm_notes',
                type: 'json',
                value: JSON.stringify(notes)
              }
            ]
          }
        }
      }
    });

    throwIfGraphqlErrors(updateResponse, 'update company notes');
    const userErrors = updateResponse.body?.data?.companyUpdate?.userErrors;
    if (userErrors && userErrors.length > 0) {
      throw new Error(userErrors.map(e => e.message).join('; '));
    }

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

    const { companyId, noteId } = req.params;

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

    const getResponse = await client.query({
      data: { query: getQuery, variables: { id: companyId } },
    });
    throwIfGraphqlErrors(getResponse, 'fetch company notes');

    let notes = [];
    const metafield = getResponse.body?.data?.company?.metafield;
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

    // Update metafield
    const updateQuery = `
      mutation updateCompanyMetafield($input: CompanyInput!) {
        companyUpdate(input: $input) {
          company {
            id
            metafield(namespace: "clnf", key: "crm_notes") {
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateResponse = await client.query({
      data: {
        query: updateQuery,
        variables: {
          input: {
            id: companyId,
            metafields: [
              {
                namespace: 'clnf',
                key: 'crm_notes',
                type: 'json',
                value: JSON.stringify(notes)
              }
            ]
          }
        }
      }
    });

    throwIfGraphqlErrors(updateResponse, 'delete note');
    const userErrors = updateResponse.body?.data?.companyUpdate?.userErrors;
    if (userErrors && userErrors.length > 0) {
      throw new Error(userErrors.map(e => e.message).join('; '));
    }

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
    const user = getCurrentUser(req, res);
    const isUserManager = isManager(user);

    if (isUserManager) {
      // Managers see all staff
      res.json({ staff: staffRegistry.staff });
    } else {
      // Reps see only themselves
      const staffMember = getStaffByEmail(user.email);
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
    const user = getCurrentUser(req, res);
    if (!isManager(user)) {
      return res.status(403).json({ error: 'Only managers can manage staff' });
    }

    const { name, email, commissionTier, role } = req.body;
    if (!name || !email || commissionTier === undefined || !role) {
      return res.status(400).json({ error: 'name, email, commissionTier, and role required' });
    }

    if (!['manager', 'rep'].includes(role)) {
      return res.status(400).json({ error: 'role must be "manager" or "rep"' });
    }

    if (commissionTier < 0 || commissionTier > 100) {
      return res.status(400).json({ error: 'commissionTier must be between 0 and 100' });
    }

    // Check if staff member already exists
    let existing = getStaffByEmail(email);
    if (existing) {
      // Update existing
      existing.name = name;
      existing.commissionTier = commissionTier;
      existing.role = role;
    } else {
      // Create new
      const newStaff = {
        id: `staff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name,
        email,
        commissionTier,
        role,
        createdAt: new Date().toISOString()
      };
      staffRegistry.staff.push(newStaff);
      existing = newStaff;
    }

    res.json({ staff: existing });
  } catch (error) {
    console.error('POST /api/staff', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete staff member (managers only)
app.delete('/api/staff/:staffId', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = getCurrentUser(req, res);
    if (!isManager(user)) {
      return res.status(403).json({ error: 'Only managers can manage staff' });
    }

    const { staffId } = req.params;
    const index = staffRegistry.staff.findIndex(s => s.id === staffId);
    if (index === -1) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    staffRegistry.staff.splice(index, 1);
    res.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/staff/:staffId', error);
    res.status(500).json({ error: error.message });
  }
});

// Get commissions for a period (with role-based access)
app.get('/api/commissions', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = getCurrentUser(req, res);
    const isUserManager = isManager(user);
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    // Fetch all companies with their assignments and revenue
    const companies = await fetchAllCompanies(client);

    // Build commission data by staff
    const commissionsMap = {};

    for (const company of companies) {
      if (!company.locations || !company.locations.edges) continue;

      for (const locationEdge of company.locations.edges) {
        const location = locationEdge.node;
        if (!location.staffMemberAssignments || !location.staffMemberAssignments.edges) continue;

        for (const assignmentEdge of location.staffMemberAssignments.edges) {
          const assignment = assignmentEdge.node;
          const staffMember = assignment.staffMember;
          if (!staffMember) continue;

          const staffName = `${staffMember.firstName || ''} ${staffMember.lastName || ''}`.trim();
          const staffEmail = staffMember.email || `rep_${staffMember.id}`;

          // Find commission tier for this staff member
          const staffRecord = getStaffByEmail(staffEmail);
          const commissionTier = staffRecord?.commissionTier || 5; // Default to 5% if not configured

          if (!commissionsMap[staffEmail]) {
            commissionsMap[staffEmail] = {
              staffId: staffRecord?.id,
              name: staffRecord?.name || staffName,
              email: staffEmail,
              commissionTier,
              companies: [],
              totalRevenue: 0,
              totalCommission: 0
            };
          }

          const revenue = company.performance?.totalSpend || 0;
          const commission = (revenue * commissionTier) / 100;

          commissionsMap[staffEmail].companies.push({
            companyId: company.id,
            companyName: company.name,
            revenue,
            commission,
            lastOrderDate: company.performance?.lastOrderDate
          });

          commissionsMap[staffEmail].totalRevenue += revenue;
          commissionsMap[staffEmail].totalCommission += commission;
        }
      }
    }

    let commissions = Object.values(commissionsMap);

    // Apply role-based filtering
    if (!isUserManager) {
      // Reps can only see their own commissions
      commissions = commissions.filter(c => c.email === user.email);
    }

    // Sort by total commission descending
    commissions.sort((a, b) => b.totalCommission - a.totalCommission);

    res.json({
      commissions,
      isManager: isUserManager,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/commissions', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single rep's commission details (with privacy check)
app.get('/api/commissions/:staffEmail', validateAuthenticatedSession, async (req, res) => {
  try {
    const user = getCurrentUser(req, res);
    const isUserManager = isManager(user);
    const { staffEmail } = req.params;

    // Privacy check: reps can only see their own, managers can see all
    if (!isUserManager && user.email !== staffEmail) {
      return res.status(403).json({ error: 'You can only view your own commissions' });
    }

    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const companies = await fetchAllCompanies(client);
    let repCommissions = null;

    for (const company of companies) {
      if (!company.locations || !company.locations.edges) continue;

      for (const locationEdge of company.locations.edges) {
        const location = locationEdge.node;
        if (!location.staffMemberAssignments || !location.staffMemberAssignments.edges) continue;

        for (const assignmentEdge of location.staffMemberAssignments.edges) {
          const assignment = assignmentEdge.node;
          const staffMember = assignment.staffMember;
          if (!staffMember) continue;

          const currentEmail = staffMember.email || `rep_${staffMember.id}`;
          if (currentEmail !== staffEmail) continue;

          if (!repCommissions) {
            const staffRecord = getStaffByEmail(staffEmail);
            const commissionTier = staffRecord?.commissionTier || 5;
            repCommissions = {
              staffId: staffRecord?.id,
              name: staffRecord?.name || `${staffMember.firstName || ''} ${staffMember.lastName || ''}`.trim(),
              email: staffEmail,
              commissionTier,
              companies: [],
              totalRevenue: 0,
              totalCommission: 0
            };
          }

          const revenue = company.performance?.totalSpend || 0;
          const commission = (revenue * repCommissions.commissionTier) / 100;

          repCommissions.companies.push({
            companyId: company.id,
            companyName: company.name,
            revenue,
            commission,
            lastOrderDate: company.performance?.lastOrderDate,
            daysSinceLastOrder: company.performance?.daysSinceLastOrder
          });

          repCommissions.totalRevenue += revenue;
          repCommissions.totalCommission += commission;
        }
      }
    }

    if (!repCommissions) {
      return res.status(404).json({ error: 'No commissions found for this staff member' });
    }

    res.json({ commissions: repCommissions });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/commissions/:staffEmail', error);
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
      const response = await client.query({
        data: { query, variables: { first: 100, after: cursor } },
      });
      throwIfGraphqlErrors(response, 'metaobjects');
      const moData = response.body?.data?.metaobjects;
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
