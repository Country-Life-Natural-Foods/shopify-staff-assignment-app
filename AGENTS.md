## Learned User Preferences

- When debugging this app in production, use the Vercel CLI (logs, deployments, project linkage) rather than relying only on local runs or pasted snippets.
- Prefer fixing hosting and integration root causes (sessions, hostname, routing, env) over treating browser console noise as the primary fix surface.
- Keep Shopify application URL and OAuth redirect URLs aligned with the live deployment merchants actually open.
- For this app’s scopes, install links, and reinstall after uninstall, use Shopify Dev Dashboard and Shopify CLI (`shopify app deploy` / install URL). It often does not appear in the Country Life Partner Dashboard because that Partner login is the user’s personal account, not the store org that owns the app.

## Learned Workspace Facts

- The Shopify embedded admin UI is served by Express in `api/index.js` with static assets under `public/` (main B2B UI in `public/index.html`). `/test-ui` can serve the HTML for testing outside the normal authenticated `/` flow.
- On Vercel, export the Express `app` directly; avoid `serverless-http`–style handlers that do not match Vercel’s Node serverless entrypoint pattern.
- Stable OAuth and API calls on Vercel need a persistent session store: `REDIS_URL` (Upstash) or `DATABASE_URL` / `POSTGRES_URL` (Neon/Supabase). In-memory sessions do not survive across serverless instances. Use `lib/shopify-postgres-session-storage.js` for Postgres (Neon SSL); the stock Shopify Postgres session package can hang. Staff data also uses Postgres when a database URL is set. Redis is not required if Postgres is configured.
- Order rollups live in the same Neon/Postgres database (`company_metric_order`, `company_metric_day`, `company_metric_line`, `company_metric_product_day`). Commissions, monthly reports, and the Analytics page (summary, trend, companies, products, export) read those tables after a one-time Shopify backfill; new B2B orders arrive via `orders/create|updated|cancelled` webhooks at `/webhooks`. Until backfill status is `complete`, those screens still page Shopify. Product charts need line-item rows (`product_backfill_status` or existing `company_metric_line` rows). Company names/contacts still come from a slim Shopify directory query — no `read_products`. Shopify Admin `orders` without a `created_at` range only returns about the last 60 days; backfill must pass an explicit historical range or it can mark `complete` while older months are missing. Deploy `shopify.app.toml` webhook subscriptions and keep `DATABASE_URL` set or the rollup path stays off.
- Hostname for `@shopify/shopify-api` is centralized in `lib/resolve-shopify-hostname.js`; production should set `SHOPIFY_APP_URL` to match `shopify.app.toml`, with fallbacks from `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL` when injected.
- `api/simple.js` should re-export `api/index.js` so routes hitting `/api/simple` share a single `shopifyApp()` initialization.
- The `read_users` scope is restricted; `shopify app deploy` may reject it until Shopify Partner approval. Staff Admin API usage requires that scope after approval, plus reinstall or re-consent.
- B2B map sync (`lib/sync-b2b-map.js`) uses metaobjects and needs `read_metaobjects` / `write_metaobjects` in app scopes when that feature is enabled.
- Dashboard, Analytics, and Reports persist GET JSON in `sessionStorage` via `public/app-data-cache.js` and paint cached data on return visits, then refresh in the background. Mapbox loads only when the Map tab opens.

## CRM Features (Customers Tab)

