const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize SQLite database for sessions
const sqlite3 = require('sqlite3').verbose();
const sessionDb = new sqlite3.Database('sessions.sqlite');

// Create sessions table if it doesn't exist
sessionDb.serialize(() => {
  sessionDb.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      state TEXT,
      isOnline INTEGER DEFAULT 0,
      scope TEXT,
      expires INTEGER,
      accessToken TEXT,
      userId TEXT
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
  scopes: ['read_companies', 'write_companies'],
  hostName: process.env.SHOPIFY_APP_URL?.replace(/https?:\/\//, '') || 'localhost:3000',
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true,
});

// Initialize Shopify App
const shopifyAppMiddleware = shopifyApp({
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
      // Store session in SQLite database
      const db = require('sqlite3').Database;
      const sessionDb = new db('sessions.sqlite');
      
      return new Promise((resolve, reject) => {
        sessionDb.run(
          'INSERT OR REPLACE INTO sessions (id, shop, state, isOnline, scope, expires, accessToken, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [session.id, session.shop, session.state, session.isOnline, session.scope, session.expires, session.accessToken, session.userId],
          function(err) {
            if (err) reject(err);
            else resolve(true);
          }
        );
      });
    },
    loadSession: async (id) => {
      // Load session from SQLite database
      const db = require('sqlite3').Database;
      const sessionDb = new db('sessions.sqlite');
      
      return new Promise((resolve, reject) => {
        sessionDb.get(
          'SELECT * FROM sessions WHERE id = ?',
          [id],
          (err, row) => {
            if (err) reject(err);
            else if (row) {
              resolve({
                id: row.id,
                shop: row.shop,
                state: row.state,
                isOnline: row.isOnline === 1,
                scope: row.scope,
                expires: row.expires,
                accessToken: row.accessToken,
                userId: row.userId
              });
            } else {
              resolve(null);
            }
          }
        );
      });
    },
    deleteSession: async (id) => {
      // Delete session from SQLite database
      const db = require('sqlite3').Database;
      const sessionDb = new db('sessions.sqlite');
      
      return new Promise((resolve, reject) => {
        sessionDb.run(
          'DELETE FROM sessions WHERE id = ?',
          [id],
          function(err) {
            if (err) reject(err);
            else resolve(true);
          }
        );
      });
    },
  },
});

app.use(shopifyAppMiddleware);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', async (req, res) => {
  try {
    if (!req.session.shop) {
      return res.redirect('/auth');
    }

    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.redirect('/auth');
    }

    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (error) {
    console.error('Error loading app:', error);
    res.status(500).send('Internal server error');
  }
});

