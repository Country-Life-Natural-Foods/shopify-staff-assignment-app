// Environment variables will be loaded from .env file

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const connectSqlite3 = require('connect-sqlite3');
const connectRedis = require('connect-redis');
const { createClient } = require('redis');

// Load environment variables first
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('@shopify/shopify-api/adapters/node');

// Set required environment variables for Shopify API
process.env.SHOPIFY_HOSTNAME = process.env.SHOPIFY_HOSTNAME || 'localhost';
process.env.SHOPIFY_HOST = process.env.SHOPIFY_HOSTNAME || 'localhost';
process.env.SHOPIFY_API_VERSION = '2026-01';

// Set the hostName environment variable that shopifyApp expects
process.env.SHOPIFY_HOST_NAME = process.env.SHOPIFY_HOSTNAME || 'localhost';

// Debug environment variables
console.log('Environment variables:');
console.log('SHOPIFY_API_KEY:', process.env.SHOPIFY_API_KEY ? 'SET' : 'NOT SET');
console.log('SHOPIFY_API_SECRET:', process.env.SHOPIFY_API_SECRET ? 'SET' : 'NOT SET');
console.log('SHOPIFY_HOSTNAME:', process.env.SHOPIFY_HOSTNAME);
console.log('SHOPIFY_HOST:', process.env.SHOPIFY_HOST);
console.log('SHOPIFY_APP_URL:', process.env.SHOPIFY_APP_URL);

// Set environment variables if not loaded from .env
if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
  console.error('Missing required environment variables: SHOPIFY_API_KEY and SHOPIFY_API_SECRET');
  console.error('Please create a .env file with your Shopify app credentials');
  process.exit(1);
}

const { shopifyApi, LATEST_API_VERSION, Session, ApiVersion } = require('@shopify/shopify-api');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const publicDir = path.join(process.cwd(), 'public');

app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session storage setup
const SQLiteStore = connectSqlite3(session);
let redisClient = null;
let redisConnectPromise = null;

if (process.env.REDIS_URL) {
  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      tls: process.env.REDIS_URL.startsWith('rediss://'),
    },
  });

  redisClient.on('error', (error) => {
    console.error('Redis client error:', error);
  });

  redisConnectPromise = redisClient.connect().then(() => true).catch((error) => {
    console.error('Failed to connect to Redis, falling back to SQLite session storage.', error);
    redisClient = null;
    return false;
  });
}

const ensureRedisConnection = async () => {
  if (!redisClient) {
    return null;
  }

  if (redisClient.isOpen) {
    return redisClient;
  }

  if (!redisConnectPromise) {
    redisConnectPromise = redisClient.connect().then(() => true).catch((error) => {
      console.error('Failed to reconnect Redis client.', error);
      redisClient = null;
      return false;
    });
  }

  const connected = await redisConnectPromise;
  if (!connected || !redisClient || !redisClient.isOpen) {
    return null;
  }

  return redisClient;
};

let sessionStore;
if (redisClient) {
  const RedisStore = connectRedis(session);
  sessionStore = new RedisStore({
    client: redisClient,
    prefix: process.env.REDIS_SESSION_PREFIX || 'sess:',
  });
} else {
  sessionStore = new SQLiteStore({
    db: 'sessions.sqlite',
    dir: process.cwd(),
  });
}

