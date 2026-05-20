# Neon setup for Shopify Staff Assignment App (Vercel)

This app only needs Neon to **remember OAuth login** on Vercel. The map sync button does not use the database for map data.

## Neon CLI (project-local)

```bash
npm run neon -- --version
npm run neon:auth          # one-time browser login
npm run neon:projects
npm run neon:connection-string --project-id <NEON_PROJECT_ID>
```

`neonctl` is installed as a dev dependency (`npm install`); use `npm run neon -- …` so you do not need a global install.

## One-time setup (about 5 minutes)

### 1. Create Neon and link to Vercel

1. Open [vercel.com](https://vercel.com) → project **shopify-staff-assignment-app**
2. Go to **Storage** tab → **Create Database** → choose **Neon** (Postgres)
3. Name it e.g. `staff-app-sessions` → region close to your users → **Create**
4. When prompted, **Connect** the database to **shopify-staff-assignment-app**
5. Vercel should add env vars automatically, typically:
   - `DATABASE_URL` or `POSTGRES_URL` (pooled, use for the app)
   - `POSTGRES_URL_NON_POOLING` (optional)

### 2. Confirm environment variables

**Settings** → **Environment Variables** → **Production**:

| Variable | Required |
|----------|----------|
| `DATABASE_URL` or `POSTGRES_URL` | Yes (starts with `postgresql://`) |
| `SHOPIFY_API_KEY` | Yes |
| `SHOPIFY_API_SECRET` | Yes |
| `SHOPIFY_APP_URL` | Yes → `https://shopify-staff-assignment-app-pi.vercel.app` |
| `SESSION_SECRET` | Yes |

You do **not** need `REDIS_URL` if Postgres is set.

### 3. Redeploy

**Deployments** → latest → **⋯** → **Redeploy** (Production).

Or push to GitHub if auto-deploy is enabled, or run locally:

```bash
vercel --prod
```

### 4. Verify

Open:

https://shopify-staff-assignment-app-pi.vercel.app/api/health

Expect:

```json
{
  "sessionStorage": "postgres",
  "persistentSessions": true
}
```

If you see `"sessionStorage": "memory"`, Neon is not connected yet.

### 5. Reinstall the Shopify app (once)

On your dev store:

1. **Settings** → **Apps** → uninstall **Staff Assignment Manager**
2. Install again from Partner Dashboard / store admin
3. Open the app from **Shopify Admin** → **Apps** (not by pasting the Vercel URL)

### 6. Partner Dashboard URLs

- App URL: `https://shopify-staff-assignment-app-pi.vercel.app`
- Allowed redirection URL: `https://shopify-staff-assignment-app-pi.vercel.app/auth/callback`

---

## Reusing Neon from `clnf-b2b-subscriptions`

You can use the **same Neon account** but create a **separate database** (or project) for this app so sessions stay isolated. Do not point two unrelated apps at the same session tables unless you intend to share OAuth state.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Infinite reload / cookie error | `persistentSessions` must be `true` on `/api/health` |
| `ensureInstalledOnShop did not receive shop` | Open app from Admin, not raw Vercel URL |
| Health still shows `memory` | Redeploy after adding `DATABASE_URL` |
