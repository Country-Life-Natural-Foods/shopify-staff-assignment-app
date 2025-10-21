# 🚀 Production Deployment Guide

This guide will help you deploy your Shopify Staff Assignment App to production for your internal store use.

## 📋 Prerequisites

1. **Shopify Partner Account** (if you don't have one)
2. **GitHub Account** (for code hosting)
3. **Railway Account** (free deployment platform)

## 🏭 Deployment Options

### Option 1: Railway (Recommended)

**Why Railway?**
- ✅ **Free tier** with generous limits
- ✅ **Automatic deployments** from GitHub
- ✅ **Custom domain** support
- ✅ **Environment variables** management
- ✅ **Perfect for private apps**
- ✅ **No credit card required**

#### Step 1: Prepare Your Code

1. **Update package.json** for production:
   ```bash
   cp package-production.json package.json
   ```

2. **Use production server**:
   ```bash
   cp server-production.js server.js
   ```

#### Step 2: Deploy to Railway

1. **Install Railway CLI** (already done):
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**:
   ```bash
   railway login
   ```

3. **Initialize Railway project**:
   ```bash
   railway init
   ```

4. **Deploy**:
   ```bash
   railway up
   ```

5. **Get your app URL**:
   ```bash
   railway domain
   ```

#### Step 3: Configure Environment Variables

In Railway dashboard, add these environment variables:

```
SHOPIFY_API_KEY=your_actual_api_key_here
SHOPIFY_API_SECRET=your_actual_api_secret_here
SHOPIFY_APP_URL=https://your-app-name.railway.app
SHOPIFY_SCOPES=read_companies,write_companies
SESSION_SECRET=generate_a_strong_random_secret_here
NODE_ENV=production
PORT=3000
```

### Option 2: Render

**Why Render?**
- ✅ **Free tier** available
- ✅ **Easy setup**
- ✅ **Good for Node.js apps**

#### Steps:

1. **Connect GitHub** to Render
2. **Create new Web Service**
3. **Select your repository**
4. **Configure**:
   - Build Command: `npm install`
   - Start Command: `node server-production.js`
   - Environment: `Node`
5. **Add environment variables** (same as Railway)
6. **Deploy**

### Option 3: Heroku

**Why Heroku?**
- ✅ **Reliable** platform
- ✅ **Easy deployment**
- ⚠️ **Has costs** ($7/month minimum)

#### Steps:

1. **Install Heroku CLI**
2. **Create Heroku app**:
   ```bash
   heroku create your-app-name
   ```
3. **Set environment variables**:
   ```bash
   heroku config:set SHOPIFY_API_KEY=your_key
   heroku config:set SHOPIFY_API_SECRET=your_secret
   # ... etc
   ```
4. **Deploy**:
   ```bash
   git push heroku main
   ```

## 🔧 Shopify App Configuration

### Step 1: Create Shopify App

1. **Go to Shopify Partner Dashboard**
2. **Create new app**:
   - App name: "Staff Assignment Manager"
   - App URL: `https://your-app-domain.railway.app`
   - Allowed redirection URL: `https://your-app-domain.railway.app/auth/callback`

### Step 2: Configure App Scopes

**Required scopes:**
- `read_companies`
- `write_companies`

**Remove these scopes** (they're not needed):
- ~~`read_customers`~~
- ~~`write_customers`~~
- ~~`read_users`~~

### Step 3: Install App

1. **Get your app URL** from Railway/Render/Heroku
2. **Update Partner Dashboard** with the correct URL
3. **Install app** on your store
4. **Test all functionality**

## 🧪 Testing Your Production App

### 1. **Test Basic Functionality**
- ✅ App loads correctly
- ✅ Companies list loads
- ✅ Staff list loads
- ✅ Assignment forms work
- ✅ Bulk assignment works

### 2. **Test with Real Data**
- ✅ Connect to real Shopify API
- ✅ Test with actual companies
- ✅ Test with real staff members
- ✅ Verify assignments work

### 3. **Employee Access**
- ✅ Share app URL with employees
- ✅ Test from different devices
- ✅ Verify permissions work correctly

## 🔒 Security Considerations

### 1. **Environment Variables**
- ✅ Never commit API keys to code
- ✅ Use strong session secrets
- ✅ Rotate secrets regularly

### 2. **App Permissions**
- ✅ Only request necessary scopes
- ✅ Review permissions regularly
- ✅ Monitor app usage

### 3. **Access Control**
- ✅ Limit app access to authorized employees
- ✅ Monitor who installs the app
- ✅ Regular security reviews

## 📊 Monitoring & Maintenance

### 1. **Health Checks**
- ✅ Monitor app uptime
- ✅ Check error logs regularly
- ✅ Monitor API usage

### 2. **Updates**
- ✅ Keep dependencies updated
- ✅ Monitor Shopify API changes
- ✅ Regular security updates

### 3. **Backup**
- ✅ Regular database backups (if using database)
- ✅ Code repository backups
- ✅ Environment variable backups

## 🆘 Troubleshooting

### Common Issues:

1. **App won't load**
   - Check environment variables
   - Verify app URL in Partner Dashboard
   - Check server logs

2. **API errors**
   - Verify API credentials
   - Check scopes are correct
   - Monitor API rate limits

3. **Deployment issues**
   - Check build logs
   - Verify all dependencies installed
   - Check environment variables

## 📞 Support

If you need help:
1. **Check Railway/Render/Heroku logs**
2. **Review Shopify Partner Dashboard**
3. **Test with mock data first**
4. **Contact platform support if needed**

---

## 🎉 You're Ready!

Once deployed, your employees can:
- ✅ Access the app from anywhere
- ✅ Manage staff assignments
- ✅ Use bulk assignment features
- ✅ Filter by location criteria

**Your private Shopify app is now production-ready!** 🚀