app.use(session({
  store: sessionStore,
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

// Shopify session storage
let shopifySessionsDb;
const getShopifySessionsDb = () => {
  if (!shopifySessionsDb) {
    const dbPath = isProduction
      ? path.join(os.tmpdir(), 'shopify_sessions.sqlite')
      : path.join(process.cwd(), 'shopify_sessions.sqlite');
    shopifySessionsDb = new sqlite3.Database(dbPath);
    shopifySessionsDb.serialize(() => {
      shopifySessionsDb.run(`
        CREATE TABLE IF NOT EXISTS shopify_sessions (
          id TEXT PRIMARY KEY,
          session TEXT NOT NULL,
          expires INTEGER
        )
      );
      `);
    });
  }

  return shopifySessionsDb;
};

const sqliteSessionStorage = {
  storeSession: (sessionData) => new Promise((resolve, reject) => {
    const db = getShopifySessionsDb();
    const payload = JSON.stringify(sessionData.toPropertyArray());
    const expires = sessionData.expires ? sessionData.expires.getTime() : null;
    db.run(
      'INSERT OR REPLACE INTO shopify_sessions (id, session, expires) VALUES (?, ?, ?)',
      [sessionData.id, payload, expires],
      (error) => (error ? reject(error) : resolve(true)),
    );
  }),
  loadSession: (id) => new Promise((resolve, reject) => {
    if (!id) {
      return resolve(null);
    }

    const db = getShopifySessionsDb();
    db.get(
      'SELECT session FROM shopify_sessions WHERE id = ?',
      [id],
      (error, row) => {
        if (error) {
          return reject(error);
        }
        if (!row) {
          return resolve(null);
        }

        try {
          const entries = JSON.parse(row.session);
          resolve(Session.fromPropertyArray(entries));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  }),
  deleteSession: (id) => new Promise((resolve, reject) => {
    const db = getShopifySessionsDb();
    db.run(
      'DELETE FROM shopify_sessions WHERE id = ?',
      [id],
      (error) => (error ? reject(error) : resolve(true)),
    );
  }),
};

const redisSessionPrefix = process.env.REDIS_SESSION_PREFIX || 'shopify:sessions:';

const redisSessionStorage = {
  storeSession: async (sessionData) => {
    const client = await ensureRedisConnection();
    if (!client) {
      return sqliteSessionStorage.storeSession(sessionData);
    }

    const payload = JSON.stringify(sessionData.toPropertyArray());
    const ttlMs = sessionData.expires ? sessionData.expires.getTime() - Date.now() : undefined;

    if (ttlMs && ttlMs > 0) {
      await client.set(`${redisSessionPrefix}${sessionData.id}`, payload, { PX: ttlMs });
    } else {
      await client.set(`${redisSessionPrefix}${sessionData.id}`, payload);
    }

    return true;
  },
  loadSession: async (id) => {
    if (!id) {
      return null;
    }

    const client = await ensureRedisConnection();
    if (!client) {
      return sqliteSessionStorage.loadSession(id);
    }

    const data = await client.get(`${redisSessionPrefix}${id}`);
    if (!data) {
      return null;
    }

    return Session.fromPropertyArray(JSON.parse(data));
  },
  deleteSession: async (id) => {
    const client = await ensureRedisConnection();
    if (!client) {
      return sqliteSessionStorage.deleteSession(id);
    }

    await client.del(`${redisSessionPrefix}${id}`);
    return true;
  },
};

const shopifySessionStorage = redisClient ? redisSessionStorage : sqliteSessionStorage;

// Configure Shopify API properly
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_companies', 'write_companies'],
  hostName: process.env.SHOPIFY_HOSTNAME || 'localhost',
  apiVersion: ApiVersion.January26,
  isEmbeddedApp: true,
});

console.log('Shopify API configured with hostName:', process.env.SHOPIFY_HOSTNAME || 'localhost');

const { shopifyApp } = require('@shopify/shopify-app-express');

// Initialize Shopify App with proper authentication
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
      req.session.shop = shopifySession.shop;
      req.session.shopSessionId = shopifySession.id;

      await new Promise((resolve, reject) => {
        req.session.save((error) => (error ? reject(error) : resolve()));
      });

      return res.redirect(`/?shop=${shopifySession.shop}`);
    },
  },
  webhooks: {
    path: '/webhooks',
  },
  sessionStorage: shopifySessionStorage,
});

app.use(shopifyAppMiddleware);

// Serve static files
app.use(express.static(publicDir));

const loadActiveSession = async (req, res) => {
  if (res?.locals?.shopify?.session) {
    return res.locals.shopify.session;
  }

  const sessionId = req.session?.shopSessionId;
  if (!sessionId) {
    return null;
  }

  return shopifySessionStorage.loadSession(sessionId);
};

// Routes
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasApiKey: !!process.env.SHOPIFY_API_KEY,
      hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
      hasAppUrl: !!process.env.SHOPIFY_APP_URL,
      hasSessionSecret: !!process.env.SESSION_SECRET,
      usingRedis: Boolean(redisClient),
      appUrl: process.env.SHOPIFY_APP_URL,
    },
  });
});

