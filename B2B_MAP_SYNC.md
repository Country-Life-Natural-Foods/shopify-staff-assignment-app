# B2B Map Sync

Automatically populates the `b2b_map_location` metaobject from your Shopify B2B companies. The sync fetches company locations, geocodes addresses via Mapbox, and creates/updates metaobjects for the store locator map at `/pages/map`.

## Where the Script Lives

| Location | Purpose |
|----------|---------|
| `shopify-staff-app/lib/sync-b2b-map.js` | Core sync logic (fetch companies, geocode, upsert metaobjects) |
| `shopify-staff-app/scripts/run-sync.js` | Standalone script for manual runs |
| `shopify-staff-app/server.js` | HTTP route + daily cron |

## Setup

### 1. Create a Shopify App (Dev Dashboard or legacy Custom App)

**Option A: Dev Dashboard (recommended for new apps)**

1. Go to [dev.shopify.com](https://dev.shopify.com) → **Apps** → **Create app**
2. Configure scopes: `read_companies`, `read_metaobjects`, `write_metaobjects`
3. **Install** the app on your store
4. Copy **Client ID** and **Secret** from Settings

The sync uses the **client credentials grant** to get an access token automatically (no manual token copy).

**Option B: Legacy Custom App (Shopify Admin)**

1. Shopify Admin → **Settings** → **Apps and sales channels** → **Develop apps** → **Create an app**
2. Configure scopes: `read_companies`, `read_metaobjects`, `write_metaobjects`
3. **Install** the app and copy the **Admin API access token**

### 2. Create the Metaobject Definition

Ensure the `b2b_map_location` metaobject type exists with these fields:

- `business_name` (single_line_text)
- `address_line_1` (single_line_text)
- `city` (single_line_text)
- `province_state` (single_line_text)
- `country` (single_line_text)
- `zip_postal_code` (single_line_text)
- `phone` (single_line_text)
- `website` (single_line_text)
- `latitude` (single_line_text or number)
- `longitude` (single_line_text or number)

### 3. Environment Variables

Add to `.env` in `shopify-staff-app/`:

**Dev Dashboard app:**
```
SHOPIFY_SHOP_DOMAIN=clnf.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id
SHOPIFY_CLIENT_SECRET=your_client_secret
MAPBOX_ACCESS_TOKEN=pk.xxxx
```

**Legacy custom app:**
```
SHOPIFY_SHOP_DOMAIN=clnf.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxx
MAPBOX_ACCESS_TOKEN=pk.xxxx
```

- **MAPBOX_ACCESS_TOKEN**: Use the same token from your theme’s map section, or create one at [mapbox.com](https://account.mapbox.com/access-tokens/).

Optional:

```
CRON_SECRET=random_secret_for_webhook
CRON_SCHEDULE=0 0 * * *
```

## How to Run

### Manual (one-off)

From the `shopify-staff-app` folder:

```bash
npm run sync-b2b-map
```

Or:

```bash
node scripts/run-sync.js
```

### Manual via HTTP

If the app is running:

```bash
curl -X POST http://localhost:3000/api/sync-b2b-map
```

If `CRON_SECRET` is set:

```bash
curl -X POST -H "x-cron-secret: YOUR_CRON_SECRET" http://localhost:3000/api/sync-b2b-map
```

### Daily at Midnight (automatic)

When the app runs with `SHOPIFY_ADMIN_ACCESS_TOKEN` and `MAPBOX_ACCESS_TOKEN` set, it schedules a daily sync.

- **Default**: `0 0 * * *` = midnight **UTC**
- **Override**: Set `CRON_SCHEDULE` in `.env`

Examples:

| Timezone | Cron expression |
|----------|-----------------|
| Midnight UTC | `0 0 * * *` |
| Midnight Eastern (EST) | `0 5 * * *` |
| Midnight Eastern (EDT) | `0 4 * * *` |
| Midnight Pacific (PST) | `0 8 * * *` |

## Deployment

For the daily cron to run, the app must be running 24/7. Typical options:

- **Railway / Render / Heroku**: App runs continuously; cron runs in-process.
- **Vercel / serverless**: No long-running process; use an external cron (e.g. [cron-job.org](https://cron-job.org)) to call `POST /api/sync-b2b-map` at midnight.

## Output

The sync returns:

```json
{
  "success": true,
  "created": 5,
  "updated": 2,
  "skipped": 1,
  "errors": ["Geocode failed: Company X - invalid address"]
}
```

- **created**: New metaobjects added
- **updated**: Existing metaobjects refreshed
- **skipped**: Addresses that could not be geocoded
- **errors**: Per-record error messages
