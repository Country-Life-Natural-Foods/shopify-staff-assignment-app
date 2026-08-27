## Learned User Preferences

- When debugging this app in production, use the Vercel CLI (logs, deployments, project linkage) rather than relying only on local runs or pasted snippets.
- Prefer fixing hosting and integration root causes (sessions, hostname, routing, env) over treating browser console noise as the primary fix surface.
- Keep Shopify Partner Dashboard application URL and OAuth redirect URLs aligned with the live deployment merchants actually open.

## Learned Workspace Facts

- The Shopify embedded admin UI is served by Express in `api/index.js` with static assets under `public/` (main B2B UI in `public/index.html`). `/test-ui` can serve the HTML for testing outside the normal authenticated `/` flow.
- On Vercel, export the Express `app` directly; avoid `serverless-http`–style handlers that do not match Vercel’s Node serverless entrypoint pattern.
- Stable OAuth and API calls on Vercel need `REDIS_URL` and Redis-backed Shopify and Express session storage; in-memory sessions do not survive across serverless instances.
- Hostname for `@shopify/shopify-api` is centralized in `lib/resolve-shopify-hostname.js`; production should set `SHOPIFY_APP_URL` to match `shopify.app.toml`, with fallbacks from `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL` when injected.
- `api/simple.js` should re-export `api/index.js` so routes hitting `/api/simple` share a single `shopifyApp()` initialization.
- The `read_users` scope is restricted; `shopify app deploy` may reject it until Shopify Partner approval. Staff Admin API usage requires that scope after approval, plus reinstall or re-consent.
- B2B map sync (`lib/sync-b2b-map.js`) uses metaobjects and needs `read_metaobjects` / `write_metaobjects` in app scopes when that feature is enabled.

## CRM Features (Customers Tab)

- **Customers tab** shows all B2B companies with last order date, days since last order (color-coded badge), typical gap between recent orders, and per-company notes.
- **Order cadence calculation** uses the most recent 25 orders per company (`sortKey: CREATED_AT, reverse: true`); gaps are averaged to estimate typical order frequency.
- **Day-since-last-order badges**: green ≤30 days, amber 31–89 days, red 90+ days or never ordered.
- **Notes stored on Company metafield**: namespace `clnf`, key `crm_notes`, type `json`. Each note has `{ id, body, author, createdAt }`, newest first. First save auto-creates metafield definition.
- **Notes API endpoints**:
  - `GET /api/companies/:companyId/notes` — fetch notes
  - `POST /api/companies/:companyId/notes` — add note (body `{ body, author }`)
  - `DELETE /api/companies/:companyId/notes/:noteId` — delete note
- **Filters**: All Companies, Last 30 Days, 31–89 Days, 90+ Days, Never Ordered. Map tab stays as second tab.
- **Permissions needed**: `read_companies`, `write_companies`, `read_orders` for fetching companies and order data; metafield updates need `write_companies`.
