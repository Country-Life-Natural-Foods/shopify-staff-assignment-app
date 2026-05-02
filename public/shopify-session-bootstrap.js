/**
 * Embedded admin: attach Shopify session token to fetch() so api/index.js
 * validateAuthenticatedSession accepts Bearer JWT (see @shopify/shopify-app-express).
 */
window.shopifyApiFetch = window.fetch.bind(window);

(async function setupShopifyFetch() {
  try {
    const [{ default: createApp }, utils] = await Promise.all([
      import('https://esm.sh/@shopify/app-bridge@3.7.9'),
      import('https://esm.sh/@shopify/app-bridge-utils@3.5.1'),
    ]);
    const getSessionToken = utils.getSessionToken || utils.default?.getSessionToken;
    if (typeof getSessionToken !== 'function') {
      throw new Error('getSessionToken export missing from @shopify/app-bridge-utils');
    }
    const apiKey = document.querySelector('meta[name="shopify-api-key"]')?.content;
    const params = new URLSearchParams(window.location.search);
    const host = params.get('host');

    window.shopifyApiFetch = async function shopifyApiFetch(input, init = {}) {
      const headers = new Headers(init.headers || {});
      if (apiKey && host) {
        try {
          const app = createApp({ apiKey, host });
          const token = await getSessionToken(app);
          headers.set('Authorization', `Bearer ${token}`);
        } catch (err) {
          console.warn('[shopify] getSessionToken failed', err);
        }
      }
      return fetch(input, { ...init, headers, credentials: init.credentials ?? 'same-origin' });
    };
  } catch (err) {
    console.warn('[shopify] App Bridge utilities unavailable; using plain fetch', err);
  }
  window.dispatchEvent(new Event('shopify:api-fetch-ready'));
})();
