# Shopify Staff Assignment App - Setup Guide

## 🚀 Complete Setup Instructions

### Step 1: Create Shopify Partner Account & App

1. **Go to Shopify Partners Dashboard**
   - Visit: https://partners.shopify.com/
   - Sign up or log in to your Partner account

2. **Create a New App**
   - Click "Apps" in the left sidebar
   - Click "Create app"
   - Choose "Public app" or "Custom app" (Custom app for internal use)
   - Fill in app details:
     - **App name**: "Staff Assignment Manager"
     - **App URL**: `https://your-app-url.ngrok.io` (we'll set this up)
     - **Allowed redirection URLs**: `https://your-app-url.ngrok.io/auth/callback`

3. **Configure App Scopes**
   - In your app settings, go to "Configuration"
   - Under "Admin API access scopes", enable:
     - `read_companies`
     - `write_companies`
     - `read_customers`
     - `write_customers`

### Step 2: Local Development Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Install ngrok for local tunneling**
   ```bash
   npm install -g ngrok
   ```

3. **Start ngrok**
   ```bash
   ngrok http 3000
   ```
   - Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

4. **Configure Environment**
   - Copy `env.example` to `.env`
   - Fill in your app credentials:
   ```env
   SHOPIFY_API_KEY=your_api_key_from_partner_dashboard
   SHOPIFY_API_SECRET=your_api_secret_from_partner_dashboard
   SHOPIFY_APP_URL=https://your-ngrok-url.ngrok.io
   SESSION_SECRET=generate_a_random_string_here
   ```

5. **Update App Settings**
   - Go back to your Partner Dashboard
   - Update your app's "App URL" to your ngrok URL
   - Update "Allowed redirection URLs" to `https://your-ngrok-url.ngrok.io/auth/callback`

### Step 3: Run the App

1. **Start the development server**
   ```bash
   npm run dev
   ```

2. **Install the app in your store**
   - Go to your Partner Dashboard
   - Click "Test on development store" or "Install app"
   - Select your development store
   - Authorize the app

3. **Access the app**
   - The app will redirect you to your store's admin
   - Look for "Staff Assignment Manager" in your app list
   - Click on it to open the app

### Step 4: Using the App

The app provides a web interface with four main sections:

1. **Overview**: Dashboard with statistics
2. **Companies**: View all company locations
3. **Staff**: View all staff members and their assignments
4. **Assignments**: Assign or remove staff from companies

### 🔧 Troubleshooting

#### Common Issues:

1. **"App not found" error**
   - Check that your ngrok URL is correct
   - Ensure your app URL in Partner Dashboard matches ngrok URL
   - Restart ngrok if the URL changed

2. **"Invalid redirect URI" error**
   - Verify the callback URL in Partner Dashboard
   - Make sure it's exactly: `https://your-ngrok-url.ngrok.io/auth/callback`

3. **"Permission denied" error**
   - Check that all required scopes are enabled
   - Reinstall the app in your store

4. **"Session not found" error**
   - Clear your browser cookies
   - Reinstall the app

#### Debug Mode:

Enable debug logging by setting `DEBUG=true` in your `.env` file.

### 📱 App Features

- **Real-time Data**: Live data from Shopify Admin API
- **Interactive Interface**: Easy-to-use web interface
- **Staff Management**: View and manage all staff members
- **Company Management**: View and manage company locations
- **Assignment Management**: Assign/remove staff from companies
- **Statistics Dashboard**: Overview of your data

### 🚀 Production Deployment

When ready for production:

1. **Deploy to a hosting service** (Heroku, Railway, etc.)
2. **Update your app URL** in Partner Dashboard
3. **Set production environment variables**
4. **Submit for app review** (if public app)

### 📞 Support

If you encounter issues:
1. Check the troubleshooting section above
2. Verify your app configuration in Partner Dashboard
3. Check the browser console for errors
4. Review the server logs

---

## 🎯 Quick Start Checklist

- [ ] Created Shopify Partner account
- [ ] Created app in Partner Dashboard
- [ ] Configured app scopes (companies, customers)
- [ ] Installed dependencies (`npm install`)
- [ ] Set up ngrok (`ngrok http 3000`)
- [ ] Created `.env` file with credentials
- [ ] Updated app URL in Partner Dashboard
- [ ] Started development server (`npm run dev`)
- [ ] Installed app in development store
- [ ] Opened app in Shopify admin

Once all items are checked, you're ready to use the Staff Assignment Manager!
