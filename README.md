# Shopify Staff Assignment App

A complete Shopify app for managing staff assignments to company locations.

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

# Database configuration
DATABASE_URL=./database.sqlite

# Session secret
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
- `GET /api/companies` - List companies
- `GET /api/staff` - List staff
- `POST /api/assign` - Assign staff to company
- `DELETE /api/assign` - Remove staff from company

## 🔧 Configuration

### Required App Scopes

Your Shopify app needs these scopes:
- `read_companies`
- `write_companies`
- `read_customers`
- `write_customers`

### App Settings

Configure these in your Partner Dashboard:
- **App URL**: Your app's main URL
- **Allowed redirection URLs**: `{APP_URL}/auth/callback`
- **Webhook endpoints**: Configure as needed

## 📦 Deployment

### Deploy to Production

1. **Set up production environment**:
   ```bash
   # Set production environment variables
   export NODE_ENV=production
   export SHOPIFY_API_KEY=your_production_api_key
   export SHOPIFY_API_SECRET=your_production_api_secret
   export SHOPIFY_APP_URL=https://your-production-domain.com
   ```

2. **Deploy your app**:
   ```bash
   npm run deploy
   ```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SHOPIFY_API_KEY` | Your app's API key | Yes |
| `SHOPIFY_API_SECRET` | Your app's API secret | Yes |
| `SHOPIFY_APP_URL` | Your app's URL | Yes |
| `DATABASE_URL` | Database connection string | Yes |
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