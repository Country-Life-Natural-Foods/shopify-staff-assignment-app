# Shopify Staff Assignment App

A complete Shopify app for managing staff assignments to company locations, deployed on Vercel.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file with your app credentials:

```env
# Your app's API key and secret from Partner Dashboard
SHOPIFY_API_KEY=your_api_key_here
SHOPIFY_API_SECRET=your_api_secret_here

# Your app's URL (use ngrok for local development)
SHOPIFY_APP_URL=https://your-app-url.ngrok.io

# Session secret (generate a random string)
SESSION_SECRET=your_session_secret_here
```

### 3. Start Development Server
```bash
npm run dev
```

### 4. Install App in Shopify Store
1. Go to your Partner Dashboard
2. Create a new app or use existing one
3. Set the app URL to your ngrok URL
4. Install the app in your development store

## 📱 App Features

- **Staff Management**: View and manage all staff members
- **Company Management**: View and manage company locations
- **Assignment Management**: Assign/remove staff from companies
- **Interactive Interface**: User-friendly web interface
- **Real-time Updates**: Live data from Shopify Admin API

## 🛠️ Development

### Local Development Setup

1. **Install ngrok** for local tunneling:
   ```bash
   npm install -g ngrok
   ```

2. **Start ngrok**:
   ```bash
   ngrok http 3000
   ```

3. **Update your app URL** in Partner Dashboard to the ngrok URL

4. **Start the app**:
   ```bash
   npm run dev
   ```

### API Endpoints

- `GET /` - App home page
- `GET /auth` - OAuth authentication
- `GET /auth/callback` - OAuth callback
- `GET /api/companies` - List companies with locations and staff assignments
- `GET /api/staff` - List staff members
- `POST /api/assign` - Assign staff to company location
- `DELETE /api/assign` - Remove staff from company location
- `POST /api/bulk-assign` - Bulk assign staff to company locations by location criteria
- `POST /api/companies-by-location` - Filter company locations by location criteria

## 🔧 Configuration

### Required App Scopes

Your Shopify app needs these scopes:
- `read_companies`
- `write_companies`

### App Settings

Configure these in your Partner Dashboard:
- **App URL**: Your app's main URL
- **Allowed redirection URLs**: `{APP_URL}/auth/callback`
- **Webhook endpoints**: Configure as needed

## 📦 Deployment to Vercel

### Deploy to Production

1. **Push your code to GitHub**

2. **Connect to Vercel**:
   - Go to [vercel.com](https://vercel.com)
   - Import your GitHub repository
   - Vercel will auto-detect it's a Node.js app

3. **Configure Environment Variables** in Vercel dashboard:
   ```
   SHOPIFY_API_KEY=your_production_api_key
   SHOPIFY_API_SECRET=your_production_api_secret
   SHOPIFY_APP_URL=https://your-app-name.vercel.app
   SESSION_SECRET=your_strong_session_secret
   NODE_ENV=production
   ```

4. **Deploy**:
   ```bash
   npm run deploy
   ```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SHOPIFY_API_KEY` | Your app's API key | Yes |
| `SHOPIFY_API_SECRET` | Your app's API secret | Yes |
| `SHOPIFY_APP_URL` | Your app's URL | Yes |
| `SESSION_SECRET` | Session encryption secret | Yes |

## 🛡️ Security

- OAuth 2.0 authentication with Shopify
- Secure session management
- CSRF protection
- Input validation and sanitization
- Rate limiting for API requests

## 📞 Support

For issues or questions:
1. Check the troubleshooting section
2. Review Shopify app development documentation
3. Check your app's logs for errors

## 📚 Additional Documentation

- [VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md) - Detailed Vercel deployment guide
- [SETUP_GUIDE.md](./SETUP_GUIDE.md) - Complete setup instructions
- [QUICK_START.md](./QUICK_START.md) - 5-minute quick start guide