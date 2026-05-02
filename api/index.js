const express = require('express');
const fs = require('fs');
const session = require('express-session');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('@shopify/shopify-api/adapters/node');

const {
  Session,
  LATEST_API_VERSION,
  GraphqlQueryError,
  HttpResponseError,
} = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');
const {
  applyShopifyDeploymentEnv,
  resolveShopifyHostName,
} = require('../lib/resolve-shopify-hostname');

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
  if (!html.includes('<head>')) return html;
  return html.replace('<head>', `<head>\n<meta name="shopify-api-key" content="${safe}">\n`);
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
  frameGuard: false,
}));

app.use(cors());
app.use(cookieParser());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory session storage (implements methods required by @shopify/shopify-app-express webhooks)
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

let shopifySessionStorage = memorySessionStorage;
let expressSessionStore;

const redisUrl = (process.env.REDIS_URL || '').trim();
if (redisUrl) {
  const { RedisSessionStorage } = require('@shopify/shopify-app-session-storage-redis');
  shopifySessionStorage = new RedisSessionStorage(redisUrl);
  const redisClient = createClient({ url: redisUrl });
  redisClient.on('error', (err) => console.error('[redis] express session client', err));
  redisClient.connect().catch((err) => console.error('[redis] connect failed', err));
  expressSessionStore = new RedisStore({
    client: redisClient,
    prefix: 'staff_app_express:',
  });
} else if (isProduction) {
  console.warn(
    '[shopify] REDIS_URL is not set. Sessions are in-memory and will not work reliably on Vercel. Add Vercel Redis (or any Redis) and set REDIS_URL.',
  );
}

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
      'read_users',
    ],
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
      return res.redirect(`/?shop=${shopifySession.shop}`);
    },
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

app.get(
  '/',
  ensureInstalledOnShop,
  validateAuthenticatedSession,
  shopifyCspHeaders,
  (req, res) => {
    try {
      const homeHtml = process.env.APP_HOME_HTML || 'simple.html';
      sendAppHtmlFile(res, homeHtml);
    } catch (error) {
      console.error('Error loading app:', error);
      res.status(500).send('Internal server error');
    }
  },
);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const getGraphqlClient = async (req, res) => {
  const sessionData = res.locals.shopify?.session;
  if (!sessionData) return null;
  return new shopify.clients.Graphql({ session: sessionData });
};

