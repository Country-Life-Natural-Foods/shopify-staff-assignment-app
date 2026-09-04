'use strict';

const { Pool } = require('pg');
const { resolvePostgresUrl } = require('./configure-session-storage');
const { shopifyGraphql } = require('./shopify-gql');

const ORDER_TABLE = 'company_metric_order';
const DAY_TABLE = 'company_metric_day';
const LINE_TABLE = 'company_metric_line';
const PRODUCT_DAY_TABLE = 'company_metric_product_day';
const META_TABLE = 'company_metric_meta';
const REFUND_TABLE = 'company_metric_refund';

// Shopify only returns ~60 days of orders unless the app has `read_all_orders`.
// `read_orders` plus a created_at search is not enough — counts look large but
// the connection still starts at the 60-day window. After that scope is granted,
// closed orders since HISTORICAL_CUTOFF are paged oldest-first, then open and
// cancelled. Non-B2B (DTC) rows are skipped at ingest via purchasingEntity.
const HISTORICAL_CUTOFF = '2025-01-01T00:00:00.000Z';
const HISTORICAL_ORDER_SEARCH = "created_at:>='2025-01-01'";
const BACKFILL_STATUSES = ['closed', 'open', 'cancelled'];
const BACKFILL_CURSOR_VERSION = 7;

const ORDER_BACKFILL_NODE = `
  id
  createdAt
  cancelledAt
  currentTotalPriceSet {
    shopMoney {
      amount
    }
  }
  purchasingEntity {
    __typename
    ... on PurchasingCompany {
      company {
        id
      }
    }
  }
  lineItems(first: 20) {
    edges {
      node {
        id
        title
        quantity
        originalTotalSet {
          shopMoney {
            amount
          }
        }
      }
    }
  }
`;

const BACKFILL_ORDERS_QUERY = `
  query BackfillB2bOrders($first: Int!, $after: String, $search: String!) {
    ordersCount(query: $search) {
      count
    }
    orders(first: $first, after: $after, query: $search, sortKey: CREATED_AT, reverse: false) {
      edges {
        node {
          ${ORDER_BACKFILL_NODE}
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ORDER_COMPANY_QUERY = `
  query OrderCompany($id: ID!) {
    order(id: $id) {
      id
      createdAt
      cancelledAt
      currentTotalPriceSet {
        shopMoney {
          amount
        }
      }
      purchasingEntity {
        __typename
        ... on PurchasingCompany {
          company {
            id
          }
        }
      }
      lineItems(first: 100) {
        edges {
          node {
            id
            title
            quantity
            originalTotalSet {
              shopMoney {
                amount
              }
            }
          }
        }
      }
    }
  }
`;

function normalizeShop(shop) {
  return String(shop || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

function normalizeCompanyId(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw);
  if (value.startsWith('gid://shopify/Company/')) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Company/${value}`;
  return value.startsWith('gid://') ? value : null;
}

function money(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function utcDay(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function toDayString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeProductId(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw);
  if (value.startsWith('gid://shopify/Product/')) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Product/${value}`;
  return value.startsWith('gid://') ? value : null;
}

function productKey({ productId, title, lineId }) {
  return normalizeProductId(productId)
    || (title ? `title:${String(title).trim().toLowerCase()}` : `line:${lineId}`);
}

function parseLinesFromPayload(payload) {
  const items = payload?.line_items;
  if (!Array.isArray(items)) return undefined;
  return items.map((item) => {
    const numericId = item.id != null ? String(item.id) : '';
    const lineId = item.admin_graphql_api_id
      || (numericId.startsWith('gid://') ? numericId : null)
      || (numericId ? `gid://shopify/LineItem/${numericId}` : null);
    if (!lineId) return null;
    const title = item.title || item.name || 'Untitled';
    const quantity = parseInt(item.quantity, 10) || 0;
    const unit = parseFloat(item.price) || 0;
    const discount = parseFloat(item.total_discount) || 0;
    return {
      lineId,
      productId: productKey({ productId: item.product_id, title, lineId }),
      title,
      quantity,
      revenue: money(unit * quantity - discount),
    };
  }).filter(Boolean);
}

function parseLinesFromGraphql(node) {
  return (node?.lineItems?.edges || []).map((edge) => {
    const item = edge?.node;
    if (!item?.id) return null;
    const title = item.title || 'Untitled';
    return {
      lineId: item.id,
      productId: productKey({ title, lineId: item.id }),
      title,
      quantity: item.quantity || 0,
      revenue: money(item.originalTotalSet?.shopMoney?.amount),
    };
  }).filter(Boolean);
}

function parseOrderPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const numericId = payload.id != null ? String(payload.id) : '';
  const orderId = payload.admin_graphql_api_id
    || (numericId.startsWith('gid://') ? numericId : null)
    || (numericId ? `gid://shopify/Order/${numericId}` : null);
  const createdAt = payload.created_at || payload.createdAt;
  if (!orderId || !createdAt) return null;
  return {
    orderId,
    companyId: normalizeCompanyId(
      payload.company?.admin_graphql_api_id
      || payload.company?.id
      || payload.company_id
      || payload.purchasing_entity?.company?.admin_graphql_api_id
      || payload.purchasing_entity?.company?.id
      || payload.purchasingEntity?.company?.id,
    ),
    createdAt,
    revenue: money(
      payload.current_total_price_set?.shop_money?.amount
      || payload.currentTotalPriceSet?.shopMoney?.amount
      || payload.current_total_price
      || payload.currentTotalPrice
      || 0,
    ),
    lines: parseLinesFromPayload(payload),
    // Cancelling an order does not zero out current_total_price unless a
    // refund with returned line items is also processed (those are separate
    // Shopify operations) — so a cancelled order must be excluded from
    // commission revenue explicitly rather than trusting the price field.
    cancelled: Boolean(payload.cancelled_at || payload.cancelledAt),
  };
}

