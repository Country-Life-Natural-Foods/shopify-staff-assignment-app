# 🚀 Vercel Deployment Guide

This guide will help you deploy your Shopify Staff Assignment App to Vercel for production use.

## 📋 Prerequisites

1. **GitHub Account** (for code hosting)
2. **Vercel Account** (free at vercel.com)
3. **Shopify Partner Account** (for app configuration)

## 🏭 Why Vercel?

- ✅ **Completely FREE** for personal projects
- ✅ **Automatic deployments** from GitHub
- ✅ **Custom domains** included
- ✅ **Perfect for Node.js** apps
- ✅ **No credit card required**
- ✅ **Better performance** than Heroku
- ✅ **Global CDN** included
- ✅ **Easy environment variables** management

## 🚀 Step-by-Step Deployment

### Step 1: Prepare Your Code

1. **Ensure your code is ready**:
   ```bash
   # Install dependencies
   npm install
   
   # Test locally
   npm run dev
   ```

### Step 2: Push to GitHub

1. **Initialize git** (if not already done):
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```

2. **Create GitHub repository**:
   - Go to github.com
   - Create new repository: `shopify-staff-assignment-app`
   - Don't initialize with README (you already have files)

3. **Push your code**:
   ```bash
   git remote add origin https://github.com/yourusername/shopify-staff-assignment-app.git
   git branch -M main
   git push -u origin main
   ```

### Step 3: Deploy to Vercel

1. **Go to Vercel**:
   - Visit [vercel.com](https://vercel.com)
   - Sign up with GitHub

2. **Import Project**:
   - Click "New Project"
   - Import your GitHub repository
   - Vercel will auto-detect it's a Node.js app

3. **Configure Project**:
   - **Framework Preset**: Other
   - **Root Directory**: `./`
   - **Build Command**: `npm install`
   - **Output Directory**: Leave empty
   - **Install Command**: `npm install`
   - **Development Command**: `npm run dev`

4. **Add shared session storage (required for embedded admin on Vercel)** — pick **one** free option:
   - **Option A — Upstash Redis:** Storage → **Upstash Redis** → connect → `REDIS_URL` is injected
   - **Option B — Postgres (no Redis):** Storage → **Neon** (or Supabase) → connect → `DATABASE_URL` / `POSTGRES_URL` is injected
   - Without either, OAuth completes on one serverless instance but the next request hits another with no session → infinite reload and Shopify’s “browser cookies” error

5. **Add Environment Variables**:
   ```
   SHOPIFY_API_KEY=your_actual_api_key_here
   SHOPIFY_API_SECRET=your_actual_api_secret_here
   SHOPIFY_APP_URL=https://your-app-name.vercel.app
   SHOPIFY_SCOPES=read_companies,write_companies
   SESSION_SECRET=generate_a_strong_random_secret_here
   REDIS_URL=redis://...        # Option A: from Upstash
   # DATABASE_URL=postgresql://...  # Option B: from Neon (use this OR Redis, not neither)
   NODE_ENV=production
   PORT=3000
   ```

6. **Deploy**:
   - Click "Deploy"
   - Wait for deployment to complete
   - Get your app URL: `https://your-app-name.vercel.app`

### Step 4: Configure Shopify App

1. **Go to Shopify Partner Dashboard**
2. **Create new app**:
   - App name: "Staff Assignment Manager"
   - App URL: `https://your-app-name.vercel.app`
   - Allowed redirection URL: `https://your-app-name.vercel.app/auth/callback`

3. **Set App Scopes**:
   - ✅ `read_companies`
   - ✅ `write_companies`
   - ❌ Remove: `read_customers`, `write_customers`, `read_users`

4. **Install App**:
   - Install on your store
   - Test all functionality

## 🔧 Environment Variables Setup

In Vercel dashboard, go to your project → Settings → Environment Variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `SHOPIFY_API_KEY` | `your_api_key` | From Partner Dashboard |
| `SHOPIFY_API_SECRET` | `your_api_secret` | From Partner Dashboard |
| `SHOPIFY_APP_URL` | `https://your-app.vercel.app` | Your Vercel URL |
| `SHOPIFY_SCOPES` | `read_companies,write_companies` | Required scopes |
| `SESSION_SECRET` | `random_string` | Strong random secret |
| `REDIS_URL` | `redis://…` | **Option A** — sessions (Upstash; free tier) |
| `DATABASE_URL` | `postgresql://…` | **Option B** — sessions (Neon/Supabase; free tier) |
| `NODE_ENV` | `production` | Environment |
| `PORT` | `3000` | Port (Vercel handles this) |

## 🧪 Testing Your Production App

### 1. **Test Basic Functionality**
- ✅ App loads at `https://your-app.vercel.app`
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

## 🔄 Automatic Deployments

Once set up, Vercel will automatically:
- ✅ **Deploy** when you push to GitHub
- ✅ **Run tests** (if configured)
- ✅ **Update** your live app
- ✅ **Send notifications** on success/failure

## 🔒 Security Best Practices

### 1. **Environment Variables**
- ✅ Never commit API keys to GitHub
- ✅ Use Vercel's environment variables
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

### 1. **Vercel Dashboard**
- ✅ Monitor deployments
- ✅ Check function logs
- ✅ Monitor performance
- ✅ Track usage

### 2. **Updates**
- ✅ Keep dependencies updated
- ✅ Monitor Shopify API changes
- ✅ Regular security updates

### 3. **Backup**
- ✅ GitHub repository is your backup
- ✅ Environment variables in Vercel
- ✅ Regular code reviews

## 🆘 Troubleshooting

### Common Issues:

1. **App won't load**
   - Check Vercel function logs
   - Verify environment variables
   - Check app URL in Partner Dashboard

2. **API errors**
   - Verify API credentials in Vercel
   - Check scopes are correct
   - Monitor API rate limits

3. **Deployment issues**
   - Check Vercel build logs
   - Verify all dependencies in package.json
   - Check vercel.json configuration

## 💰 Cost Breakdown

**Vercel Free Tier includes:**
- ✅ **100GB bandwidth** per month
- ✅ **100GB-hours** of serverless function execution
- ✅ **Unlimited** static deployments
- ✅ **Custom domains**
- ✅ **Automatic HTTPS**

**For your use case:** This is more than enough for a private app!

## 🎉 You're Ready!

Once deployed, your employees can:
- ✅ Access the app from anywhere: `https://your-app.vercel.app`
- ✅ Manage staff assignments
- ✅ Use bulk assignment features
- ✅ Filter by location criteria
- ✅ Automatic updates when you push code

**Your private Shopify app is now production-ready on Vercel!** 🚀

---

## 📞 Next Steps

1. **Push code to GitHub**
2. **Deploy to Vercel**
3. **Configure Shopify app**
4. **Test with real data**
5. **Share with employees**

Need help with any step? Let me know!
