// Minimal test for Vercel deployment
module.exports = (req, res) => {
  res.json({
    status: 'ok',
    message: 'Vercel deployment working!',
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: Object.keys(req.headers),
    env: {
      nodeEnv: process.env.NODE_ENV,
      hasApiKey: !!process.env.SHOPIFY_API_KEY,
      hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
      hasAppUrl: !!process.env.SHOPIFY_APP_URL,
      hasSessionSecret: !!process.env.SESSION_SECRET
    }
  });
};