// Debug endpoint for troubleshooting
app.get('/debug', async (req, res) => {
  try {
    const sessionData = await loadActiveSession(req, res);
    res.json({
      hasSession: !!sessionData,
      sessionShop: sessionData?.shop,
      sessionId: sessionData?.id,
      sessionExpires: sessionData?.expires,
      reqSession: {
        shop: req.session?.shop,
        shopSessionId: req.session?.shopSessionId,
      },
      headers: {
        authorization: req.headers.authorization,
        cookie: req.headers.cookie ? 'present' : 'missing',
      },
      env: {
        apiVersion: process.env.SHOPIFY_API_VERSION,
        hostname: process.env.SHOPIFY_HOSTNAME,
        appUrl: process.env.SHOPIFY_APP_URL,
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Debug endpoint error',
      details: error.message,
      stack: error.stack
    });
  }
});

const getGraphqlClient = async (req, res) => {
  try {
    const sessionData = await loadActiveSession(req, res);
    if (!sessionData) {
      console.log('No active session found');
      return null;
    }

    console.log('Creating GraphQL client for session:', sessionData.shop);
    return new shopify.clients.Graphql({ session: sessionData });
  } catch (error) {
    console.error('Error creating GraphQL client:', error);
    return null;
  }
};

const fetchAllCompanies = async (client) => {
  if (!client) {
    // Fallback to sample data if no client
    return [
      {
        id: 'gid://shopify/Company/1',
        name: 'Country Life Foods',
        externalId: 'CLF001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        locations: {
          edges: [
            {
              node: {
                id: 'gid://shopify/CompanyLocation/1',
                name: 'Main Warehouse',
                shippingAddress: {
                  address1: '123 Main Street',
                  city: 'Detroit',
                  province: 'Michigan',
                  country: 'United States',
                  zip: '48201'
                },
                staffMemberAssignments: {
                  edges: [
                    {
                      node: {
                        id: 'gid://shopify/StaffAssignment/1',
                        staffMember: {
                          id: 'gid://shopify/StaffMember/1',
                          firstName: 'John',
                          lastName: 'Smith',
                          email: 'john.smith@countrylife.com',
                          active: true,
                          isShopOwner: false
                        }
                      }
                    }
                  ]
                }
              }
            }
          ]
        }
      }
    ];
  }

  // Use the current B2B API to get real companies
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
                          active
                          isShopOwner
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
    try {
      console.log('Executing GraphQL query with cursor:', cursor);
      const response = await client.query({
        data: {
          query,
          variables: { first: 50, after: cursor },
        },
      });

      console.log('GraphQL response received:', JSON.stringify(response.body, null, 2));
      
      if (response.body.errors) {
        console.error('GraphQL errors:', response.body.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(response.body.errors)}`);
      }

      if (!response.body.data || !response.body.data.companies) {
        console.error('No companies data in response:', response.body);
        throw new Error('No companies data in GraphQL response');
      }

      const { edges, pageInfo } = response.body.data.companies;
      all.push(...edges.map((edge) => edge.node));
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    } catch (error) {
      console.error('Error in GraphQL query execution:', error);
      throw error;
    }
  }

  return all;
};

// API Routes
app.get('/api/companies', async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    const companies = await fetchAllCompanies(client);
    
    res.json({
      edges: companies.map((company) => ({ node: company })),
      pageInfo: {
        hasNextPage: false,
        endCursor: null,
      },
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to fetch companies',
      details: error.message,
      type: error.constructor.name,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/api/staff', async (req, res) => {
  try {
    const client = await getGraphqlClient(req, res);
    const companies = await fetchAllCompanies(client);
    const staffMap = new Map();

    companies.forEach((company) => {
      company.locations?.edges?.forEach((locationEdge) => {
        locationEdge.node.staffMemberAssignments?.edges?.forEach((assignmentEdge) => {
          const staff = assignmentEdge.node.staffMember;
          if (staff && !staffMap.has(staff.id)) {
            staffMap.set(staff.id, staff);
          }
        });
      });
    });

    res.json({
      edges: Array.from(staffMap.values()).map((staff) => ({ node: staff })),
      pageInfo: {
        hasNextPage: false,
        endCursor: null,
      },
    });
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ 
      error: 'Failed to fetch staff',
      details: error.message 
    });
  }
});

app.post('/api/assign', async (req, res) => {
  try {
    const { staffId, companyLocationId } = req.body;

    if (!staffId || !companyLocationId) {
      return res.status(400).json({ error: 'staffId and companyLocationId are required' });
    }

    const client = await getGraphqlClient(req, res);
    if (!client) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const mutation = `
      mutation companyLocationAssignStaffMembers($companyLocationId: ID!, $staffMemberIds: [ID!]!) {
        companyLocationAssignStaffMembers(companyLocationId: $companyLocationId, staffMemberIds: $staffMemberIds) {
          companyLocationStaffMemberAssignments {
            id
            staffMember {
              id
              firstName
              lastName
              email
            }
            companyLocation {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query: mutation,
        variables: { companyLocationId, staffMemberIds: [staffId] },
      },
    });

    const result = response.body.data.companyLocationAssignStaffMembers;

    if (result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors });
    }

    return res.json({ success: true, assignment: result.companyLocationStaffMemberAssignments[0] });
  } catch (error) {
    console.error('Error assigning staff:', error);
    res.status(500).json({ error: 'Failed to assign staff' });
  }
});

