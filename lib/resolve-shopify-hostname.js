'use strict';

/**
 * Hostname only (no protocol, no path) for @shopify/shopify-api / shopify-app-express.
 * Vercel often provides VERCEL_URL; some dashboards set SHOPIFY_APP_URL as a full URL.
 * Empty strings after stripping must be treated as missing — otherwise Shopify init fails.
 */

function stripHostname(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  return s.replace(/^https?:\/\//i, '').split('/')[0].trim();
}

const ENV_KEYS_IN_ORDER = [
  'SHOPIFY_HOSTNAME',
  'SHOPIFY_APP_URL',
  'HOST',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',
];

function resolveShopifyHostName() {
  for (const key of ENV_KEYS_IN_ORDER) {
    const h = stripHostname(process.env[key]);
    if (h) return h;
  }
  if (process.env.NODE_ENV !== 'production') {
    return 'localhost';
  }
  return '';
}

module.exports = { resolveShopifyHostName, stripHostname };
