const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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

// Mock API routes for testing
app.get('/api/companies', (req, res) => {
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
});

app.get('/api/staff', (req, res) => {
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
});

app.post('/api/assign', (req, res) => {
  res.json({ success: true, message: 'Staff assigned successfully!' });
});

app.delete('/api/assign', (req, res) => {
  res.json({ success: true, message: 'Staff removed successfully!' });
});

app.post('/api/bulk-assign', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Bulk assignment completed!',
    assigned: 1,
    total: 1
  });
});

app.post('/api/companies-by-location', (req, res) => {
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
    criteria: req.body.locationCriteria
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 App URL: http://localhost:${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
});