app.delete('/api/assign', async (req, res) => {
  try {
    const { assignmentId } = req.body;

    if (!assignmentId) {
      return res.status(400).json({ error: 'assignmentId is required' });
    }

    const client = await getGraphqlClient(req, res);
    if (!client) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const mutation = `
      mutation companyLocationRemoveStaffMembers($companyLocationStaffMemberAssignmentIds: [ID!]!) {
        companyLocationRemoveStaffMembers(companyLocationStaffMemberAssignmentIds: $companyLocationStaffMemberAssignmentIds) {
          deletedCompanyLocationStaffMemberAssignmentIds
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query: mutation,
        variables: { companyLocationStaffMemberAssignmentIds: [assignmentId] },
      },
    });

    const result = response.body.data.companyLocationRemoveStaffMembers;

    if (result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors });
    }

    return res.json({ success: true, deletedIds: result.deletedCompanyLocationStaffMemberAssignmentIds });
  } catch (error) {
    console.error('Error removing staff:', error);
    res.status(500).json({ error: 'Failed to remove staff' });
  }
});

app.post('/api/bulk-assign', async (req, res) => {
  try {
    const { staffId, locationCriteria } = req.body;

    if (!staffId || !locationCriteria) {
      return res.status(400).json({ error: 'staffId and locationCriteria are required' });
    }

    const client = await getGraphqlClient(req, res);
    if (!client) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const companies = await fetchAllCompanies(client);
    const filteredLocations = [];

    companies.forEach((company) => {
      company.locations?.edges?.forEach((locationEdge) => {
        const location = locationEdge.node;
        const address = location.shippingAddress;
        if (!address) {
          return;
        }

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
            id: location.id,
            name: location.name,
            companyName: company.name,
          });
        }
      });
    });

    if (filteredLocations.length === 0) {
      return res.json({
        success: false,
        message: 'No company locations found matching the location criteria',
        assigned: 0,
        total: 0,
      });
    }

    const mutation = `
      mutation companyLocationAssignStaffMembers($companyLocationId: ID!, $staffMemberIds: [ID!]!) {
        companyLocationAssignStaffMembers(companyLocationId: $companyLocationId, staffMemberIds: $staffMemberIds) {
          companyLocationStaffMemberAssignments {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    let successCount = 0;
    const errors = [];

    for (const location of filteredLocations) {
      try {
        const response = await client.query({
          data: {
            query: mutation,
            variables: { companyLocationId: location.id, staffMemberIds: [staffId] },
          },
        });

        const result = response.body.data.companyLocationAssignStaffMembers;
        if (result.userErrors.length > 0) {
          errors.push({
            location: `${location.name} (${location.companyName})`,
            errors: result.userErrors,
          });
        } else {
          successCount += 1;
        }
      } catch (error) {
        errors.push({
          location: `${location.name} (${location.companyName})`,
          errors: [{ message: error.message }],
        });
      }
    }

    res.json({
      success: successCount > 0,
      message: `Assigned to ${successCount} out of ${filteredLocations.length} company locations`,
      assigned: successCount,
      total: filteredLocations.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error in bulk assignment:', error);
    res.status(500).json({ error: 'Failed to perform bulk assignment' });
  }
});

app.post('/api/companies-by-location', async (req, res) => {
  try {
    const { locationCriteria } = req.body;

    if (!locationCriteria) {
      return res.status(400).json({ error: 'locationCriteria is required' });
    }

    const client = await getGraphqlClient(req, res);
    if (!client) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const companies = await fetchAllCompanies(client);
    const filteredLocations = [];

    companies.forEach((company) => {
      company.locations?.edges?.forEach((locationEdge) => {
        const location = locationEdge.node;
        const address = location.shippingAddress;
        if (!address) {
          return;
        }

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

    res.json({
      locations: filteredLocations,
      total: filteredLocations.length,
      criteria: locationCriteria,
    });
  } catch (error) {
    console.error('Error filtering companies by location:', error);
    res.status(500).json({ error: 'Failed to filter companies by location' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });
});

// Start server for local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

// Export for Vercel
module.exports = app;