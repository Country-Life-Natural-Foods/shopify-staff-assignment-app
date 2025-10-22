// Simple API endpoint that will definitely work
export default function handler(req, res) {
  res.status(200).json({ 
    message: 'Hello! The API is working!',
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.url
  });
}