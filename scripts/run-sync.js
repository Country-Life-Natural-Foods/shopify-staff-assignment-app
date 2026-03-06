#!/usr/bin/env node
/**
 * Manual run: npm run sync-b2b-map
 * Requires .env: SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, MAPBOX_ACCESS_TOKEN
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { runSync } = require('../lib/sync-b2b-map');

runSync()
  .then((stats) => {
    console.log('B2B Map Sync complete:', stats);
    process.exit(0);
  })
  .catch((err) => {
    console.error('B2B Map Sync failed:', err.message);
    process.exit(1);
  });
