'use strict';

/**
 * Hostname only (no protocol, no path) for @shopify/shopify-api / shopify-app-express.
 *
 * Shopify's deployment guide lists SHOPIFY_APP_URL as required for hosted apps and says
 * shopify.app.toml application_url should match it.
 * @see https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service
 *
 * Embedded app examples set process.env.HOST to the app origin (https://...) so hostName
 * / hostScheme align with @shopify/shopify-app-express defaults.
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/set-embedded-app-authorization
 */

function stripHostname(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  return s.replace(/^https?:\/\//i, '').split('/')[0].trim();
}

/**
 * Normalizes SHOPIFY_APP_URL into HOST (full origin, https), which the Shopify libraries
 * read when merging API config.
 */
function applyShopifyDeploymentEnv() {
  const raw = process.env.SHOPIFY_APP_URL;
  if (raw == null || !String(raw).trim()) return;
  let origin = String(raw).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(origin)) {
    origin = `https://${origin}`;
  }
  process.env.HOST = origin;
}

const ENV_KEYS_IN_ORDER = [
  'SHOPIFY_APP_URL',
  'SHOPIFY_HOSTNAME',
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

module.exports = {
  applyShopifyDeploymentEnv,
  resolveShopifyHostName,
  stripHostname,
};
