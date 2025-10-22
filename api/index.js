const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Shopify app
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration for Vercel
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // Only secure in production
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
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
      // Simple in-memory store for Vercel
      // Note: This will reset on each deployment
      if (!global.sessions) global.sessions = new Map();
      global.sessions.set(session.id, session);
      return true;
    },
    loadSession: async (id) => {
      // Load session from in-memory store
      if (!global.sessions) global.sessions = new Map();
      return global.sessions.get(id) || null;
    },
    deleteSession: async (id) => {
      // Delete session from in-memory store
      if (!global.sessions) global.sessions = new Map();
      global.sessions.delete(id);
      return true;
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

    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (error) {
    console.error('Error loading app:', error);
    res.status(500).send('Internal server error');
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
      appUrl: process.env.SHOPIFY_APP_URL
    }
  });
});

// API Routes
app.get('/api/companies', async (req, res) => {
  try {
    if (!req.session.shop) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session: req.session });
    
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
    if (!req.session.shop) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session: req.session });
    
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

      const companies = response.body.data.companies.edges.map(edge => edge.node);
      companies.forEach(company => {
        if (company.locations && company.locations.edges) {
          company.locations.edges.forEach(locationEdge => {
            const location = locationEdge.node;
            if (location.staffMemberAssignments && location.staffMemberAssignments.edges) {
              location.staffMemberAssignments.edges.forEach(assignmentEdge => {
                const staffMember = assignmentEdge.node.staffMember;
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

    if (!req.session.shop) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session: req.session });
    
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

    if (!req.session.shop) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session: req.session });
    
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
    timestamp: new Date().toISOString()
  });
});

// Export for Vercel
module.exports = app;