const throwIfGraphqlErrors = (response, label) => {
  const errs = response.body?.errors;
  if (errs?.length) {
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
      throw new Error('companies: empty data');
    }
    const { edges, pageInfo } = companiesData;

    // For each company, fetch orders to calculate performance
    for (const edge of edges) {
      const company = edge.node;

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
        totalSpend = orders.reduce((sum, order) => sum + parseFloat(order.totalPriceSet.shopMoney.amount), 0);
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

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
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

app.get('/api/staff', validateAuthenticatedSession, async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const query = `
      query getStaff($first: Int!, $after: String) {
        staffMembers(first: $first, after: $after) {
          edges {
            node {
              id
              firstName
              lastName
              email
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;
    let allStaff = [];
    let hasNextPage = true;
    let cursor = null;
    while (hasNextPage) {
      const response = await client.query({
        data: { query, variables: { first: 50, after: cursor } },
      });
      throwIfGraphqlErrors(response, 'staffMembers');
      const staffData = response.body?.data?.staffMembers;
      if (!staffData) {
        throw new Error('staffMembers: empty data');
      }
      allStaff = allStaff.concat(staffData.edges.map((edge) => edge.node));
      hasNextPage = staffData.pageInfo.hasNextPage;
      cursor = staffData.pageInfo.endCursor;
    }
    res.json({
      edges: allStaff.map((node) => ({ node })),
      pageInfo: { hasNextPage: false }
    });
  } catch (error) {
    if (error instanceof GraphqlQueryError || error instanceof HttpResponseError) {
      return sendShopifyApiError(res, error);
    }
    console.error('GET /api/staff', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/assign', validateAuthenticatedSession, async (req, res) => {
  try {
    const { staffId, companyLocationId } = req.body;
    const client = await getGraphqlClient(req, res);
    const mutation = `
      mutation companyLocationAssignStaffMembers($companyLocationId: ID!, $staffMemberIds: [ID!]!) {
        companyLocationAssignStaffMembers(companyLocationId: $companyLocationId, staffMemberIds: $staffMemberIds) {
          companyLocationStaffMemberAssignments { id }
          userErrors { message }
        }
      }
    `;
    const response = await client.query({
      data: { query: mutation, variables: { companyLocationId, staffMemberIds: [staffId] } },
    });
    res.json(response.body.data.companyLocationAssignStaffMembers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/assign', validateAuthenticatedSession, async (req, res) => {
  try {
    const { assignmentId } = req.body;
    const client = await getGraphqlClient(req, res);
    const mutation = `
      mutation companyLocationRemoveStaffMembers($companyLocationStaffMemberAssignmentIds: [ID!]!) {
        companyLocationRemoveStaffMembers(companyLocationStaffMemberAssignmentIds: $companyLocationStaffMemberAssignmentIds) {
          deletedCompanyLocationStaffMemberAssignmentIds
          userErrors { message }
        }
      }
    `;
    const response = await client.query({
      data: { query: mutation, variables: { companyLocationStaffMemberAssignmentIds: [assignmentId] } },
    });
    res.json(response.body.data.companyLocationRemoveStaffMembers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bulk-assign', validateAuthenticatedSession, async (req, res) => {
  try {
    const { staffId, locationCriteria } = req.body;
    const client = await getGraphqlClient(req, res);
    const companies = await fetchAllCompanies(client);
    const filteredLocations = [];

    companies.forEach((company) => {
      company.locations?.edges?.forEach((locationEdge) => {
        const location = locationEdge.node;
        const address = location.shippingAddress;
        if (!address) return;

        let matches = false;
        if (locationCriteria.state && address.province) {
          matches = address.province.toLowerCase().includes(locationCriteria.state.toLowerCase());
        }
        if (locationCriteria.city && address.city) {
          matches = matches || address.city.toLowerCase().includes(locationCriteria.city.toLowerCase());
        }
        if (locationCriteria.zip && address.zip) {
          matches = matches || address.zip.includes(locationCriteria.zip);
        }
        if (locationCriteria.country && address.country) {
          matches = matches || address.country.toLowerCase().includes(locationCriteria.country.toLowerCase());
        }

        if (matches) {
          filteredLocations.push({ id: location.id });
        }
      });
    });

    const mutation = `
      mutation companyLocationAssignStaffMembers($companyLocationId: ID!, $staffMemberIds: [ID!]!) {
        companyLocationAssignStaffMembers(companyLocationId: $companyLocationId, staffMemberIds: $staffMemberIds) {
          companyLocationStaffMemberAssignments { id }
          userErrors { message }
        }
      }
    `;

    let successCount = 0;
    for (const location of filteredLocations) {
      const response = await client.query({
        data: { query: mutation, variables: { companyLocationId: location.id, staffMemberIds: [staffId] } },
      });
      if (response.body.data.companyLocationAssignStaffMembers.userErrors.length === 0) {
        successCount++;
      }
    }

    res.json({ success: true, assigned: successCount, total: filteredLocations.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/companies-by-location', validateAuthenticatedSession, async (req, res) => {
  try {
    const { locationCriteria } = req.body;
    const client = await getGraphqlClient(req, res);
    const companies = await fetchAllCompanies(client);
    const filteredLocations = [];

    companies.forEach((company) => {
      company.locations?.edges?.forEach((locationEdge) => {
        const location = locationEdge.node;
        const address = location.shippingAddress;
        if (!address) return;

        let matches = false;
        if (locationCriteria.state && address.province) {
          matches = address.province.toLowerCase().includes(locationCriteria.state.toLowerCase());
        }
        if (locationCriteria.city && address.city) {
          matches = matches || address.city.toLowerCase().includes(locationCriteria.city.toLowerCase());
        }
        if (locationCriteria.zip && address.zip) {
          matches = matches || address.zip.includes(locationCriteria.zip);
        }
        if (locationCriteria.country && address.country) {
          matches = matches || address.country.toLowerCase().includes(locationCriteria.country.toLowerCase());
        }

        if (matches) {
          filteredLocations.push({
            ...location,
            companyName: company.name,
            companyId: company.id,
          });
        }
      });
    });

    res.json({ locations: filteredLocations, total: filteredLocations.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/companies', validateAuthenticatedSession, async (req, res) => {
  try {
    const { companyName, contactFirstName, contactLastName, contactEmail, address } = req.body;
    const client = await getGraphqlClient(req, res);

    const mutation = `
      mutation companyCreate($input: CompanyCreateInput!) {
        companyCreate(input: $input) {
          company {
            id
            name
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        company: { name: companyName },
        companyLocation: {
          name: "Main Location",
          shippingAddress: address,
          billingAddress: address
        },
        companyContact: {
          firstName: contactFirstName,
          lastName: contactLastName,
          email: contactEmail
        }
      }
    };

    const response = await client.query({
      data: { query: mutation, variables },
    });

    res.json(response.body.data.companyCreate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// B2B Sync Route
app.post('/api/sync-b2b-map', validateAuthenticatedSession, async (req, res) => {
  try {
    const { runSync } = require('../lib/sync-b2b-map');
    const stats = await runSync();
    res.json({ success: true, ...stats });
  } catch (err) {
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
