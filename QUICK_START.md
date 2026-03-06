# Staff Assignment Manager - Quick Start

## 🚀 Get Started in 5 Minutes

### 1. Create Shopify App
1. Go to [Shopify Partners](https://partners.shopify.com/)
2. Create a new app
3. Set app URL to: `https://your-ngrok-url.ngrok.io`
4. Enable scopes: `read_companies`, `write_companies`, `read_customers`, `write_customers`

### 2. Install & Run
```bash
# Install dependencies
npm install

# Install ngrok globally
npm install -g ngrok

# Start ngrok (in separate terminal)
ngrok http 3000

# Copy the HTTPS URL from ngrok output
```

### 3. Configure Environment
```bash
# Copy example file
cp env.example .env

# Edit .env with your credentials:
SHOPIFY_API_KEY=your_api_key_here
SHOPIFY_API_SECRET=your_api_secret_here
SHOPIFY_APP_URL=https://your-ngrok-url.ngrok.io
SESSION_SECRET=random_string_here
```

### 4. Start App
```bash
npm run dev
```

### 5. Install in Store
1. Go to Partner Dashboard
2. Click "Test on development store"
3. Authorize the app
4. Open the app from your store's app list

## ✅ You're Ready!

The app provides a web interface to:
- View all companies and staff
- Assign staff to company locations
- Remove staff from companies
- See real-time statistics

## 🔧 Need Help?

Check `SETUP_GUIDE.md` for detailed instructions and troubleshooting.