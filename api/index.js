const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('@shopify/shopify-api/adapters/node');

const { shopifyApi, Session, ApiVersion } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const publicDir = path.join(process.cwd(), 'public');

app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  frameGuard: false,
}));

app.use(cors());

// Shopify embedded app: set frame-ancestors
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

// Express session setup
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

const hostName = process.env.SHOPIFY_HOSTNAME || process.env.SHOPIFY_APP_URL?.replace(/^https?:\/\//, '') || 'localhost';

// Configuration for Shopify API
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY || 'dummy_key',
  apiSecretKey: process.env.SHOPIFY_API_SECRET || 'dummy_secret',
  scopes: ['read_companies', 'write_companies', 'read_customers', 'write_customers', 'read_users', 'read_orders'],
  hostName: hostName,
  apiVersion: ApiVersion.January26,
  isEmbeddedApp: true,
});

// Initialize Shopify App
const shopifyAppInstance = shopifyApp({
  api: shopify,
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
  sessionStorage: memorySessionStorage,
});

app.use(shopifyAppInstance);

// Serve static files
app.use(express.static(publicDir));

const loadActiveSession = async (req, res) => {
  if (res?.locals?.shopify?.session) {
    return res.locals.shopify.session;
  }
  const sessionId = req.session?.shopSessionId || req.query.shop;
  if (!sessionId) return null;
  return memorySessionStorage.loadSession(sessionId);
};

// Routes
app.get('/test-ui', (req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.get('/', async (req, res) => {
  try {
    const sessionData = await loadActiveSession(req, res);
    if (!sessionData) {
      const shop = req.query.shop || req.session.shop;
      const redirectTarget = shop ? `/auth?shop=${encodeURIComponent(shop)}` : '/auth';
      return res.redirect(redirectTarget);
    }
    return res.sendFile(path.join(publicDir, 'index.html'));
  } catch (error) {
    console.error('Error loading app:', error);
    return res.status(500).send('Internal server error');
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const getGraphqlClient = async (req, res) => {
  const sessionData = await loadActiveSession(req, res);
  if (!sessionData) return null;
  return new shopify.clients.Graphql({ session: sessionData });
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
    const { edges, pageInfo } = response.body.data.companies;

    // For each company, fetch orders to calculate performance
    for (const edge of edges) {
      const company = edge.node;

      // Fetch orders for this company
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
      
      const orders = ordersResponse.body.data.orders.edges.map(e => e.node);
      const totalSpend = orders.reduce((sum, order) => sum + parseFloat(order.totalPriceSet.shopMoney.amount), 0);
      const orderCount = orders.length;
      const lastOrderDate = orders.length > 0 ? orders[0].createdAt : null;

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
app.get('/api/companies', async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    const companies = await fetchAllCompanies(client);
    res.json({ edges: companies.map(c => ({ node: c })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/staff', async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    if (!client) return res.status(401).json({ error: 'Unauthorized' });

    const query = `
      query getUsers($first: Int!) {
        users(first: $first) {
          edges {
            node {
              id
              firstName
              lastName
              email
            }
          }
        }
      }
    `;
    const response = await client.query({ data: { query, variables: { first: 50 } } });
    res.json(response.body.data.users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/assign', async (req, res) => {
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

app.delete('/api/assign', async (req, res) => {
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

app.post('/api/bulk-assign', async (req, res) => {
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

app.post('/api/companies-by-location', async (req, res) => {
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

app.post('/api/companies', async (req, res) => {
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
app.post('/api/sync-b2b-map', async (req, res) => {
  try {
    const { runSync } = require('../lib/sync-b2b-map');
    const stats = await runSync();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
