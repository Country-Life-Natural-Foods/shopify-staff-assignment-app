/**
 * B2B Map Sync
 * Fetches B2B companies from Shopify, geocodes addresses via Mapbox,
 * and creates/updates b2b_map_location metaobjects.
 *
 * Auth (any one):
 * (A) Embedded session: pass { shop, accessToken } from validateAuthenticatedSession
 * (B) Dev Dashboard: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_API_KEY/SECRET)
 * (C) Legacy custom app: SHOPIFY_ADMIN_ACCESS_TOKEN
 *
 * Also required: MAPBOX_ACCESS_TOKEN
 * Shop: options.shop, or SHOPIFY_SHOP_DOMAIN for cron/CLI
 * Scopes: read_companies, read_metaobjects, write_metaobjects
 */

const SHOPIFY_API_VERSION = '2024-10';

/**
 * Get Admin API access token via client credentials grant (Dev Dashboard apps).
 * Token expires in 24 hours.
 */
async function getAccessToken(shop, clientId, clientSecret) {
  const url = `https://${shop}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('No access_token in response: ' + JSON.stringify(json));
  }
  return json.access_token;
}

async function shopifyGraphQL(shop, token, query, variables = {}) {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error('GraphQL errors: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

async function geocodeAddress(mapboxToken, address) {
  const parts = [
    address.address1,
    address.city,
    address.province,
    address.zip,
    address.country,
  ].filter(Boolean);
  const q = parts.join(', ');
  if (!q.trim()) return null;

  const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&access_token=${mapboxToken}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    console.warn('Mapbox geocode failed:', res.status, errText?.slice(0, 150));
    return null;
  }
  const json = await res.json();
  const feat = json.features?.[0];
  if (!feat?.geometry?.coordinates) {
    console.warn('Mapbox no result for:', q?.slice(0, 60));
    return null;
  }
  const [lng, lat] = feat.geometry.coordinates;
  return { lat, lng };
}

async function fetchCompanies(shop, token) {
  const query = `
    query getCompanies($first: Int!, $after: String) {
      companies(first: $first, after: $after) {
        edges {
          node {
            id
            name
            locations(first: 50) {
              edges {
                node {
                  id
                  name
                  phone
                  shippingAddress {
                    address1
                    city
                    province
                    zip
                    country
                  }
                  billingAddress {
                    address1
                    city
                    province
                    zip
                    country
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const all = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphQL(shop, token, query, {
      first: 50,
      after: cursor,
    });
    const companies = data.companies;
    for (const edge of companies.edges) {
      all.push(edge.node);
    }
    hasNext = companies.pageInfo.hasNextPage;
    cursor = companies.pageInfo.endCursor;
  }
  return all;
}

async function fetchExistingMetaobjects(shop, token) {
  const query = `
    query getMetaobjects($first: Int!, $after: String) {
      metaobjects(type: "b2b_map_location", first: $first, after: $after) {
        edges {
          node {
            id
            handle
            fields {
              key
              value
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const all = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphQL(shop, token, query, {
      first: 100,
      after: cursor,
    });
    const metaobjects = data.metaobjects;
    for (const edge of metaobjects.edges) {
      all.push(edge.node);
    }
    hasNext = metaobjects.pageInfo.hasNextPage;
    cursor = metaobjects.pageInfo.endCursor;
  }
  return all;
}

function metaobjectFieldsToMap(node) {
  const map = {};
  for (const f of node.fields || []) {
    map[f.key] = f.value;
  }
  return map;
}

async function upsertMetaobject(shop, token, handle, fields) {
  const mutation = `
    mutation metaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `;
  const fieldInputs = Object.entries(fields)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([key, value]) => ({ key, value: String(value) }));

  const data = await shopifyGraphQL(shop, token, mutation, {
    handle: { type: 'b2b_map_location', handle },
    metaobject: {
      fields: fieldInputs,
    },
  });

  const result = data.metaobjectUpsert;
  if (result.userErrors?.length) {
    throw new Error('Metaobject upsert: ' + JSON.stringify(result.userErrors));
  }
  return result.metaobject;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeShopDomain(shop) {
  if (!shop || typeof shop !== 'string') return '';
  return shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
}

/**
 * Run the full sync.
 * @param {{ shop?: string, accessToken?: string }} [options]
 *   When triggered from an authenticated embedded session, pass shop + accessToken
 *   so SHOPIFY_SHOP_DOMAIN / client-credentials env vars are not required.
 * @returns {{ created: number, updated: number, skipped: number, errors: string[] }}
 */
async function runSync(options = {}) {
  const shop = normalizeShopDomain(options.shop || process.env.SHOPIFY_SHOP_DOMAIN);
  const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_PUBLIC_TOKEN;

  if (!shop) {
    throw new Error(
      'Missing shop domain. Open the app from Shopify Admin, or set SHOPIFY_SHOP_DOMAIN (e.g. your-store.myshopify.com).'
    );
  }
  if (!mapboxToken) {
    throw new Error(
      'Missing MAPBOX_ACCESS_TOKEN (or MAPBOX_PUBLIC_TOKEN) for geocoding. Add it in Vercel → Project → Settings → Environment Variables.'
    );
  }

  // Prefer session token (UI), then static Admin token, then client credentials.
  let token = options.accessToken || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!token) {
    const clientId = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing auth: open the app from Shopify Admin (session token), or set SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET'
      );
    }
    console.log('Fetching access token...');
    token = await getAccessToken(shop, clientId, clientSecret);
    console.log('Token obtained.');
  }

  const stats = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    incomplete: false,
  };

  console.log('Fetching companies...');
  const companies = await fetchCompanies(shop, token);
  console.log(`Found ${companies.length} companies.`);

  // Existing metaobjects are required to reuse cached lat/lng and confirm scopes.
  let existingByHandle = new Map();
  console.log('Fetching existing metaobjects...');
  try {
    const existing = await fetchExistingMetaobjects(shop, token);
    console.log(`Found ${existing.length} existing metaobjects.`);
    for (const m of existing) {
      existingByHandle.set(m.handle, m);
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (/ACCESS_DENIED|Access denied for metaobjects/i.test(msg)) {
      throw new Error(
        'Missing Shopify scopes read_metaobjects/write_metaobjects. Update app scopes, deploy the app config, then reinstall or re-consent on the store.'
      );
    }
    throw new Error(`Could not fetch b2b_map_location metaobjects: ${msg}`);
  }

  const seenHandles = new Set();
  const limit = parseInt(process.env.B2B_SYNC_LIMIT || '0', 10) || Infinity;
  // Leave headroom before Vercel maxDuration so we can return JSON instead of a 504.
  const budgetMs = parseInt(process.env.B2B_SYNC_BUDGET_MS || '270000', 10);
  const startedAt = Date.now();
  const timeLeft = () => budgetMs - (Date.now() - startedAt);

  outer: for (const company of companies) {
    if (stats.created + stats.updated >= limit) {
      console.log(`\nReached limit of ${limit} locations.`);
      break;
    }
    if (timeLeft() < 5000) {
      stats.incomplete = true;
      stats.errors.push('Sync paused near time limit; run again to continue.');
      console.log('\nStopping early to avoid Vercel timeout.');
      break;
    }

    const locations = company.locations?.edges?.map((e) => e.node) || [];
    if (locations.length === 0) continue;

    for (const loc of locations) {
      const addr = loc.shippingAddress || loc.billingAddress;
      if (!addr?.address1 && !addr?.city) continue;

      if (stats.created + stats.updated >= limit) break outer;
      if (timeLeft() < 5000) {
        stats.incomplete = true;
        stats.errors.push('Sync paused near time limit; run again to continue.');
        console.log('\nStopping early to avoid Vercel timeout.');
        break outer;
      }

      const handle = `b2b-${slugify(company.name)}-${slugify(loc.name || 'main')}-${loc.id.split('/').pop()}`;
      if (seenHandles.has(handle)) continue;
      seenHandles.add(handle);

      let { lat, lng } = (() => {
        const prev = existingByHandle.get(handle);
        if (prev) {
          const f = metaobjectFieldsToMap(prev);
          const la = parseFloat(f.latitude);
          const ln = parseFloat(f.longitude);
          if (!isNaN(la) && !isNaN(ln) && la !== 0 && ln !== 0) {
            return { lat: la, lng: ln };
          }
        }
        return { lat: null, lng: null };
      })();

      if (lat == null || lng == null) {
        const q = [addr.address1, addr.city, addr.province, addr.zip, addr.country].filter(Boolean).join(', ');
        if (stats.created + stats.updated + stats.skipped < 5) {
          console.log('Geocoding:', q?.slice(0, 60) || '(empty)');
        }
        const geo = await geocodeAddress(mapboxToken, addr);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        } else {
          stats.skipped++;
          stats.errors.push(`Geocode failed: ${company.name} - ${addr.address1 || addr.city}`);
          continue;
        }
      }

      const fields = {
        business_name: company.name,
        address_line_1: addr.address1 || '',
        city: addr.city || '',
        province_state: addr.province || '',
        country: addr.country || '',
        zip_postal_code: addr.zip || '',
        phone: loc.phone || '',
        website: '',
        latitude: String(lat),
        longitude: String(lng),
      };

      try {
        await upsertMetaobject(shop, token, handle, fields);
        if (existingByHandle.has(handle)) {
          stats.updated++;
        } else {
          stats.created++;
        }
        const total = stats.created + stats.updated;
        if (total % 5 === 0 || total <= 3) {
          process.stdout.write(`\rSynced ${total} locations...`);
        }
      } catch (err) {
        const msg = err.message || String(err);
        if (/ACCESS_DENIED|Access denied/i.test(msg)) {
          throw new Error(
            'Missing Shopify scopes read_metaobjects/write_metaobjects. Update app scopes, deploy the app config, then reinstall or re-consent on the store.'
          );
        }
        stats.errors.push(`${company.name}: ${msg}`);
      }
    }
  }

  return stats;
}

module.exports = { runSync };