- **Customers tab** shows all B2B companies with last order date, days since last order (color-coded badge), typical gap between recent orders, and per-company notes.
- **Order cadence calculation** uses the most recent 25 orders per company (`sortKey: CREATED_AT, reverse: true`); gaps are averaged to estimate typical order frequency.
- **Day-since-last-order badges**: green ≤30 days, amber 31–89 days, red 90+ days. **Never** only when there is no spend, no orders, and no last-order date. `Company.totalSpent` can grow from linked buyer/draft/legacy orders while `Company.orders` stays empty — last order should also use contact customer `lastOrder`; if spend exists but no date, show **Ordered**, not Never.
- **NEW partner**: 3 or fewer lifetime orders across company orders and linked buyer accounts; do not mark NEW when the company has spend but zero counted B2B company orders.
- **Notes stored on Company metafield**: namespace `clnf`, key `crm_notes`, type `json`. Each note has `{ id, body, author, createdAt }`, newest first. First save auto-creates metafield definition.
- **Notes API endpoints**:
  - `GET /api/companies/:companyId/notes` — fetch notes
  - `POST /api/companies/:companyId/notes` — add note (body `{ body, author }`)
  - `DELETE /api/companies/:companyId/notes/:noteId` — delete note
- **Filters**: All Companies, Last 30 Days, 31–89 Days, 90+ Days, Never Ordered. Map tab stays as second tab.
- **Permissions needed**: `read_companies`, `write_companies`, `read_orders` for fetching companies and order data; metafield updates need `write_companies`.

## Analytics (Analytics page — `/analytics`)

- **Purpose**: date-range wholesale KPIs, revenue trend, company mix, and product mix. Default UI range is year-to-date (January 1 through today).
- **After the Neon order rollup is complete**, `/api/analytics/summary`, `/revenue-trend`, `/companies`, `/companies/:id`, `/products`, and `/export` read `company_metric_*` instead of paging Shopify orders. `totalSpent` / KPI revenue are **the selected date range**, not lifetime Shopify `Company.totalSpent`. Last-order date stays lifetime so “days since last order” stays meaningful.
- **Shopify leftover**: slim company directory (id, name, contacts) and `companiesCount` for names and the Total Companies KPI. Product titles are keyed from line-item titles (`title:…`) because the app does not have `read_products`.
- **Fallback**: if rollup is not `complete` (or product lines are missing), the same routes still page Shopify. JSON includes `source: 'rollup' | 'shopify'`.

## Commission Reports (Reports page — `/reports`)

- **First real "separate route"** in the app: `public/reports.html`, served via `app.get('/reports', ensureInstalledOnShop, shopifyCspHeaders, ...)` in `api/index.js`, mirroring the `/` handler exactly (same App Bridge meta injection via `sendAppHtmlFile`). Manager-only; linked from the main dashboard's top nav (`#reports-link`, toggled in `checkUserRole()`).
- **Purpose**: monthly payout report for finance — per rep, which companies, revenue for that calendar month, and commission owed. The existing Commissions tab is *lifetime revenue since assignment*, not month-scoped — Reports is the actual "last month's numbers" view.
- **Access gate**: same PIN gate as Commissions (`req.session.commissionsUnlockedFor`), reused as-is — a manager who already unlocked Commissions this session is auto-unlocked here too.
- **Endpoints**: `GET /api/reports/commissions?month=YYYY-MM` (JSON) and `GET /api/reports/commissions/export.csv?month=YYYY-MM` (CSV download, for handing to finance). No `month` defaults to *last* calendar month (report is meant to be pulled on the 1st). Both share `buildCommissionReport()` in `api/index.js`. After the Neon order rollup is complete, these (and `/api/commissions`) `SUM` `company_metric_order` instead of paging `company.orders` per account. `source` on the JSON is `rollup` or `shopify`.
- **Every staff member appears**, even with $0/no companies for the period — deliberate, so finance sees a complete roster rather than wondering if someone was left off.
- **Known limitation**: commission tier used is the rep's *current* tier (`staffStore`), not whatever was in effect during the reported month. If a manager changes someone's tier, regenerating a past month's report will use the new tier, not the historical one. No point-in-time tier history is tracked.
- **Export format**: CSV (not PDF) — zero new dependencies, opens directly in Excel/Sheets. `reports.html` itself has print CSS (`@media print`) so "Save as PDF" via the browser print dialog covers the PDF ask without a server-side PDF/headless-browser library.