function snapshotFromGraphqlOrder(node, companyIdHint) {
  if (!node?.id || !node.createdAt) return null;
  const fromEntity = node.purchasingEntity?.__typename === 'PurchasingCompany'
    ? normalizeCompanyId(node.purchasingEntity.company?.id)
    : null;
  return {
    orderId: node.id,
    companyId: fromEntity || normalizeCompanyId(companyIdHint),
    createdAt: node.createdAt,
    revenue: money(node.currentTotalPriceSet?.shopMoney?.amount),
    lines: parseLinesFromGraphql(node),
    cancelled: Boolean(node.cancelledAt),
  };
}

function historicalSearchQuery(status) {
  const safeStatus = BACKFILL_STATUSES.includes(status) ? status : BACKFILL_STATUSES[0];
  return `status:${safeStatus} ${HISTORICAL_ORDER_SEARCH}`;
}

function emptyOrdersCursor() {
  return {
    v: BACKFILL_CURSOR_VERSION,
    status: BACKFILL_STATUSES[0],
    ordersAfter: null,
  };
}

function parseBackfillCursor(raw) {
  if (!raw) return emptyOrdersCursor();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === BACKFILL_CURSOR_VERSION) {
      const status = BACKFILL_STATUSES.includes(parsed.status)
        ? parsed.status
        : BACKFILL_STATUSES[0];
      return {
        v: BACKFILL_CURSOR_VERSION,
        status,
        ordersAfter: parsed.ordersAfter || null,
      };
    }
  } catch {
    /* older backfill cursors — restart with closed + created_at range */
  }
  return emptyOrdersCursor();
}

function serializeBackfillCursor(cursor) {
  return JSON.stringify({
    v: BACKFILL_CURSOR_VERSION,
    status: cursor.status || BACKFILL_STATUSES[0],
    ordersAfter: cursor.ordersAfter || null,
  });
}

