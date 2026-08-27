# Customer CRM (last order + notes)

The embedded app home now has two tabs:

- **Customers** — full B2B company list with last order date, days since that order, and a notes drawer
- **Map** — existing B2B map sync dashboard

## What sales sees

- Last order date on every company
- A days-since-last-order badge (green ≤30, amber 31–89, red 90+)
- Typical gap between recent orders when at least two sample orders exist
- Filters for last 30 days, 31–89 days, 90+ days, and companies with no orders yet
- Per-company note history, newest first
- Search by company name to find specific accounts

## How notes are stored

Notes live on the Shopify **Company** as a JSON metafield:

- namespace: `clnf`
- key: `crm_notes`
- type: `json`

Each note is `{ id, body, author, createdAt }`. The first save creates the metafield definition if it is missing.

This keeps notes on the customer record in Shopify, so they survive app deploys and do not depend on Neon/Redis.

## API

- `GET /api/companies` — companies plus `performance` (`lastOrderDate`, `daysSinceLastOrder`, `avgDaysBetweenOrders`, recent order dates) and `notes`
- `GET /api/companies/:companyId/notes` — fetch notes for a company
- `POST /api/companies/:companyId/notes` — add note (body `{ body, author }`)
- `DELETE /api/companies/:companyId/notes/:noteId` — delete a specific note

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

## Usage flow

1. **Browse customers** — click on a company to open the notes drawer
2. **View order history** — see last order date and typical order frequency
3. **Add notes** — type a note and click Save Note to record it on the company
4. **Delete notes** — click the X on a note to remove it
5. **Switch to Map** — click the Map tab to see the B2B location sync dashboard

## Color badges

- **Green (≤30 days)** — active customer, recent order
- **Amber (31–89 days)** — at-risk customer, watch for engagement
- **Red (90+ days)** — dormant customer, may need re-engagement
- **Red (Never)** — prospect, no purchase history yet
