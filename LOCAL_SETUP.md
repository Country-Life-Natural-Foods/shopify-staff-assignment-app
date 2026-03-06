# B2B Map Sync – Local Setup

Run the sync locally first, then deploy to Vercel when ready.

---

## 1. Copy env.example to .env

```powershell
cd shopify-staff-app
copy env.example .env
```

---

## 2. Fill in .env – Where to Get Each Value

| Variable | Where to Get It | Status |
|----------|-----------------|--------|
| `SHOPIFY_SHOP_DOMAIN` | `clnf.myshopify.com` | ✅ Pre-filled |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard → Your app → Settings | ✅ Pre-filled (6f3d469d72ff9f200fdefa5c8cd5d77f) |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard → Your app → Settings → Secret | ⚠️ **You must add this** |
| `MAPBOX_ACCESS_TOKEN` | Theme: `templates/page.map.json` → `mapbox_token` | ⚠️ **You must add this** (or copy from step 3 below) |

### Mapbox token

From `templates/page.map.json` in your theme:

```
pk.xxxx  # Get from templates/page.map.json in your theme (mapbox_token)
```

---

## 3. Verify Dev Dashboard app scopes

1. Go to [dev.shopify.com](https://dev.shopify.com) → **Apps** → your B2B Map app
2. Open **Configuration** or **Versions**
3. Ensure these scopes are enabled:
   - `read_companies`
   - `read_metaobjects`
   - `write_metaobjects`
4. If you change scopes, create a new version and install it on the store.

---

## 4. Install the app on the store

1. In Dev Dashboard → your app → **Test your app** or **Install**
2. Choose **clnf** (or your store)
3. Complete installation

---

## 5. Ensure `b2b_map_location` metaobject exists

In Shopify Admin → **Settings** → **Custom data** → **Metaobjects**:

- Type: `b2b_map_location`
- Fields: `business_name`, `address_line_1`, `city`, `province_state`, `country`, `zip_postal_code`, `phone`, `website`, `latitude`, `longitude`

If it’s missing, create it or ask for help.

---

## 6. Install dependencies and run sync

```powershell
cd shopify-staff-app
npm install
npm run sync-b2b-map
```

Expected output:

```
B2B Map Sync complete: { created: X, updated: Y, skipped: Z, errors: [] }
```

---

## 7. Run the app (optional – for HTTP trigger)

```powershell
npm start
```

Then:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/sync-b2b-map" -Method POST
```

---

## 8. Vercel deployment

1. Push code to your repo
2. In Vercel → Project → **Settings** → **Environment Variables**, add:
   - `SHOPIFY_SHOP_DOMAIN` = `clnf.myshopify.com`
   - `SHOPIFY_CLIENT_ID` = `6f3d469d72ff9f200fdefa5c8cd5d77f`
   - `SHOPIFY_CLIENT_SECRET` = (your secret)
   - `MAPBOX_ACCESS_TOKEN` = (from theme)
3. Redeploy

---

## What you must do manually

1. Add `SHOPIFY_CLIENT_SECRET` to `.env` (from Dev Dashboard)
2. Add `MAPBOX_ACCESS_TOKEN` to `.env` (from `templates/page.map.json` or the value above)
3. Confirm app scopes in Dev Dashboard
4. Install the app on the clnf store
5. Confirm the `b2b_map_location` metaobject exists in Shopify Admin