function decodeOrdersCursorTime(ordersAfter) {
  if (!ordersAfter) return null;
  try {
    const padded = String(ordersAfter).replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    const raw = parsed?.last_value;
    if (!raw) return null;
    const normalized = String(raw).trim().replace(' ', 'T');
    const date = new Date(/Z$/i.test(normalized) ? normalized : `${normalized}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

const CLOSED_WEIGHT = 0.85;
const OPEN_WEIGHT = 0.10;
const CANCELLED_WEIGHT = 0.05;

function estimateBackfillProgress(meta) {
  const complete = meta?.backfill_status === 'complete'
    && (meta.backfill_version || 0) >= BACKFILL_CURSOR_VERSION;
  if (complete) {
    return {
      complete: true,
      percent: 100,
      etaSeconds: 0,
      phase: 'complete',
      cursorAt: null,
    };
  }

  const cursor = parseBackfillCursor(meta?.backfill_cursor);
  const phase = BACKFILL_STATUSES.includes(cursor.status) ? cursor.status : 'closed';
  const cutoffMs = new Date(HISTORICAL_CUTOFF).getTime();
  const nowMs = Date.now();
  const spanMs = Math.max(nowMs - cutoffMs, 1);
  const cursorDate = decodeOrdersCursorTime(cursor.ordersAfter);
  let phaseFraction = 0;
  if (phase === 'closed') {
    if (cursorDate) {
      phaseFraction = Math.min(1, Math.max(0, (cursorDate.getTime() - cutoffMs) / spanMs));
    }
  } else {
    phaseFraction = cursor.ordersAfter ? 0.5 : 0;
  }

  const finishedWeight = phase === 'open'
    ? CLOSED_WEIGHT
    : (phase === 'cancelled' ? CLOSED_WEIGHT + OPEN_WEIGHT : 0);
  const currentWeight = phase === 'closed'
    ? CLOSED_WEIGHT
    : (phase === 'open' ? OPEN_WEIGHT : CANCELLED_WEIGHT);
  const ratio = finishedWeight + (currentWeight * phaseFraction);
  const percent = Math.min(99, Math.max(0, Math.round(ratio * 100)));

  const startedMs = meta?.backfill_window_started_at
    ? new Date(meta.backfill_window_started_at).getTime()
    : NaN;
  let etaSeconds = null;
  if (Number.isFinite(startedMs) && percent >= 4) {
    const elapsedMs = Math.max(1, nowMs - startedMs);
    const totalMs = elapsedMs / (percent / 100);
    etaSeconds = Math.round((totalMs - elapsedMs) / 1000);
    if (etaSeconds < 60) etaSeconds = 60;
    if (etaSeconds > 72 * 3600) etaSeconds = 72 * 3600;
  }

  return {
    complete: false,
    percent,
    etaSeconds,
    phase,
    cursorAt: cursorDate ? cursorDate.toISOString() : null,
  };
}

function nextBackfillStatus(status) {
  const index = BACKFILL_STATUSES.indexOf(status);
  if (index < 0 || index >= BACKFILL_STATUSES.length - 1) return null;
  return BACKFILL_STATUSES[index + 1];
}

function orderNodesFromConnection(conn) {
  return (conn?.edges || []).map((edge) => edge.node).filter(Boolean);
}

function nodesInHistoricalRange(nodes) {
  return nodes.filter((node) => node.createdAt >= HISTORICAL_CUTOFF);
}

// A money-only refund (no returned line items) does not change
// current_total_price and often does not even fire orders/updated for
// third-party apps, so it can't be picked up from the order snapshot at all —
// it has to be netted out from the dedicated refunds/create webhook, which
// reports exactly how much cash moved regardless of whether line items were
// touched.
function parseRefundPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const refundIdRaw = payload.id != null ? String(payload.id) : '';
  const refundId = payload.admin_graphql_api_id
    || (refundIdRaw.startsWith('gid://') ? refundIdRaw : null)
    || (refundIdRaw ? `gid://shopify/Refund/${refundIdRaw}` : null);
  const orderIdRaw = payload.order_id != null ? String(payload.order_id) : '';
  const orderId = orderIdRaw
    ? (orderIdRaw.startsWith('gid://') ? orderIdRaw : `gid://shopify/Order/${orderIdRaw}`)
    : null;
  if (!refundId || !orderId) return null;
  const amount = (Array.isArray(payload.transactions) ? payload.transactions : [])
    .filter((t) => t && t.kind === 'refund' && (t.status == null || t.status === 'success'))
    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  return { refundId, orderId, amount: money(amount) };
}

function disabledStore() {
  return {
    enabled: false,
    async isReady() { return false; },
    async isComplete() { return false; },
    async isProductsReady() { return false; },
    async status() { return { enabled: false, ready: false, productsReady: false, status: 'disabled' }; },
    async ingestWebhook() { return { applied: false, reason: 'disabled' }; },
    async ingestRefund() { return { applied: false, reason: 'disabled' }; },
    async backfillChunk() { return { enabled: false, ready: false }; },
    async backfillProductChunk() { return { enabled: false, ready: false }; },
    async shopsNeedingBackfill() { return []; },
    async sumJobs() { return new Map(); },
    async shopRangeTotals() { return { revenue: 0, orderCount: 0, activeCompanies: 0 }; },
    async companiesRange() { return new Map(); },
    async companyRange() { return { revenue: 0, orderCount: 0, lastOrderDate: null, days: [] }; },
    async productsRange() { return []; },
    async revenueByDay() { return []; },
    async orderCoverage() { return { oldest: null, newest: null, orderCount: 0 }; },
    async backfillProgress() {
      return { complete: false, percent: 0, etaSeconds: null, phase: 'disabled', cursorAt: null };
    },
    async rebuild() { return { enabled: false }; },
  };
}

async function bumpDay(client, shop, companyId, day, orderDelta, revenueDelta) {
  if (!companyId || !day || (!orderDelta && !revenueDelta)) return;
  await client.query(
    `INSERT INTO ${DAY_TABLE} (shop, company_id, day, order_count, revenue)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (shop, company_id, day) DO UPDATE SET
       order_count = ${DAY_TABLE}.order_count + EXCLUDED.order_count,
       revenue = ${DAY_TABLE}.revenue + EXCLUDED.revenue,
       updated_at = now()`,
    [shop, companyId, day, orderDelta, revenueDelta],
  );
}

async function bumpProductDay(client, shop, productId, day, title, unitDelta, revenueDelta) {
  if (!productId || !day || (!unitDelta && !revenueDelta)) return;
  await client.query(
    `INSERT INTO ${PRODUCT_DAY_TABLE} (shop, product_id, day, units_sold, revenue, title)
     VALUES ($1, $2, $3::date, $4, $5, $6)
     ON CONFLICT (shop, product_id, day) DO UPDATE SET
       units_sold = ${PRODUCT_DAY_TABLE}.units_sold + EXCLUDED.units_sold,
       revenue = ${PRODUCT_DAY_TABLE}.revenue + EXCLUDED.revenue,
       title = COALESCE(EXCLUDED.title, ${PRODUCT_DAY_TABLE}.title),
       updated_at = now()`,
    [shop, productId, day, unitDelta, revenueDelta, title || null],
  );
}

async function replaceLines(client, shop, orderId, prevDay, nextDay, lines) {
  const { rows: prev } = await client.query(
    `SELECT product_id, title, quantity, revenue FROM ${LINE_TABLE} WHERE shop = $1 AND order_id = $2`,
    [shop, orderId],
  );
  for (const row of prev) {
    if (prevDay) {
      await bumpProductDay(client, shop, row.product_id, prevDay, row.title, -row.quantity, -money(row.revenue));
    }
  }
  await client.query(`DELETE FROM ${LINE_TABLE} WHERE shop = $1 AND order_id = $2`, [shop, orderId]);
  if (!nextDay || !Array.isArray(lines)) return;
  for (const line of lines) {
    await client.query(
      `INSERT INTO ${LINE_TABLE} (shop, order_id, line_id, product_id, title, quantity, revenue)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shop, order_id, line_id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         title = EXCLUDED.title,
         quantity = EXCLUDED.quantity,
         revenue = EXCLUDED.revenue`,
      [shop, orderId, line.lineId, line.productId, line.title, line.quantity, money(line.revenue)],
    );
    await bumpProductDay(client, shop, line.productId, nextDay, line.title, line.quantity, money(line.revenue));
  }
}

async function applySnapshot(client, shop, snap) {
  const day = utcDay(snap.createdAt);
  if (!day) return { changed: false };

  const { rows } = await client.query(
    `SELECT company_id, day, revenue FROM ${ORDER_TABLE} WHERE shop = $1 AND order_id = $2`,
    [shop, snap.orderId],
  );
  const prev = rows[0];
  const prevCompany = prev?.company_id || null;
  const prevDay = toDayString(prev?.day);
  const prevRevenue = prev ? money(prev.revenue) : 0;
  // A cancelled order is treated exactly like one with no company at all —
  // fully removed from the ledger (revenue, order count, and line rollups) —
  // so it can never contribute to a rep's commission or the analytics KPIs.
  const nextCompany = snap.cancelled ? null : (snap.companyId || null);
  // Any refund already recorded for this order (money-only refunds included)
  // must stay netted out even when the order row itself gets rewritten from a
  // fresh Shopify snapshot — e.g. a later orders/updated webhook, or a full
  // rollup rebuild — otherwise the refund would silently "come back" the
  // moment the order's base revenue is reapplied.
  let nextRevenue = money(snap.revenue);
  if (nextCompany) {
    const { rows: refundRows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS refunded FROM ${REFUND_TABLE} WHERE shop = $1 AND order_id = $2`,
      [shop, snap.orderId],
    );
    const refunded = money(refundRows[0]?.refunded);
    if (refunded > 0) nextRevenue = Math.max(0, money(nextRevenue - refunded));
  }
  const lines = snap.lines;
  const orderUnchanged = Boolean(
    prev && prevCompany === nextCompany && prevDay === day && prevRevenue === nextRevenue,
  );

  if (orderUnchanged && lines === undefined) {
    return { changed: false };
  }

  if (!orderUnchanged) {
    if (prevCompany && prevDay) {
      await bumpDay(client, shop, prevCompany, prevDay, -1, -prevRevenue);
    }

    if (!nextCompany) {
      if (prev) {
        await client.query(`DELETE FROM ${ORDER_TABLE} WHERE shop = $1 AND order_id = $2`, [shop, snap.orderId]);
      }
      if (lines !== undefined) {
        await replaceLines(client, shop, snap.orderId, prevDay, null, []);
      }
      return { changed: Boolean(prev) || Boolean(lines && lines.length) };
    }

    await bumpDay(client, shop, nextCompany, day, 1, nextRevenue);
    await client.query(
      `INSERT INTO ${ORDER_TABLE} (shop, order_id, company_id, created_at, day, revenue)
       VALUES ($1, $2, $3, $4::timestamptz, $5::date, $6)
       ON CONFLICT (shop, order_id) DO UPDATE SET
         company_id = EXCLUDED.company_id,
         created_at = EXCLUDED.created_at,
         day = EXCLUDED.day,
         revenue = EXCLUDED.revenue,
         updated_at = now()`,
      [shop, snap.orderId, nextCompany, snap.createdAt, day, nextRevenue],
    );
  }

  if (lines !== undefined && nextCompany) {
    await replaceLines(client, shop, snap.orderId, prevDay || day, day, lines);
  }
  return { changed: true };
}

function createPostgresMetricsStore(connectionString, isProduction, { getOfflineGraphqlClient } = {}) {
  const pool = new Pool({
    connectionString,
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
    max: 1,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 25000,
    query_timeout: 25000,
  });
  pool.on('error', (err) => console.error('[postgres] company metrics pool', err));

  let readyPromise = null;
  function ensureReady() {
    if (!readyPromise) {
      readyPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS ${ORDER_TABLE} (
          shop text NOT NULL,
          order_id text NOT NULL,
          company_id text,
          created_at timestamptz NOT NULL,
          day date NOT NULL,
          revenue numeric(14,2) NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (shop, order_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cmo_shop_company_created
          ON ${ORDER_TABLE} (shop, company_id, created_at);
        CREATE TABLE IF NOT EXISTS ${DAY_TABLE} (
          shop text NOT NULL,
          company_id text NOT NULL,
          day date NOT NULL,
          order_count integer NOT NULL DEFAULT 0,
          revenue numeric(14,2) NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (shop, company_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_cmd_shop_day ON ${DAY_TABLE} (shop, day);
        CREATE TABLE IF NOT EXISTS ${META_TABLE} (
          shop text PRIMARY KEY,
          backfill_status text,
          backfill_cursor text,
          backfill_error text,
          ingested_orders integer NOT NULL DEFAULT 0,
          backfill_started_at timestamptz,
          last_backfill_at timestamptz,
          product_backfill_status text,
          product_backfill_cursor text
        );
        ALTER TABLE ${META_TABLE} ADD COLUMN IF NOT EXISTS product_backfill_status text;
        ALTER TABLE ${META_TABLE} ADD COLUMN IF NOT EXISTS product_backfill_cursor text;
        ALTER TABLE ${META_TABLE} ADD COLUMN IF NOT EXISTS backfill_version integer NOT NULL DEFAULT 0;
        ALTER TABLE ${META_TABLE} ADD COLUMN IF NOT EXISTS backfill_window_started_at timestamptz;
        CREATE TABLE IF NOT EXISTS ${LINE_TABLE} (
          shop text NOT NULL,
          order_id text NOT NULL,
          line_id text NOT NULL,
          product_id text NOT NULL,
          title text,
          quantity integer NOT NULL DEFAULT 0,
          revenue numeric(14,2) NOT NULL DEFAULT 0,
          PRIMARY KEY (shop, order_id, line_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cml_shop_product ON ${LINE_TABLE} (shop, product_id);
        CREATE TABLE IF NOT EXISTS ${PRODUCT_DAY_TABLE} (
          shop text NOT NULL,
          product_id text NOT NULL,
          day date NOT NULL,
          units_sold integer NOT NULL DEFAULT 0,
          revenue numeric(14,2) NOT NULL DEFAULT 0,
          title text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (shop, product_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_cmpd_shop_day ON ${PRODUCT_DAY_TABLE} (shop, day);
        CREATE TABLE IF NOT EXISTS ${REFUND_TABLE} (
          shop text NOT NULL,
          refund_id text NOT NULL,
          order_id text NOT NULL,
          amount numeric(14,2) NOT NULL DEFAULT 0,
          applied_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (shop, refund_id)
        );
      `).catch((err) => {
        console.error('[postgres] company metrics ensureSchema failed', err);
        readyPromise = null;
        throw err;
      });
    }
    return readyPromise;
  }

  async function loadMeta(shop) {
    await ensureReady();
    const { rows } = await pool.query(`SELECT * FROM ${META_TABLE} WHERE shop = $1`, [shop]);
    return rows[0] || null;
  }

  async function hasProductLines(shop) {
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ${ORDER_TABLE} WHERE shop = $1) AS orders,
         (SELECT COUNT(*)::int FROM ${LINE_TABLE} WHERE shop = $1) AS lines`,
      [shop],
    );
    const orders = rows[0]?.orders || 0;
    const lines = rows[0]?.lines || 0;
    return orders === 0 || lines > 0;
  }

  async function isProductsReady(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop || !(await isReady(shop))) return false;
    const meta = await loadMeta(shop);
    if (meta?.product_backfill_status === 'complete') return true;
    return hasProductLines(shop);
  }

  async function hasOrders(shop) {
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM ${ORDER_TABLE} WHERE shop = $1) AS ok`,
      [shop],
    );
    return Boolean(rows[0]?.ok);
  }

  async function isComplete(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return false;
    const meta = await loadMeta(shop);
    return meta?.backfill_status === 'complete'
      && (meta.backfill_version || 0) >= BACKFILL_CURSOR_VERSION;
  }

  async function isReady(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return false;
    if (await isComplete(shop)) return true;
    return hasOrders(shop);
  }

  async function backfillProgress(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop) {
      return { complete: false, percent: 0, etaSeconds: null, phase: 'pending', cursorAt: null };
    }
    if (await isComplete(shop)) {
      return {
        complete: true,
        percent: 100,
        etaSeconds: 0,
        phase: 'complete',
        cursorAt: null,
      };
    }
    const meta = await loadMeta(shop);
    return estimateBackfillProgress(meta);
  }

  async function status(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return { enabled: true, ready: false, status: 'unknown' };
    try {
      const meta = await loadMeta(shop);
      const progress = estimateBackfillProgress(meta);
      return {
        enabled: true,
        ready: progress.complete,
        productsReady: meta?.product_backfill_status === 'complete'
          || (progress.complete && (await hasProductLines(shop))),
        status: meta?.backfill_status === 'complete'
          && (meta.backfill_version || 0) < BACKFILL_CURSOR_VERSION
          ? 'pending'
          : (meta?.backfill_status || 'pending'),
        ingested: meta?.ingested_orders || 0,
        version: meta?.backfill_version || 0,
        error: meta?.backfill_error || null,
        lastBackfillAt: meta?.last_backfill_at || null,
        backfill: progress,
      };
    } catch (err) {
      return { enabled: true, ready: false, status: 'error', error: err.message };
    }
  }

  async function ingestWebhook(shopDomain, payload, { graphqlClient } = {}) {
    const shop = normalizeShop(shopDomain);
    const parsed = parseOrderPayload(payload);
    if (!shop || !parsed) return { applied: false, reason: 'invalid-payload' };

    let snap = parsed;
    const maybeB2b = Boolean(
      payload.company || payload.company_id || payload.purchasing_entity || payload.purchasingEntity,
    );
    if (!snap.companyId && maybeB2b) {
      const client = graphqlClient || (typeof getOfflineGraphqlClient === 'function'
        ? await getOfflineGraphqlClient(shop)
        : null);
      if (client) {
        try {
          const data = await shopifyGraphql(
            client,
            ORDER_COMPANY_QUERY,
            { id: snap.orderId },
            'order company for rollup',
          );
          const lookedUp = snapshotFromGraphqlOrder(data?.order);
          if (lookedUp) {
            snap = {
              ...lookedUp,
              lines: snap.lines !== undefined ? snap.lines : lookedUp.lines,
            };
          }
        } catch (err) {
          console.warn('[company-metrics] webhook company lookup failed', err.message);
        }
      }
    }

    if (!snap.companyId) return { applied: false, reason: 'not-b2b' };

    await ensureReady();
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const result = await applySnapshot(db, shop, snap);
      await db.query('COMMIT');
      return { applied: result.changed, companyId: snap.companyId };
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }

  // Reduces a tracked order's revenue (and its day bucket) by the amount
  // actually refunded, without touching order_count or line-level rollups —
  // the order still happened, it just brought in less money. No-ops for an
  // order this shop never tracked (e.g. not a B2B company order), since it
  // can't have contributed to any commission in the first place.
  async function applyRefund(client, shop, orderId, refundAmount) {
    const { rows } = await client.query(
      `SELECT company_id, day, revenue FROM ${ORDER_TABLE} WHERE shop = $1 AND order_id = $2`,
      [shop, orderId],
    );
    const prev = rows[0];
    if (!prev || !prev.company_id) return { changed: false };
    const day = toDayString(prev.day);
    const currentRevenue = money(prev.revenue);
    const newRevenue = Math.max(0, money(currentRevenue - refundAmount));
    const delta = money(newRevenue - currentRevenue);
    if (delta === 0) return { changed: false };
    await client.query(
      `UPDATE ${ORDER_TABLE} SET revenue = $3, updated_at = now() WHERE shop = $1 AND order_id = $2`,
      [shop, orderId, newRevenue],
    );
    await bumpDay(client, shop, prev.company_id, day, 0, delta);
    return { changed: true };
  }

  // Money-only refunds (no line items returned) never change
  // current_total_price and often never even fire orders/updated for
  // third-party apps, so this is the only reliable signal for them. Refund
  // ids are recorded in ${REFUND_TABLE} so an at-least-once redelivery of the
  // same webhook can't double-subtract the same refund.
  async function ingestRefund(shopDomain, payload) {
    const shop = normalizeShop(shopDomain);
    const parsed = parseRefundPayload(payload);
    if (!shop || !parsed) return { applied: false, reason: 'invalid-payload' };
    if (parsed.amount <= 0) return { applied: false, reason: 'zero-amount' };

    await ensureReady();
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const inserted = await db.query(
        `INSERT INTO ${REFUND_TABLE} (shop, refund_id, order_id, amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (shop, refund_id) DO NOTHING
         RETURNING refund_id`,
        [shop, parsed.refundId, parsed.orderId, parsed.amount],
      );
      if (!inserted.rows.length) {
        await db.query('ROLLBACK');
        return { applied: false, reason: 'duplicate' };
      }
      const result = await applyRefund(db, shop, parsed.orderId, parsed.amount);
      await db.query('COMMIT');
      return { applied: result.changed, orderId: parsed.orderId };
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }

  async function claimBackfill(shop, { rebuild } = {}) {
    await ensureReady();
    if (rebuild) {
      await pool.query(`DELETE FROM ${LINE_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(`DELETE FROM ${PRODUCT_DAY_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(`DELETE FROM ${ORDER_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(`DELETE FROM ${DAY_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(
        `INSERT INTO ${META_TABLE} (shop, backfill_status, backfill_cursor, backfill_error, ingested_orders, backfill_started_at, product_backfill_status, product_backfill_cursor, backfill_version, backfill_window_started_at)
         VALUES ($1, 'running', NULL, NULL, 0, now(), 'running', NULL, $2, now())
         ON CONFLICT (shop) DO UPDATE SET
           backfill_status = 'running',
           backfill_cursor = NULL,
           backfill_error = NULL,
           ingested_orders = 0,
           backfill_started_at = now(),
           product_backfill_status = 'running',
           product_backfill_cursor = NULL,
           backfill_version = EXCLUDED.backfill_version,
           backfill_window_started_at = now()`,
        [shop, BACKFILL_CURSOR_VERSION],
      );
      return { claimed: true, cursor: null, ingested: 0 };
    }

    const { rows } = await pool.query(
      `INSERT INTO ${META_TABLE} (shop, backfill_status, backfill_started_at, ingested_orders, backfill_version, backfill_window_started_at)
       VALUES ($1, 'running', now(), 0, $2, now())
       ON CONFLICT (shop) DO UPDATE SET
         backfill_status = 'running',
         backfill_started_at = now(),
         backfill_cursor = CASE
           WHEN COALESCE(${META_TABLE}.backfill_version, 0) < $2 THEN NULL
           ELSE ${META_TABLE}.backfill_cursor
         END,
         ingested_orders = CASE
           WHEN COALESCE(${META_TABLE}.backfill_version, 0) < $2 THEN 0
           ELSE ${META_TABLE}.ingested_orders
         END,
         backfill_version = GREATEST(COALESCE(${META_TABLE}.backfill_version, 0), $2),
         backfill_window_started_at = CASE
           WHEN COALESCE(${META_TABLE}.backfill_version, 0) < $2 THEN now()
           ELSE COALESCE(${META_TABLE}.backfill_window_started_at, now())
         END
       WHERE (
           ${META_TABLE}.backfill_status IS DISTINCT FROM 'complete'
           OR COALESCE(${META_TABLE}.backfill_version, 0) < $2
         )
         AND (
           ${META_TABLE}.backfill_status IS DISTINCT FROM 'running'
           OR ${META_TABLE}.backfill_started_at < now() - interval '3 minutes'
         )
       RETURNING backfill_cursor, ingested_orders, backfill_status`,
      [shop, BACKFILL_CURSOR_VERSION],
    );
    if (!rows[0]) {
      const meta = await loadMeta(shop);
      return {
        claimed: false,
        ready: meta?.backfill_status === 'complete'
          && (meta.backfill_version || 0) >= BACKFILL_CURSOR_VERSION,
        status: meta?.backfill_status || 'pending',
      };
    }
    return { claimed: true, cursor: rows[0].backfill_cursor || null, ingested: rows[0].ingested_orders || 0 };
  }

  async function backfillChunk(shopDomain, graphqlClient, options = {}) {
    const shop = normalizeShop(shopDomain);
    if (!shop || !graphqlClient) return { enabled: true, ready: false };
    const maxPages = Math.max(1, options.maxPages || 6);
    const orderPageSize = Math.min(100, Math.max(10, options.pageSize || 50));
    const maxMs = options.maxMs || 18000;
    const started = Date.now();

    const claim = await claimBackfill(shop, { rebuild: Boolean(options.rebuild) });
    if (!claim.claimed) {
      return { enabled: true, ready: Boolean(claim.ready), status: claim.status, ingested: 0 };
    }

    let cursor = parseBackfillCursor(claim.cursor);
    let ingested = claim.ingested || 0;
    let pages = 0;
    let complete = false;

    async function ingestNodes(nodes, companyIdHint) {
      const snaps = nodesInHistoricalRange(nodes)
        .map((node) => snapshotFromGraphqlOrder(node, companyIdHint))
        .filter((snap) => snap?.companyId);
      if (!snaps.length) return 0;
      const db = await pool.connect();
      let added = 0;
      try {
        await db.query('BEGIN');
        for (const snap of snaps) {
          const result = await applySnapshot(db, shop, snap);
          if (result.changed) added += 1;
        }
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      } finally {
        db.release();
      }
      return added;
    }

    function noteProgress() {
      if (typeof options.onProgress !== 'function') return;
      options.onProgress({
        phase: 'rollup',
        done: ingested,
        total: ingested + (complete ? 0 : orderPageSize),
        label: 'Building order rollup',
      });
    }

    let matched = null;
    try {
      while (pages < maxPages && Date.now() - started < maxMs) {
        const data = await shopifyGraphql(
          graphqlClient,
          BACKFILL_ORDERS_QUERY,
          {
            first: orderPageSize,
            after: cursor.ordersAfter,
            search: historicalSearchQuery(cursor.status),
          },
          'company metric backfill orders',
        );
        if (matched == null && data?.ordersCount?.count != null) {
          matched = data.ordersCount.count;
        }
        const conn = data?.orders;
        const nodes = orderNodesFromConnection(conn);
        const added = await ingestNodes(nodes);
        ingested += added;
        pages += 1;
        console.log('[company-metrics] backfill page', {
          shop,
          status: cursor.status,
          search: historicalSearchQuery(cursor.status),
          matched,
          page: pages,
          returned: nodes.length,
          b2b: added,
          oldest: nodes[0]?.createdAt || null,
          newest: nodes[nodes.length - 1]?.createdAt || null,
        });
        noteProgress();

        if (!conn?.pageInfo?.hasNextPage) {
          const nextStatus = nextBackfillStatus(cursor.status);
          if (!nextStatus) {
            complete = true;
            break;
          }
          cursor.status = nextStatus;
          cursor.ordersAfter = null;
          continue;
        }
        cursor.ordersAfter = conn.pageInfo.endCursor;
      }

      if (complete) {
        const coverage = await orderCoverage(shop);
        const oldestMs = coverage.oldest ? new Date(coverage.oldest).getTime() : NaN;
        const cutoffMs = new Date(HISTORICAL_CUTOFF).getTime();
        // If Shopify still only returned the ~60-day window, the first
        // ingested order is months after 2025-01-01. Do not mark complete —
        // reset to the start so the next run (after read_all_orders lands)
        // actually pages 2025 instead of stopping on recent orders.
        if (Number.isFinite(oldestMs) && oldestMs > cutoffMs + 21 * 24 * 60 * 60 * 1000) {
          console.warn('[company-metrics] backfill missed historical cutoff; restarting from 2025-01-01', {
            shop,
            oldest: coverage.oldest,
            cutoff: HISTORICAL_CUTOFF,
          });
          complete = false;
          cursor = emptyOrdersCursor();
        }
      }

      if (complete) {
        const counted = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${ORDER_TABLE} WHERE shop = $1`,
          [shop],
        );
        ingested = counted.rows[0]?.n || ingested;
      }

      await pool.query(
        `UPDATE ${META_TABLE}
         SET backfill_status = $2,
             backfill_cursor = $3,
             backfill_error = NULL,
             ingested_orders = $4,
             last_backfill_at = now(),
             backfill_version = $5,
             product_backfill_status = CASE WHEN $2 = 'complete' THEN 'complete' ELSE product_backfill_status END,
             product_backfill_cursor = CASE WHEN $2 = 'complete' THEN NULL ELSE product_backfill_cursor END
         WHERE shop = $1`,
        [
          shop,
          complete ? 'complete' : 'pending',
          complete ? null : serializeBackfillCursor(cursor),
          ingested,
          BACKFILL_CURSOR_VERSION,
        ],
      );

      return {
        enabled: true,
        ready: complete,
        status: complete ? 'complete' : 'pending',
        ingested,
        pages,
        matched,
        search: historicalSearchQuery(cursor.status),
      };
    } catch (err) {
      await pool.query(
        `UPDATE ${META_TABLE}
         SET backfill_status = 'error', backfill_error = $2, last_backfill_at = now()
         WHERE shop = $1`,
        [shop, err.message],
      );
      throw err;
    }
  }

  async function sumJobs(shopDomain, jobs) {
    const shop = normalizeShop(shopDomain);
    if (!shop || !jobs.length) return new Map();
    await ensureReady();

    const companyIds = jobs.map((job) => job.companyId);
    const sinces = jobs.map((job) => job.sinceIso || '1970-01-01T00:00:00.000Z');
    const untils = jobs.map((job) => job.untilIso || '9999-12-31T23:59:59.999Z');

    const { rows } = await pool.query(
      `WITH jobs(company_id, since_at, until_at) AS (
         SELECT * FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[])
       )
       SELECT j.company_id,
              COALESCE(SUM(o.revenue), 0) AS revenue,
              COUNT(o.order_id)::int AS order_count,
              MAX(o.created_at) AS last_order_date
       FROM jobs j
       LEFT JOIN ${ORDER_TABLE} o
         ON o.shop = $1
        AND o.company_id = j.company_id
        AND o.created_at >= j.since_at
        AND (j.until_at IS NULL OR o.created_at <= j.until_at)
       GROUP BY j.company_id`,
      [shop, companyIds, sinces, untils],
    );

    const map = new Map();
    for (const row of rows) {
      map.set(row.company_id, {
        totalSpend: money(row.revenue),
        orderCount: row.order_count || 0,
        lastOrderDate: row.last_order_date
          ? new Date(row.last_order_date).toISOString()
          : null,
      });
    }
    return map;
  }

  async function revenueByDay(shopDomain, startDate, endDate) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return [];
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT day::text AS day,
              SUM(order_count)::int AS order_count,
              SUM(revenue) AS revenue
       FROM ${DAY_TABLE}
       WHERE shop = $1
         AND ($2::date IS NULL OR day >= $2::date)
         AND ($3::date IS NULL OR day <= $3::date)
       GROUP BY day
       ORDER BY day`,
      [shop, startDate || null, endDate || null],
    );
    return rows.map((row) => ({
      date: toDayString(row.day),
      orders: row.order_count || 0,
      revenue: money(row.revenue),
    }));
  }

  async function backfillProductChunk(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop || !(await isReady(shop))) {
      return { enabled: true, ready: false };
    }
    if (await hasProductLines(shop)) {
      await pool.query(
        `UPDATE ${META_TABLE} SET product_backfill_status = 'complete', product_backfill_cursor = NULL WHERE shop = $1`,
        [shop],
      );
      return { enabled: true, ready: true, status: 'complete' };
    }
    return { enabled: true, ready: false, status: 'pending' };
  }

  async function shopRangeTotals(shopDomain, startIso, endIso) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return { revenue: 0, orderCount: 0, activeCompanies: 0 };
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(revenue), 0) AS revenue,
              COUNT(*)::int AS order_count,
              COUNT(DISTINCT company_id)::int AS active_companies
       FROM ${ORDER_TABLE}
       WHERE shop = $1
         AND company_id IS NOT NULL
         AND created_at >= $2::timestamptz
         AND created_at <= $3::timestamptz`,
      [shop, startIso || '1970-01-01T00:00:00.000Z', endIso || '9999-12-31T23:59:59.999Z'],
    );
    return {
      revenue: money(rows[0]?.revenue),
      orderCount: rows[0]?.order_count || 0,
      activeCompanies: rows[0]?.active_companies || 0,
    };
  }

  async function orderCoverage(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return { oldest: null, newest: null, orderCount: 0 };
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT MIN(created_at) AS oldest,
              MAX(created_at) AS newest,
              COUNT(*)::int AS order_count
       FROM ${ORDER_TABLE}
       WHERE shop = $1 AND company_id IS NOT NULL`,
      [shop],
    );
    return {
      oldest: rows[0]?.oldest ? new Date(rows[0].oldest).toISOString() : null,
      newest: rows[0]?.newest ? new Date(rows[0].newest).toISOString() : null,
      orderCount: rows[0]?.order_count || 0,
    };
  }

  async function companiesRange(shopDomain, startIso, endIso) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return new Map();
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT company_id,
              COALESCE(SUM(CASE
                WHEN created_at >= $2::timestamptz AND created_at <= $3::timestamptz THEN revenue
                ELSE 0 END), 0) AS revenue,
              COUNT(*) FILTER (
                WHERE created_at >= $2::timestamptz AND created_at <= $3::timestamptz
              )::int AS order_count,
              MAX(created_at) AS last_order_date
       FROM ${ORDER_TABLE}
       WHERE shop = $1 AND company_id IS NOT NULL
       GROUP BY company_id`,
      [shop, startIso || '1970-01-01T00:00:00.000Z', endIso || '9999-12-31T23:59:59.999Z'],
    );
    const map = new Map();
    for (const row of rows) {
      const lastOrderDate = row.last_order_date ? new Date(row.last_order_date).toISOString() : null;
      map.set(row.company_id, {
        totalSpend: money(row.revenue),
        orderCount: row.order_count || 0,
        lastOrderDate,
        daysSinceLastOrder: lastOrderDate
          ? Math.floor((Date.now() - new Date(lastOrderDate).getTime()) / (1000 * 60 * 60 * 24))
          : null,
      });
    }
    return map;
  }

  async function companyRange(shopDomain, companyId, startIso, endIso) {
    const shop = normalizeShop(shopDomain);
    const id = normalizeCompanyId(companyId) || companyId;
    if (!shop || !id) return { revenue: 0, orderCount: 0, lastOrderDate: null, days: [] };
    await ensureReady();
    const [totals, days] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(CASE
                  WHEN created_at >= $3::timestamptz AND created_at <= $4::timestamptz THEN revenue
                  ELSE 0 END), 0) AS revenue,
                COUNT(*) FILTER (
                  WHERE created_at >= $3::timestamptz AND created_at <= $4::timestamptz
                )::int AS order_count,
                MAX(created_at) AS last_order_date
         FROM ${ORDER_TABLE}
         WHERE shop = $1 AND company_id = $2`,
        [shop, id, startIso || '1970-01-01T00:00:00.000Z', endIso || '9999-12-31T23:59:59.999Z'],
      ),
      pool.query(
        `SELECT day::text AS day, order_count, revenue
         FROM ${DAY_TABLE}
         WHERE shop = $1 AND company_id = $2
           AND ($3::date IS NULL OR day >= $3::date)
           AND ($4::date IS NULL OR day <= $4::date)
         ORDER BY day`,
        [shop, id, startIso ? startIso.slice(0, 10) : null, endIso ? endIso.slice(0, 10) : null],
      ),
    ]);
    const row = totals.rows[0] || {};
    const lastOrderDate = row.last_order_date ? new Date(row.last_order_date).toISOString() : null;
    return {
      revenue: money(row.revenue),
      orderCount: row.order_count || 0,
      lastOrderDate,
      daysSinceLastOrder: lastOrderDate
        ? Math.floor((Date.now() - new Date(lastOrderDate).getTime()) / (1000 * 60 * 60 * 24))
        : null,
      days: days.rows.map((d) => ({
        date: toDayString(d.day),
        orders: d.order_count || 0,
        revenue: money(d.revenue),
      })),
    };
  }

  async function productsRange(shopDomain, startIso, endIso) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return [];
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT product_id,
              MAX(title) AS title,
              SUM(units_sold)::int AS units_sold,
              SUM(revenue) AS revenue
       FROM ${PRODUCT_DAY_TABLE}
       WHERE shop = $1
         AND ($2::date IS NULL OR day >= $2::date)
         AND ($3::date IS NULL OR day <= $3::date)
       GROUP BY product_id
       ORDER BY SUM(revenue) DESC`,
      [shop, startIso ? startIso.slice(0, 10) : null, endIso ? endIso.slice(0, 10) : null],
    );
    return rows.map((row) => {
      const revenue = money(row.revenue);
      const unitsSold = row.units_sold || 0;
      return {
        id: row.product_id,
        title: row.title || 'Untitled',
        revenue,
        quantitySold: unitsSold,
        unitsSold,
        avgUnitPrice: unitsSold > 0 ? money(revenue / unitsSold) : 0,
        orderCount: 0,
        currencyCode: 'USD',
      };
    });
  }

  async function shopsNeedingBackfill() {
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT shop FROM ${META_TABLE}
       WHERE backfill_status IS DISTINCT FROM 'complete'
          OR COALESCE(backfill_version, 0) < $1
       ORDER BY last_backfill_at NULLS FIRST`,
      [BACKFILL_CURSOR_VERSION],
    );
    return rows.map((row) => row.shop).filter(Boolean);
  }

  async function rebuild(shopDomain, graphqlClient, options = {}) {
    return backfillChunk(shopDomain, graphqlClient, { ...options, rebuild: true });
  }

  return {
    enabled: true,
    isReady,
    isComplete,
    isProductsReady,
    status,
    ingestWebhook,
    ingestRefund,
    backfillChunk,
    backfillProductChunk,
    shopsNeedingBackfill,
    sumJobs,
    shopRangeTotals,
    orderCoverage,
    backfillProgress,
    companiesRange,
    companyRange,
    productsRange,
    revenueByDay,
    rebuild,
  };
}

function configureCompanyMetrics({ isProduction, getOfflineGraphqlClient } = {}) {
  const postgresUrl = resolvePostgresUrl();
  if (!postgresUrl) return disabledStore();
  return createPostgresMetricsStore(postgresUrl, isProduction, { getOfflineGraphqlClient });
}

module.exports = {
  configureCompanyMetrics,
  normalizeShop,
  normalizeCompanyId,
  parseOrderPayload,
  snapshotFromGraphqlOrder,
  utcDay,
  money,
  estimateBackfillProgress,
  decodeOrdersCursorTime,
};
