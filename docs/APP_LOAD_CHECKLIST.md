# Shopify admin app — load checklist

Use this if the embedded app reloads in a loop or shows a serverless/cookie error.

## Required Vercel env vars (Production)

| Variable | Example / notes |
|----------|-----------------|
| `SHOPIFY_API_KEY` | Partner Dashboard → Client ID (no trailing spaces) |
| `SHOPIFY_API_SECRET` | Partner Dashboard → Client secret |
| `SHOPIFY_APP_URL` | `https://shopify-staff-assignment-app-pi.vercel.app` (no trailing slash or line breaks) |
| `SESSION_SECRET` | Long random string |
| `POSTGRES_URL` or `DATABASE_URL` | From Neon integration (pooled URL) |

Optional: `MAPBOX_PUBLIC_TOKEN` — map display only; sync still works without it.

## Partner Dashboard (must match Vercel)

- **App URL:** `https://shopify-staff-assignment-app-pi.vercel.app`
- **Allowed redirection URL:** `https://shopify-staff-assignment-app-pi.vercel.app/auth/callback`

## Verify deployment

Open: https://shopify-staff-assignment-app-pi.vercel.app/api/health

Expected:

```json
"sessionStorage": "postgres",
"persistentSessions": true
```

## After changing env or code

1. Redeploy production on Vercel.
2. On the store: **uninstall** the app, then **install** again.
3. Open only from **Shopify Admin → Apps** (not the raw Vercel URL).

## Scopes

`shopify.app.toml` and the running app must match. After scope changes, merchants must reinstall.

Current scopes: `read_companies`, `write_companies`, `read_orders`, `read_customers`, `write_customers`.

Metaobject map sync may need `read_metaobjects` / `write_metaobjects` added later (API errors, not usually an auth loop).
