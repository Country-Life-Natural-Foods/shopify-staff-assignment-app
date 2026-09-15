# Customer CRM (company detail + follow-up)

The embedded app home now has two tabs:

- **Customers** — full B2B company list with last order date, days since that order, and a company detail drawer
- **Map** — existing B2B map sync dashboard

## What sales sees

- Last order date on every company
- A days-since-last-order badge (green ≤30, amber 31–89, red 90+)
- Typical gap between recent orders when at least two sample orders exist
- Filters for last 30 days, 31–89 days, 90+ days, and companies with no orders yet
- Per-company note history, newest first
- Sample-box sent/received tracking and follow-up filtering
- YTD buying intelligence loaded only when a company drawer opens
- Search by company name to find specific accounts

## How notes are stored

Notes live on the Shopify **Company** as a JSON metafield:

- namespace: `clnf`
- key: `crm_notes`
- type: `json`

Each note is `{ id, body, author, createdAt }`. The first save creates the metafield definition if it is missing.

This keeps notes on the customer record in Shopify, so they survive app deploys and do not depend on Neon/Redis.

Sample-box state uses the same Company metafield pattern:

- namespace: `clnf`
- key: `sample_box`
- type: `json`
- status: `none`, `sent`, or `received`

The value can also include `sentAt`, `receivedAt`, `sentBy`, `note`, and `followUpDueAt`. The first save creates the Company metafield definition when needed.

## API

- `GET /api/companies` — companies plus `performance`, `notes`, and `sampleBox`
- `GET /api/companies/:companyId/notes` — fetch notes for a company
- `POST /api/companies/:companyId/notes` — add note (body `{ body, author }`)
- `DELETE /api/companies/:companyId/notes/:noteId` — delete a specific note
- `GET /api/companies/:companyId/sample-box` — fetch sample-box state
- `PUT /api/companies/:companyId/sample-box` — update sample-box state and optionally append a CRM note
- `GET /api/companies/:companyId/intelligence` — YTD/current-prior-period rollup revenue and top products for the open drawer

Order cadence uses the most recent 25 orders for that company (`company_id:` query, `CREATED_AT` descending, `sortKey: CREATED_AT, reverse: true`). That is a sample for rhythm, not a lifetime order count.

## Permissions

The app requires these scopes:

- `read_companies` — fetch company list
- `write_companies` — create/update metafield definitions and save notes
- `read_orders` — fetch order data for last-order date and cadence calculation

## Filters

Click filter buttons to show:

- **All Companies** — all companies without filtering
- **Last 30 Days** — companies that ordered within 30 days
- **31–89 Days** — companies that ordered 31–89 days ago
- **90+ Days** — companies that ordered 90+ days ago
- **Never Ordered** — companies with no orders yet
- **Sample sent · needs follow-up** — companies whose sample-box status is `sent`

## Usage flow

1. **Browse customers** — click a company to open its detail drawer
2. **Review overview** — see last order, cadence, sample status, and YTD rollup revenue versus the same calendar dates last year
3. **Open accordion sections** — review notes, update sample-box status, or inspect top products
4. **Switch to Map** — click the Map tab to see the B2B location sync dashboard

Buying intelligence is never loaded for every list row. It is requested once when a drawer opens. Revenue labels refer to the displayed rollup date ranges, not Shopify lifetime `Company.totalSpent`. Top products are ranked by distinct orders, then revenue, and include units and revenue. If either order or product-line backfill is incomplete, the drawer says analytics are still backfilling and keeps the overview to existing cadence data.

## Color badges

- **Green (≤30 days)** — active customer, recent order
- **Amber (31–89 days)** — at-risk customer, watch for engagement
- **Red (90+ days)** — dormant customer, may need re-engagement
- **Red (Never)** — prospect, no purchase history yet
