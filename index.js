// Main API handler - moved to root for Vercel compatibility
export default async function handler(req, res) {
  try {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    // Log the request for debugging
    console.log('Request received:', {
      method: req.method,
      url: req.url,
      headers: req.headers,
      timestamp: new Date().toISOString()
    });

    // Handle different routes
    if (req.url === '/api/test' || req.url === '/api/') {
      return res.status(200).json({
        message: '✅ API is working!',
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        env: {
          hasApiKey: !!process.env.SHOPIFY_API_KEY,
          hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
          hasAppUrl: !!process.env.SHOPIFY_APP_URL,
          appUrl: process.env.SHOPIFY_APP_URL
        }
      });
    }

    if (req.url === '/api/health') {
      return res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'Health check passed',
        environment: process.env.NODE_ENV || 'development'
      });
    }

    // Default response for any other path
    return res.status(200).json({
      message: '🚀 Shopify Staff Assignment App API is running! (Redeployed)',
      timestamp: new Date().toISOString(),
      method: req.method,
      url: req.url,
      availableEndpoints: [
        '/api/test',
        '/api/health',
        '/api/'
      ]
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
