const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Shopify app
}));

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Basic route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Production API routes with error handling
app.get('/api/companies', async (req, res) => {
  try {
    // TODO: Replace with real Shopify API calls when credentials are available
    // For now, return mock data for testing
    res.json({
      edges: [
        {
          node: {
            id: 'gid://shopify/Company/1',
            name: 'Test Company',
            externalId: 'EXT001',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            locations: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/CompanyLocation/1',
                    name: 'Main Office',
                    shippingAddress: {
                      address1: '123 Main St',
                      city: 'New York',
                      province: 'NY',
                      country: 'United States',
                      zip: '10001'
                    },
                    staffMemberAssignments: {
                      edges: []
                    }
                  }
                }
              ]
            }
          }
        }
      ],
      pageInfo: {
        hasNextPage: false,
        endCursor: null
      }
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/staff', async (req, res) => {
  try {
    // TODO: Replace with real Shopify API calls when credentials are available
    res.json({
      edges: [
        {
          node: {
            id: 'gid://shopify/StaffMember/1',
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
            active: true,
            isShopOwner: false
          }
        }
      ],
      pageInfo: {
        hasNextPage: false,
        endCursor: null
      }
    });
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

    // TODO: Replace with real Shopify API calls when credentials are available
    console.log('Assigning staff:', { staffId, companyLocationId });
    
    res.json({ 
      success: true, 
      message: 'Staff assigned successfully!',
      assignment: {
        id: 'gid://shopify/CompanyLocationStaffMemberAssignment/1',
        staffMember: { id: staffId },
        companyLocation: { id: companyLocationId }
      }
    });
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

    // TODO: Replace with real Shopify API calls when credentials are available
    console.log('Removing assignment:', { assignmentId });
    
    res.json({ 
      success: true, 
      message: 'Staff removed successfully!',
      deletedIds: [assignmentId]
    });
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

    // TODO: Replace with real Shopify API calls when credentials are available
    console.log('Bulk assigning staff:', { staffId, locationCriteria });
    
    res.json({
      success: true,
      message: 'Bulk assignment completed!',
      assigned: 1,
      total: 1,
      errors: []
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

    // TODO: Replace with real Shopify API calls when credentials are available
    console.log('Filtering companies by location:', locationCriteria);
    
    res.json({
      locations: [
        {
          id: 'gid://shopify/CompanyLocation/1',
          name: 'Main Office',
          companyName: 'Test Company',
          shippingAddress: {
            address1: '123 Main St',
            city: 'New York',
            province: 'NY',
            country: 'United States',
            zip: '10001'
          }
        }
      ],
      total: 1,
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Export for Vercel
module.exports = app;
