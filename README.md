# Shopify B2B Map Sync App

A specialized Shopify application deployed on Vercel that automatically synchronizes B2B company locations to a Store Locator Map. It fetches company addresses, geocodes them via Mapbox, and creates/updates `b2b_map_location` metaobjects in your Shopify store.

## 🚀 Key Features

- **Automated Geocoding**: Converts B2B company addresses into precise coordinates (latitude/longitude) using Mapbox API.
- **Metaobject Sync**: Automatically creates and updates `b2b_map_location` metaobjects used by Shopify Storefronts for locator maps.
- **Interactive Dashboard**: A clean, intuitive admin interface to view all synced locations on an interactive map.
- **Manual Trigger**: Instantly trigger a sync process directly from the app dashboard.
- **Scheduled Sync**: Supports automated daily syncs via cron.

## 🛠️ Setup & Configuration

For full setup instructions including Shopify app configuration, metaobject definitions, and environment variables, please refer to the primary guide:

👉 **[B2B Map Sync Documentation](./B2B_MAP_SYNC.md)**

### Quick Start (Local Development)

1. **Install Dependencies**
   ```
   npm install
   ```

2. **Configure Environment**
   Create a `.env` file based on `.env.example`. You will need:
   - `SHOPIFY_SHOP_DOMAIN`
   - `SHOPIFY_CLIENT_ID` & `SHOPIFY_CLIENT_SECRET` (or `SHOPIFY_ADMIN_ACCESS_TOKEN` for legacy custom apps)
   - `MAPBOX_ACCESS_TOKEN`
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` (for the Express App framework)

3. **Start Development Server**
   ```
   npm run dev &
   ```

## 📱 App Dashboard

The app provides an embedded dashboard in the Shopify Admin that displays:
1. **Summary Statistics**: Total locations, synced coordinates, and missing coordinates.
2. **Location Directory**: A searchable list of all B2B locations fetched from Shopify.
3. **Interactive Map**: A Mapbox-powered visualization of all successfully geocoded locations.

## 📦 Deployment to Vercel

This app is configured for seamless deployment to Vercel as a Serverless function.

See the detailed guide: **[VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md)**

## 🛡️ Security & Architecture

- **Session Management**: Uses standard Shopify OAuth and session tokens via `@shopify/shopify-app-express`.
- **Database**: SQLite is used locally for session storage. For production on Vercel, it is recommended to switch to Redis or another durable store.
- **Background Jobs**: The `runSync` logic in `lib/sync-b2b-map.js` handles API pagination and rate-limiting gracefully.

## 📞 Support

If you encounter issues:
1. Ensure the `b2b_map_location` metaobject definition exists in your Shopify Admin.
2. Verify your `MAPBOX_ACCESS_TOKEN` has the necessary geocoding scopes.
3. Check the Vercel logs or local console for specific API errors.