// API Routes
app.get('/api/companies', async (req, res) => {
  try {
    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
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
                    staffMemberAssignments(first: 10) {
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

    const response = await client.query({
      data: {
        query,
        variables: { first: 50 }
      }
    });

    res.json(response.body.data.companies);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/staff', async (req, res) => {
  try {
    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session });
    
    // Since we can't query staffMembers directly without read_users scope,
    // we'll get staff through company location assignments
    const query = `
      query getCompaniesWithStaff($first: Int!, $after: String) {
        companies(first: $first, after: $after) {
          edges {
            node {
              id
              locations(first: 10) {
                edges {
                  node {
                    id
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

    let allStaffMembers = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const response = await client.query({
        data: {
          query,
          variables: { first: 50, after: cursor }
        }
      });

      // Extract unique staff members from all company locations
      const companies = response.body.data.companies.edges.map(edge => edge.node);
      companies.forEach(company => {
        if (company.locations && company.locations.edges) {
          company.locations.edges.forEach(locationEdge => {
            const location = locationEdge.node;
            if (location.staffMemberAssignments && location.staffMemberAssignments.edges) {
              location.staffMemberAssignments.edges.forEach(assignmentEdge => {
                const staffMember = assignmentEdge.node.staffMember;
                // Only add if not already in the list
                if (!allStaffMembers.find(member => member.id === staffMember.id)) {
                  allStaffMembers.push(staffMember);
                }
              });
            }
          });
        }
      });

      hasNextPage = response.body.data.companies.pageInfo.hasNextPage;
      cursor = response.body.data.companies.pageInfo.endCursor;
    }

    // Format response to match expected structure
    const formattedResponse = {
      edges: allStaffMembers.map(member => ({
        node: member
      })),
      pageInfo: {
        hasNextPage: false,
        endCursor: null
      }
    };

    res.json(formattedResponse);
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

app.post('/api/assign', async (req, res) => {
  try {
    const { staffId, companyLocationId } = req.body;
    
    if (!staffId || !companyLocationId) {
      return res.status(400).json({ error: 'staffId and companyLocationId are required' });
    }

    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session });
    
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
        variables: { companyLocationId, staffMemberIds: [staffId] }
      }
    });

    const result = response.body.data.companyLocationAssignStaffMembers;
    
    if (result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors });
    }

    res.json({ success: true, assignment: result.companyLocationStaffMemberAssignments[0] });
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

    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
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

    const response = await client.query({
      data: {
        query: mutation,
        variables: { companyLocationStaffMemberAssignmentIds: [assignmentId] }
      }
    });

    const result = response.body.data.companyLocationRemoveStaffMembers;
    
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
app.post('/api/bulk-assign', async (req, res) => {
  try {
    const { staffId, locationCriteria } = req.body;
    
    if (!staffId || !locationCriteria) {
      return res.status(400).json({ error: 'staffId and locationCriteria are required' });
    }

    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
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
      const response = await client.query({
        data: {
          query: companiesQuery,
          variables: { first: 50, after: cursor }
        }
      });

      allCompanies = allCompanies.concat(response.body.data.companies.edges.map(edge => edge.node));
      hasNextPage = response.body.data.companies.pageInfo.hasNextPage;
      cursor = response.body.data.companies.pageInfo.endCursor;
    }

    // Filter company locations by location criteria
    const filteredLocations = [];
    allCompanies.forEach(company => {
      if (company.locations && company.locations.edges) {
        company.locations.edges.forEach(locationEdge => {
          const location = locationEdge.node;
          const address = location.shippingAddress;
          if (!address) return;
          
          // Check various location criteria
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
              address: address
            });
          }
        });
      }
    });

    if (filteredLocations.length === 0) {
      return res.json({ 
        success: false, 
        message: 'No company locations found matching the location criteria',
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

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const location of filteredLocations) {
      try {
        const response = await client.query({
          data: {
            query: assignmentMutation,
            variables: { companyLocationId: location.id, staffMemberIds: [staffId] }
          }
        });

        const result = response.body.data.companyLocationAssignStaffMembers;
        
        if (result.userErrors.length > 0) {
          errorCount++;
          errors.push({
            location: `${location.name} (${location.companyName})`,
            errors: result.userErrors
          });
        } else {
          successCount++;
        }
      } catch (error) {
        errorCount++;
        errors.push({
          location: `${location.name} (${location.companyName})`,
          errors: [{ message: error.message }]
        });
      }
    }

    res.json({
      success: successCount > 0,
      message: `Assigned to ${successCount} out of ${filteredLocations.length} company locations`,
      assigned: successCount,
      total: filteredLocations.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Error in bulk assignment:', error);
    res.status(500).json({ error: 'Failed to perform bulk assignment' });
  }
});

// Get companies by location filter
app.post('/api/companies-by-location', async (req, res) => {
  try {
    const { locationCriteria } = req.body;
    
    if (!locationCriteria) {
      return res.status(400).json({ error: 'locationCriteria is required' });
    }

    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
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
                    staffMemberAssignments(first: 10) {
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
      const response = await client.query({
        data: {
          query,
          variables: { first: 50, after: cursor }
        }
      });

      allCompanies = allCompanies.concat(response.body.data.companies.edges.map(edge => edge.node));
      hasNextPage = response.body.data.companies.pageInfo.hasNextPage;
      cursor = response.body.data.companies.pageInfo.endCursor;
    }

    // Filter company locations by location criteria
    const filteredLocations = [];
    allCompanies.forEach(company => {
      if (company.locations && company.locations.edges) {
        company.locations.edges.forEach(locationEdge => {
          const location = locationEdge.node;
          const address = location.shippingAddress;
          if (!address) return;
          
          // Check various location criteria
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
              companyId: company.id
            });
          }
        });
      }
    });

    res.json({
      locations: filteredLocations,
      total: filteredLocations.length,
      criteria: locationCriteria
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Shopify Staff Assignment App running on port ${PORT}`);
  console.log(`📱 App URL: ${process.env.SHOPIFY_APP_URL || `http://localhost:${PORT}`}`);
  console.log(`🔗 Install app in your Shopify store to get started`);
});
