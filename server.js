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
      // Store session in database
      console.log('Storing session:', session.id);
    },
    loadSession: async (id) => {
      // Load session from database
      console.log('Loading session:', id);
      return null;
    },
    deleteSession: async (id) => {
      // Delete session from database
      console.log('Deleting session:', id);
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
              locations {
                id
                name
                address {
                  address1
                  city
                  province
                  country
                  zip
                }
              }
              staff {
                id
                firstName
                lastName
                email
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
    
    const query = `
      query getStaff($first: Int!, $after: String) {
        staff(first: $first, after: $after) {
          edges {
            node {
              id
              firstName
              lastName
              email
              createdAt
              updatedAt
              companies {
                id
                name
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

    res.json(response.body.data.staff);
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

app.post('/api/assign', async (req, res) => {
  try {
    const { staffId, companyId } = req.body;
    
    if (!staffId || !companyId) {
      return res.status(400).json({ error: 'staffId and companyId are required' });
    }

    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session });
    
    const mutation = `
      mutation staffAssignToCompany($staffId: ID!, $companyId: ID!) {
        staffAssignToCompany(staffId: $staffId, companyId: $companyId) {
          staff {
            id
            firstName
            lastName
            email
            companies {
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
        variables: { staffId, companyId }
      }
    });

    const result = response.body.data.staffAssignToCompany;
    
    if (result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors });
    }

    res.json({ success: true, staff: result.staff });
  } catch (error) {
    console.error('Error assigning staff:', error);
    res.status(500).json({ error: 'Failed to assign staff' });
  }
});

app.delete('/api/assign', async (req, res) => {
  try {
    const { staffId, companyId } = req.body;
    
    if (!staffId || !companyId) {
      return res.status(400).json({ error: 'staffId and companyId are required' });
    }

    const session = await shopify.config.sessionStorage.loadSession(req.session.shop);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const client = new shopify.clients.Graphql({ session });
    
    const mutation = `
      mutation staffRemoveFromCompany($staffId: ID!, $companyId: ID!) {
        staffRemoveFromCompany(staffId: $staffId, companyId: $companyId) {
          staff {
            id
            firstName
            lastName
            email
            companies {
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
        variables: { staffId, companyId }
      }
    });

    const result = response.body.data.staffRemoveFromCompany;
    
    if (result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors });
    }

    res.json({ success: true, staff: result.staff });
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
              locations {
                id
                name
                address {
                  address1
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

    // Filter companies by location criteria
    const filteredCompanies = allCompanies.filter(company => {
      if (!company.locations || company.locations.length === 0) return false;
      
      return company.locations.some(location => {
        const address = location.address;
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

    // Assign staff to all filtered companies
    const assignmentMutation = `
      mutation staffAssignToCompany($staffId: ID!, $companyId: ID!) {
        staffAssignToCompany(staffId: $staffId, companyId: $companyId) {
          staff {
            id
            firstName
            lastName
            email
            companies {
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

    for (const company of filteredCompanies) {
      try {
        const response = await client.query({
          data: {
            query: assignmentMutation,
            variables: { staffId, companyId: company.id }
          }
        });

        const result = response.body.data.staffAssignToCompany;
        
        if (result.userErrors.length > 0) {
          errorCount++;
          errors.push({
            company: company.name,
            errors: result.userErrors
          });
        } else {
          successCount++;
        }
      } catch (error) {
        errorCount++;
        errors.push({
          company: company.name,
          errors: [{ message: error.message }]
        });
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
              locations {
                id
                name
                address {
                  address1
                  city
                  province
                  country
                  zip
                }
              }
              staff {
                id
                firstName
                lastName
                email
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

    // Filter companies by location criteria
    const filteredCompanies = allCompanies.filter(company => {
      if (!company.locations || company.locations.length === 0) return false;
      
      return company.locations.some(location => {
        const address = location.address;
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
