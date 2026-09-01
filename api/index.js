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
const {
  listAppUsers,
  upsertAppUser,
  deleteAppUser,
  verifyPin,
  toHandle,
} = require('../lib/app-users');
const {
  assertNotLocked,
  recordPinFailure,
  clearPinGuard,
  setAppUserSession,
  publicSession,
  requireAppUser,
  requireAdmin,
} = require('../lib/admin-auth');
const { buildReportSummary } = require('../lib/reports-data');
const { isMissingDefinition } = require('../lib/shopify-gql');

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
app.get('/test-ui/staff', (req, res) => sendAppHtmlFile(res, 'staff.html'));

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
app.get('/staff', ensureInstalledOnShop, shopifyCspHeaders, sendAppPage('staff.html'));

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
      let lastOrderDate = null;
      try {
        const ordersQuery = `
        query getCompanyOrders($query: String!) {
          orders(first: 100, query: $query) {
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
        lastOrderDate = orders.length > 0 ? orders[0].createdAt : null;
      } catch (orderErr) {
        console.warn('orders for company', company.id, orderErr.message);
      }

      company.performance = {
        totalSpend,
        orderCount,
        lastOrderDate,
        avgOrderValue: orderCount > 0 ? totalSpend / orderCount : 0
      };

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

function sendAppUserError(res, err) {
  if (isMissingDefinition(err)) {
    return res.status(409).json({
      error: 'Leadership accounts are not set up on this shop yet. Run shopify app deploy, then open Staff to create the first admin account.',
      code: 'APP_USER_DEFINITION_MISSING',
    });
  }
  const status = err.status || 500;
  return res.status(status).json({ error: err.message });
}

function withoutPinHash(user) {
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    isAdmin: user.isAdmin,
  };
}

app.get('/api/app-users', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const users = await listAppUsers(client);
    res.json({ users: users.map(withoutPinHash) });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/app-users', error);
    return sendAppUserError(res, error);
  }
});

app.get('/api/admin/me', validateAuthenticatedSession, (req, res) => {
  const user = publicSession(req);
  if (!user) return res.status(401).json({ error: 'PIN sign-in required', code: 'ADMIN_PIN_REQUIRED' });
  res.json({ user });
});

app.post('/api/admin/logout', validateAuthenticatedSession, (req, res) => {
  req.session.appUser = null;
  res.json({ ok: true });
});

app.post('/api/admin/setup', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const users = await listAppUsers(client);
    if (users.length > 0) {
      return res.status(409).json({ error: 'An admin account already exists. Sign in with PIN.' });
    }
    const name = String(req.body?.name || 'Admin').trim() || 'Admin';
    const created = await upsertAppUser(client, {
      handle: toHandle(name),
      name,
      pin: req.body?.pin,
      isAdmin: true,
    });
    const user = { id: created.id, handle: created.handle, name, isAdmin: true };
    setAppUserSession(req, user);
    clearPinGuard(req);
    res.json({ user });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('POST /api/admin/setup', error);
    return sendAppUserError(res, error);
  }
});

app.post('/api/admin/login', validateAuthenticatedSession, async (req, res) => {
  try {
    assertNotLocked(req);
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const users = await listAppUsers(client);
    const user = users.find((u) => u.id === req.body?.userId);
    if (!user || !verifyPin(req.body?.pin, user.pinHash)) {
      recordPinFailure(req);
      return res.status(401).json({ error: 'Account or PIN is incorrect' });
    }
    clearPinGuard(req);
    const publicUser = withoutPinHash(user);
    setAppUserSession(req, publicUser);
    res.json({ user: publicUser });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('POST /api/admin/login', error);
    return sendAppUserError(res, error);
  }
});

app.get('/api/admin/users', validateAuthenticatedSession, requireAdmin, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const users = await listAppUsers(client);
    res.json({ users: users.map(withoutPinHash) });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/admin/users', error);
    return sendAppUserError(res, error);
  }
});

app.post('/api/admin/users', validateAuthenticatedSession, requireAdmin, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const created = await upsertAppUser(client, {
      handle: toHandle(name),
      name,
      pin: req.body?.pin,
      isAdmin: Boolean(req.body?.isAdmin),
    });
    res.json({ user: { id: created.id, handle: created.handle, name, isAdmin: Boolean(req.body?.isAdmin) } });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('POST /api/admin/users', error);
    return sendAppUserError(res, error);
  }
});

app.patch('/api/admin/users/:handle', validateAuthenticatedSession, requireAdmin, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const users = await listAppUsers(client);
    const user = users.find((u) => u.handle === req.params.handle);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const nextAdmin = req.body?.isAdmin == null ? user.isAdmin : Boolean(req.body.isAdmin);
    if (user.isAdmin && !nextAdmin && users.filter((u) => u.isAdmin).length <= 1) {
      return res.status(400).json({ error: 'Keep at least one admin account' });
    }
    const name = String(req.body?.name || user.name).trim() || user.name;
    await upsertAppUser(client, {
      handle: user.handle,
      name,
      pin: req.body?.pin || null,
      pinHash: req.body?.pin ? undefined : user.pinHash,
      isAdmin: nextAdmin,
    });
    if (req.session.appUser?.id === user.id) {
      setAppUserSession(req, { ...withoutPinHash(user), name, isAdmin: nextAdmin });
    }
    res.json({ user: { id: user.id, handle: user.handle, name, isAdmin: nextAdmin } });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('PATCH /api/admin/users/:handle', error);
    return sendAppUserError(res, error);
  }
});

app.delete('/api/admin/users/:handle', validateAuthenticatedSession, requireAdmin, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const users = await listAppUsers(client);
    const user = users.find((u) => u.handle === req.params.handle);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.isAdmin && users.filter((u) => u.isAdmin).length <= 1) {
      return res.status(400).json({ error: 'Keep at least one admin account' });
    }
    await deleteAppUser(client, user.id);
    if (req.session.appUser?.id === user.id) {
      req.session.appUser = null;
    }
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('DELETE /api/admin/users/:handle', error);
    return sendAppUserError(res, error);
  }
});

app.get('/api/reports/summary', validateAuthenticatedSession, requireAppUser, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });
    const summary = await buildReportSummary(client);
    res.json(summary);
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/reports/summary', error);
    res.status(500).json({ error: error.message });
  }
});

app.use(express.static(publicDir, { index: false }));

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Vercel Node serverless: export the Express app directly (see Vercel Express docs).
module.exports = app;
