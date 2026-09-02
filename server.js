const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
require('dotenv').config();

const { runSync } = require('./lib/sync-b2b-map');

const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');

const app = express();
const PORT = process.env.PORT || 3000;
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_URL?.replace('./', '') || 'sessions.sqlite');

// Initialize database table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS shopify_sessions (
      id TEXT PRIMARY KEY,
      shop TEXT,
      state TEXT,
      isOnline INTEGER,
      scope TEXT,
      expires INTEGER,
      accessToken TEXT,
      onlineAccessInfo TEXT
    )
  `);
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Shopify app
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite' }),
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Initialize Shopify API
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_companies', 'write_companies', 'read_customers', 'write_customers'],
  hostName: process.env.SHOPIFY_APP_URL?.replace(/https?:\/\//, '') || 'localhost:3000',
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true,
});

// Initialize Shopify App
const shopifyAppInstance = shopifyApp({
  api: shopify,
  auth: {
    path: '/auth',
    callbackPath: '/auth/callback',
  },
  webhooks: {
    path: '/webhooks',
  },
  sessionStorage: {
    storeSession: async (session) => {
      return new Promise((resolve, reject) => {
        const { id, shop, state, isOnline, scope, expires, accessToken, onlineAccessInfo } = session;
        db.run(
          `INSERT OR REPLACE INTO shopify_sessions
          (id, shop, state, isOnline, scope, expires, accessToken, onlineAccessInfo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, shop, state, isOnline ? 1 : 0, scope, expires ? expires.getTime() : null, accessToken, JSON.stringify(onlineAccessInfo)],
          (err) => {
            if (err) {
              console.error('Error storing session:', err);
              reject(err);
            } else {
              resolve(true);
            }
          }
        );
      });
    },
    loadSession: async (id) => {
      return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM shopify_sessions WHERE id = ?`, [id], (err, row) => {
          if (err) {
            console.error('Error loading session:', err);
            reject(err);
          } else if (!row) {
            resolve(null);
          } else {
            const session = new Session({
              id: row.id,
              shop: row.shop,
              state: row.state,
              isOnline: row.isOnline === 1,
              scope: row.scope,
              expires: row.expires ? new Date(row.expires) : undefined,
              accessToken: row.accessToken,
              onlineAccessInfo: row.onlineAccessInfo ? JSON.parse(row.onlineAccessInfo) : undefined,
            });
            resolve(session);
          }
        });
      });
    },
    deleteSession: async (id) => {
      return new Promise((resolve, reject) => {
        db.run(`DELETE FROM shopify_sessions WHERE id = ?`, [id], (err) => {
          if (err) {
            console.error('Error deleting session:', err);
            reject(err);
          } else {
            resolve(true);
          }
        });
      });
    },
  },
});

// Auth Routes
app.get(shopifyAppInstance.config.auth.path, shopifyAppInstance.auth.begin());
app.get(
  shopifyAppInstance.config.auth.callbackPath,
  shopifyAppInstance.auth.callback(),
  shopifyAppInstance.redirectToShopifyOrAppRoot(),
);
app.post(
  shopifyAppInstance.config.webhooks.path,
  express.text({type: '*/*'}),
  shopifyAppInstance.processWebhooks(),
);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', shopifyAppInstance.ensureInstalledOnShop(), async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.get('/api/companies', shopifyAppInstance.validateAuthenticatedSession(), async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.clients.Graphql({ session });

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
              locations(first: 50) {
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
                    billingAddress {
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

    let allCompanies = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const response = await client.request(query, {
        variables: { first: 50, after: cursor }
      });

      const companies = response.data.companies;
      allCompanies = allCompanies.concat(companies.edges.map(edge => edge.node));
      hasNextPage = companies.pageInfo.hasNextPage;
      cursor = companies.pageInfo.endCursor;
    }

    res.json({
      edges: allCompanies.map(node => ({ node })),
      pageInfo: { hasNextPage: false }
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/staff', shopifyAppInstance.validateAuthenticatedSession(), async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.clients.Graphql({ session });

    const query = `
      query getStaff($first: Int!, $after: String) {
        staffMembers(first: $first, after: $after) {
          edges {
            node {
              id
              firstName
              lastName
              email
              # Note: companies and companyLocations are not directly available on StaffMember in standard queries
              # They are managed via CompanyLocationStaffMemberAssignment
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
      const response = await client.request(query, {
        variables: { first: 50, after: cursor }
      });

      const staff = response.data.staffMembers;
      allStaff = allStaff.concat(staff.edges.map(edge => edge.node));
      hasNextPage = staff.pageInfo.hasNextPage;
      cursor = staff.pageInfo.endCursor;
    }

    res.json({
      edges: allStaff.map(node => ({ node })),
      pageInfo: { hasNextPage: false }
    });
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

app.post('/api/assign', shopifyAppInstance.validateAuthenticatedSession(), async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const { staffId, companyId } = req.body;

    if (!staffId || !companyId) {
      return res.status(400).json({ error: 'staffId and companyId are required' });
    }

    const client = new shopify.clients.Graphql({ session });

    const mutation = `
      mutation companyLocationAssignStaffMembers($companyLocationId: ID!, $staffMemberIds: [ID!]!) {
        companyLocationAssignStaffMembers(companyLocationId: $companyLocationId, staffMemberIds: $staffMemberIds) {
          companyLocationStaffMemberAssignments {
            id
            companyLocation {
              id
              name
            }
            staffMember {
              id
              firstName
              lastName
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await client.request(mutation, {
      variables: {
        companyLocationId: companyId, // Note: In UI this is passed as companyId but it should be location ID
        staffMemberIds: [staffId]
      }
    });

    const result = response.data.companyLocationAssignStaffMembers;

    if (result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors });
    }

    res.json({ success: true, assignments: result.companyLocationStaffMemberAssignments });
  } catch (error) {
    console.error('Error assigning staff:', error);
    res.status(500).json({ error: 'Failed to assign staff' });
  }
});

app.delete('/api/assign', shopifyAppInstance.validateAuthenticatedSession(), async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const { assignmentIds } = req.body;

    if (!assignmentIds || !Array.isArray(assignmentIds)) {
      return res.status(400).json({ error: 'assignmentIds (array) is required' });
    }

    const client = new shopify.clients.Graphql({ session });

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

    const response = await client.request(mutation, {
      variables: { companyLocationStaffMemberAssignmentIds: assignmentIds }
    });

    const result = response.data.companyLocationRemoveStaffMembers;

    if (result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors });
    }

    res.json({ success: true, deletedIds: result.deletedCompanyLocationStaffMemberAssignmentIds });
  } catch (error) {
    console.error('Error removing staff:', error);
    res.status(500).json({ error: 'Failed to remove staff' });
  }
});

// Bulk assignment by location
app.post('/api/bulk-assign', shopifyAppInstance.validateAuthenticatedSession(), async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const { staffId, locationCriteria } = req.body;

    if (!staffId || !locationCriteria) {
      return res.status(400).json({ error: 'staffId and locationCriteria are required' });
    }

    const client = new shopify.clients.Graphql({ session });

    // First, get all companies to filter by location
    const companiesQuery = `
      query getCompanies($first: Int!, $after: String) {
        companies(first: $first, after: $after) {
          edges {
            node {
              id
              name
              locations(first: 50) {
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

    let allCompanies = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const response = await client.request(companiesQuery, {
        variables: { first: 50, after: cursor }
      });

      allCompanies = allCompanies.concat(response.data.companies.edges.map(edge => edge.node));
      hasNextPage = response.data.companies.pageInfo.hasNextPage;
      cursor = response.data.companies.pageInfo.endCursor;
    }

    // Filter companies by location criteria
    const filteredCompanies = allCompanies.filter(company => {
      const locations = company.locations?.edges?.map(e => e.node) || [];
      if (locations.length === 0) return false;

      return locations.some(location => {
        const address = location.shippingAddress;
        if (!address) return false;

        // Check various location criteria
        if (locationCriteria.state && address.province) {
          return address.province.toLowerCase().includes(locationCriteria.state.toLowerCase());
        }
        if (locationCriteria.city && address.city) {
          return address.city.toLowerCase().includes(locationCriteria.city.toLowerCase());
        }
        if (locationCriteria.zip && address.zip) {
          return address.zip.includes(locationCriteria.zip);
        }
        if (locationCriteria.country && address.country) {
          return address.country.toLowerCase().includes(locationCriteria.country.toLowerCase());
        }

        return false;
      });
    });

    if (filteredCompanies.length === 0) {
      return res.json({
        success: false,
        message: 'No companies found matching the location criteria',
        assigned: 0,
        total: 0
      });
    }

    // Assign staff to all filtered company locations
    const assignmentMutation = `
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
    let errorCount = 0;
    const errors = [];

    for (const company of filteredCompanies) {
      const locations = company.locations?.edges?.map(e => e.node) || [];
      for (const location of locations) {
        try {
          const response = await client.request(assignmentMutation, {
            variables: {
              companyLocationId: location.id,
              staffMemberIds: [staffId]
            }
          });

          const result = response.data.companyLocationAssignStaffMembers;

          if (result.userErrors.length > 0) {
            errorCount++;
            errors.push({
              company: `${company.name} - ${location.name}`,
              errors: result.userErrors
            });
          } else {
            successCount++;
          }
        } catch (error) {
          errorCount++;
          errors.push({
            company: `${company.name} - ${location.name}`,
            errors: [{ message: error.message }]
          });
        }
      }
    }

    res.json({
      success: successCount > 0,
      message: `Assigned to ${successCount} out of ${filteredCompanies.length} companies`,
      assigned: successCount,
      total: filteredCompanies.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Error in bulk assignment:', error);
    res.status(500).json({ error: 'Failed to perform bulk assignment' });
  }
});

// Get companies by location filter
app.post('/api/companies-by-location', shopifyAppInstance.validateAuthenticatedSession(), async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const { locationCriteria } = req.body;

    if (!locationCriteria) {
      return res.status(400).json({ error: 'locationCriteria is required' });
    }

    const client = new shopify.clients.Graphql({ session });

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
              locations(first: 50) {
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

    let allCompanies = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const response = await client.request(query, {
        variables: { first: 50, after: cursor }
      });

      allCompanies = allCompanies.concat(response.data.companies.edges.map(edge => edge.node));
      hasNextPage = response.data.companies.pageInfo.hasNextPage;
      cursor = response.data.companies.pageInfo.endCursor;
    }

    // Filter companies by location criteria
    const filteredCompanies = allCompanies.filter(company => {
      const locations = company.locations?.edges?.map(e => e.node) || [];
      if (locations.length === 0) return false;

      return locations.some(location => {
        const address = location.shippingAddress;
        if (!address) return false;

        // Check various location criteria
        if (locationCriteria.state && address.province) {
          return address.province.toLowerCase().includes(locationCriteria.state.toLowerCase());
        }
        if (locationCriteria.city && address.city) {
          return address.city.toLowerCase().includes(locationCriteria.city.toLowerCase());
        }
        if (locationCriteria.zip && address.zip) {
          return address.zip.includes(locationCriteria.zip);
        }
        if (locationCriteria.country && address.country) {
          return address.country.toLowerCase().includes(locationCriteria.country.toLowerCase());
        }

        return false;
      });
    });

    res.json({
      companies: filteredCompanies,
      total: filteredCompanies.length,
      criteria: locationCriteria
    });

  } catch (error) {
    console.error('Error filtering companies by location:', error);
    res.status(500).json({ error: 'Failed to filter companies by location' });
  }
});

/**
 * B2B Map Sync - Manual trigger or cron
 * POST /api/sync-b2b-map
 * Requires: SHOPIFY_SHOP_DOMAIN, MAPBOX_ACCESS_TOKEN, and either
 *   SHOPIFY_ADMIN_ACCESS_TOKEN (legacy) OR SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard)
 * If CRON_SECRET is set, requests must include header: x-cron-secret: <CRON_SECRET>
 */
app.post('/api/sync-b2b-map', async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['x-cron-secret'] !== secret) {
      return res.status(403).json({ error: 'Invalid or missing cron secret' });
    }
    const hasAuth =
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
      (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
    if (!hasAuth || !process.env.MAPBOX_ACCESS_TOKEN) {
      return res.status(500).json({
        error:
          'B2B map sync not configured. Set SHOPIFY_SHOP_DOMAIN, MAPBOX_ACCESS_TOKEN, and either SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.',
      });
    }
    const stats = await runSync();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('B2B Map Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// B2B Map Sync - daily at midnight (configurable via CRON_SCHEDULE, default: 0 0 * * * = midnight UTC)
const cronSchedule = process.env.CRON_SCHEDULE || '0 0 * * *';
const hasB2bMapAuth =
  process.env.MAPBOX_ACCESS_TOKEN &&
  (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
    (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET));
if (hasB2bMapAuth && process.env.SHOPIFY_SHOP_DOMAIN) {
  cron.schedule(cronSchedule, async () => {
    try {
      console.log('Running scheduled B2B map sync...');
      const stats = await runSync();
      console.log('B2B map sync complete:', stats);
    } catch (err) {
      console.error('Scheduled B2B map sync failed:', err);
    }
  });
  console.log(`🗺️ B2B map sync scheduled: ${cronSchedule} (midnight UTC by default)`);
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Shopify Staff Assignment App running on port ${PORT}`);
  console.log(`📱 App URL: ${process.env.SHOPIFY_APP_URL || `http://localhost:${PORT}`}`);
  console.log(`🔗 Install app in your Shopify store to get started`);
});
