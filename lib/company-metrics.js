'use strict';

const { Pool } = require('pg');
const { resolvePostgresUrl } = require('./configure-session-storage');
const { shopifyGraphql } = require('./shopify-gql');
const {
  normalizeCompanyId,
  normalizeCustomerId,
  resolveCompanyFromContacts,
  resolveCheckoutChannel,
  CHECKOUT_CHANNEL_COMPANY,
  CHECKOUT_CHANNEL_CONTACT,
} = require('./order-attribution');

const ORDER_TABLE = 'company_metric_order';
const DAY_TABLE = 'company_metric_day';
const LINE_TABLE = 'company_metric_line';
const PRODUCT_DAY_TABLE = 'company_metric_product_day';
const META_TABLE = 'company_metric_meta';
const REFUND_TABLE = 'company_metric_refund';
const CONTACT_TABLE = 'company_metric_contact';

// Shopify only returns ~60 days of orders unless the app has `read_all_orders`.
// `read_orders` plus a created_at search is not enough — counts look large but
// the connection still starts at the 60-day window. After that scope is granted,
// closed orders since HISTORICAL_CUTOFF are paged oldest-first, then open and
// cancelled.
//
// Company checkout (purchasingEntity PurchasingCompany) is attributed directly.
// Wholesale contacts often check out as a regular Customer instead — those
// orders are attributed to the contact's B2B company when the link is
// unambiguous (single company, or a single isMainContact company). Pure DTC
// buyers with no companyContactProfiles are skipped.
const HISTORICAL_CUTOFF = '2025-01-01T00:00:00.000Z';
const HISTORICAL_ORDER_SEARCH = "created_at:>='2025-01-01'";
const BACKFILL_STATUSES = ['closed', 'open', 'cancelled'];
const BACKFILL_CURSOR_VERSION = 9;

const CUSTOMER_COMPANY_CONTACTS = `
  id
  companyContactProfiles {
    isMainContact
    company {
      id
    }
  }
`;

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
  customer {
    ${CUSTOMER_COMPANY_CONTACTS}
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

// ordersCount is only read once per run (for the progress log), but it is a
// full matching-set count that Shopify charges for on every request it appears
// in. Gate it behind a directive so a several-hundred-page run pays for it once
// instead of once per page.
const BACKFILL_ORDERS_QUERY = `
  query BackfillB2bOrders($first: Int!, $after: String, $search: String!, $withCount: Boolean!) {
    ordersCount(query: $search) @include(if: $withCount) {
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
      customer {
        ${CUSTOMER_COMPANY_CONTACTS}
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

const CUSTOMER_COMPANIES_QUERY = `
  query CustomerCompanies($id: ID!) {
    customer(id: $id) {
      ${CUSTOMER_COMPANY_CONTACTS}
    }
  }
`;

const COMPANIES_CONTACTS_QUERY = `
  query CompaniesContactsForRollup($first: Int!, $after: String) {
    companies(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        contacts(first: 50) {
          nodes {
            isMainContact
            customer {
              id
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
  const companyId = normalizeCompanyId(
    payload.company?.admin_graphql_api_id
    || payload.company?.id
    || payload.company_id
    || payload.purchasing_entity?.company?.admin_graphql_api_id
    || payload.purchasing_entity?.company?.id
    || payload.purchasingEntity?.company?.id,
  );
  return {
    orderId,
    companyId,
    customerId: normalizeCustomerId(
      payload.customer?.admin_graphql_api_id
      || payload.customer?.id
      || payload.customer_id
      || payload.user_id,
    ),
    checkoutChannel: companyId ? CHECKOUT_CHANNEL_COMPANY : null,
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
  const fromCustomer = resolveCompanyFromContacts(node.customer?.companyContactProfiles);
  const companyId = fromEntity || normalizeCompanyId(companyIdHint) || fromCustomer;
  const customerId = normalizeCustomerId(node.customer?.id);
  return {
    orderId: node.id,
    companyId,
    customerId,
    checkoutChannel: resolveCheckoutChannel({
      fromPurchasingCompany: Boolean(fromEntity),
      companyId,
    }),
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
const ETA_HORIZON_SECONDS = 12 * 3600;

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
    // This extrapolates from wall-clock elapsed, so any period where the
    // backfill was not actually running drags the estimate toward infinity.
    // Clamping past that point reported a confident "72 hours left" that never
    // moved; report no estimate instead so the banner just shows percent done.
    if (etaSeconds > ETA_HORIZON_SECONDS) etaSeconds = null;
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
    async companyRange() {
      return {
        revenue: 0,
        orderCount: 0,
        contactCheckoutOrderCount: 0,
        contactCheckoutRevenue: 0,
        companyCheckoutOrderCount: 0,
        hasContactCheckout: false,
        lastOrderDate: null,
        days: [],
      };
    },
    async companyProductsRange() { return []; },
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

// One statement for every product touched on a given day, instead of one per
// line item. Deltas for the same product must be summed here rather than sent
// as separate rows: ON CONFLICT DO UPDATE refuses to touch the same row twice
// within a single command, and an order routinely repeats a product across
// lines. Round trips dominate the cost of a backfill page — a 20-line order
// went from ~40 statements to 2, which is what keeps a full page inside the
// pool's 25s query timeout.
async function bumpProductDays(client, shop, day, deltas) {
  if (!day || !deltas.length) return;
  const merged = new Map();
  for (const delta of deltas) {
    if (!delta.productId) continue;
    const current = merged.get(delta.productId);
    if (current) {
      current.units += delta.units;
      current.revenue = money(current.revenue + delta.revenue);
      if (!current.title && delta.title) current.title = delta.title;
    } else {
      merged.set(delta.productId, {
        productId: delta.productId,
        title: delta.title || null,
        units: delta.units,
        revenue: money(delta.revenue),
      });
    }
  }
  const rows = [...merged.values()].filter((row) => row.units || row.revenue);
  if (!rows.length) return;
  await client.query(
    `INSERT INTO ${PRODUCT_DAY_TABLE} (shop, product_id, day, units_sold, revenue, title)
     SELECT $1, p.product_id, $2::date, p.units, p.revenue, p.title
     FROM unnest($3::text[], $4::int[], $5::numeric[], $6::text[])
       AS p(product_id, units, revenue, title)
     ON CONFLICT (shop, product_id, day) DO UPDATE SET
       units_sold = ${PRODUCT_DAY_TABLE}.units_sold + EXCLUDED.units_sold,
       revenue = ${PRODUCT_DAY_TABLE}.revenue + EXCLUDED.revenue,
       title = COALESCE(EXCLUDED.title, ${PRODUCT_DAY_TABLE}.title),
       updated_at = now()`,
    [
      shop,
      day,
      rows.map((row) => row.productId),
      rows.map((row) => row.units),
      rows.map((row) => row.revenue),
      rows.map((row) => row.title),
    ],
  );
}

async function replaceLines(client, shop, orderId, prevDay, nextDay, lines) {
  const { rows: prev } = await client.query(
    `SELECT product_id, title, quantity, revenue FROM ${LINE_TABLE} WHERE shop = $1 AND order_id = $2`,
    [shop, orderId],
  );
  if (prevDay && prev.length) {
    await bumpProductDays(client, shop, prevDay, prev.map((row) => ({
      productId: row.product_id,
      title: row.title,
      units: -row.quantity,
      revenue: -money(row.revenue),
    })));
  }
  await client.query(`DELETE FROM ${LINE_TABLE} WHERE shop = $1 AND order_id = $2`, [shop, orderId]);
  if (!nextDay || !Array.isArray(lines) || !lines.length) return;
  const unique = new Map();
  for (const line of lines) unique.set(line.lineId, line);
  const next = [...unique.values()];
  await client.query(
    `INSERT INTO ${LINE_TABLE} (shop, order_id, line_id, product_id, title, quantity, revenue)
     SELECT $1, $2, l.line_id, l.product_id, l.title, l.quantity, l.revenue
     FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::numeric[])
       AS l(line_id, product_id, title, quantity, revenue)
     ON CONFLICT (shop, order_id, line_id) DO UPDATE SET
       product_id = EXCLUDED.product_id,
       title = EXCLUDED.title,
       quantity = EXCLUDED.quantity,
       revenue = EXCLUDED.revenue`,
    [
      shop,
      orderId,
      next.map((line) => line.lineId),
      next.map((line) => line.productId),
      next.map((line) => line.title),
      next.map((line) => line.quantity),
      next.map((line) => money(line.revenue)),
    ],
  );
  await bumpProductDays(client, shop, nextDay, next.map((line) => ({
    productId: line.productId,
    title: line.title,
    units: line.quantity,
    revenue: money(line.revenue),
  })));
}

async function applySnapshot(client, shop, snap) {
  const day = utcDay(snap.createdAt);
  if (!day) return { changed: false };

  const { rows } = await client.query(
    `SELECT company_id, day, revenue, checkout_channel FROM ${ORDER_TABLE} WHERE shop = $1 AND order_id = $2`,
    [shop, snap.orderId],
  );
  const prev = rows[0];
  const prevCompany = prev?.company_id || null;
  const prevDay = toDayString(prev?.day);
  const prevRevenue = prev ? money(prev.revenue) : 0;
  const prevChannel = prev?.checkout_channel || CHECKOUT_CHANNEL_COMPANY;
  // A cancelled order is treated exactly like one with no company at all —
  // fully removed from the ledger (revenue, order count, and line rollups) —
  // so it can never contribute to a rep's commission or the analytics KPIs.
  const nextCompany = snap.cancelled ? null : (snap.companyId || null);
  const nextChannel = nextCompany
    ? (snap.checkoutChannel === CHECKOUT_CHANNEL_CONTACT
      ? CHECKOUT_CHANNEL_CONTACT
      : CHECKOUT_CHANNEL_COMPANY)
    : null;
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
    prev
    && prevCompany === nextCompany
    && prevDay === day
    && prevRevenue === nextRevenue
    && prevChannel === nextChannel,
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
      `INSERT INTO ${ORDER_TABLE} (shop, order_id, company_id, created_at, day, revenue, checkout_channel)
       VALUES ($1, $2, $3, $4::timestamptz, $5::date, $6, $7)
       ON CONFLICT (shop, order_id) DO UPDATE SET
         company_id = EXCLUDED.company_id,
         created_at = EXCLUDED.created_at,
         day = EXCLUDED.day,
         revenue = EXCLUDED.revenue,
         checkout_channel = EXCLUDED.checkout_channel,
         updated_at = now()`,
      [shop, snap.orderId, nextCompany, snap.createdAt, day, nextRevenue, nextChannel],
    );
  }

  if (lines !== undefined && nextCompany) {
    await replaceLines(client, shop, snap.orderId, prevDay || day, day, lines);
  }
  return { changed: true };
}

// Bulk equivalent of calling applySnapshot() once per order. Backfill pages
// can carry 100 orders with 20 line items each, and applySnapshot's per-row
// awaited round trips (lookup, refund netting, day bump x2, upsert, line
// lookup/delete/insert) made a single page cost 1000+ serialized DB round
// trips. This pre-computes the same deltas in memory from a handful of bulk
// SELECTs, then applies them with a handful of unnest()-based bulk writes.
// Only used by the historical backfill path — live webhook/refund ingestion
// still goes through applySnapshot() per order, unchanged.
async function applySnapshotsBatch(client, shop, snaps) {
  const byOrderId = new Map();
  for (const snap of snaps) {
    const day = utcDay(snap?.createdAt);
    if (!snap?.orderId || !day) continue;
    byOrderId.set(snap.orderId, { ...snap, day });
  }
  if (!byOrderId.size) return 0;
  const orderIds = [...byOrderId.keys()];

  const [{ rows: prevOrders }, { rows: refundRows }, { rows: prevLines }] = await Promise.all([
    client.query(
      `SELECT order_id, company_id, day, revenue, checkout_channel FROM ${ORDER_TABLE} WHERE shop = $1 AND order_id = ANY($2::text[])`,
      [shop, orderIds],
    ),
    client.query(
      `SELECT order_id, COALESCE(SUM(amount), 0) AS refunded FROM ${REFUND_TABLE}
       WHERE shop = $1 AND order_id = ANY($2::text[]) GROUP BY order_id`,
      [shop, orderIds],
    ),
    client.query(
      `SELECT order_id, product_id, title, quantity, revenue FROM ${LINE_TABLE}
       WHERE shop = $1 AND order_id = ANY($2::text[])`,
      [shop, orderIds],
    ),
  ]);

  const prevByOrderId = new Map(prevOrders.map((r) => [r.order_id, r]));
  const refundByOrderId = new Map(refundRows.map((r) => [r.order_id, money(r.refunded)]));
  const prevLinesByOrderId = new Map();
  for (const row of prevLines) {
    if (!prevLinesByOrderId.has(row.order_id)) prevLinesByOrderId.set(row.order_id, []);
    prevLinesByOrderId.get(row.order_id).push(row);
  }

  const dayDeltas = new Map();
  const productDayDeltas = new Map();
  const orderDeletes = [];
  const orderUpserts = [];
  const lineDeleteOrderIds = [];
  const lineInserts = [];
  let changedCount = 0;

  function bumpDayDelta(companyId, day, orderDelta, revenueDelta) {
    if (!companyId || !day || (!orderDelta && !revenueDelta)) return;
    const key = `${companyId}|${day}`;
    const cur = dayDeltas.get(key) || { companyId, day, orderDelta: 0, revenueDelta: 0 };
    cur.orderDelta += orderDelta;
    cur.revenueDelta += revenueDelta;
    dayDeltas.set(key, cur);
  }

  function bumpProductDayDelta(productId, day, title, unitDelta, revenueDelta) {
    if (!productId || !day || (!unitDelta && !revenueDelta)) return;
    const key = `${productId}|${day}`;
    const cur = productDayDeltas.get(key) || { productId, day, title: null, unitDelta: 0, revenueDelta: 0 };
    cur.unitDelta += unitDelta;
    cur.revenueDelta += revenueDelta;
    if (title) cur.title = title;
    productDayDeltas.set(key, cur);
  }

  for (const [orderId, snap] of byOrderId) {
    const day = snap.day;
    const prev = prevByOrderId.get(orderId);
    const prevCompany = prev?.company_id || null;
    const prevDay = prev ? toDayString(prev.day) : null;
    const prevRevenue = prev ? money(prev.revenue) : 0;
    const prevChannel = prev?.checkout_channel || CHECKOUT_CHANNEL_COMPANY;
    const nextCompany = snap.cancelled ? null : (snap.companyId || null);
    const nextChannel = nextCompany
      ? (snap.checkoutChannel === CHECKOUT_CHANNEL_CONTACT
        ? CHECKOUT_CHANNEL_CONTACT
        : CHECKOUT_CHANNEL_COMPANY)
      : null;
    let nextRevenue = money(snap.revenue);
    if (nextCompany) {
      const refunded = refundByOrderId.get(orderId) || 0;
      if (refunded > 0) nextRevenue = Math.max(0, money(nextRevenue - refunded));
    }
    const lines = snap.lines;
    const orderUnchanged = Boolean(
      prev
      && prevCompany === nextCompany
      && prevDay === day
      && prevRevenue === nextRevenue
      && prevChannel === nextChannel,
    );

    if (orderUnchanged && lines === undefined) continue;

    if (!orderUnchanged) {
      if (prevCompany && prevDay) bumpDayDelta(prevCompany, prevDay, -1, -prevRevenue);

      if (!nextCompany) {
        if (prev) { orderDeletes.push(orderId); changedCount += 1; }
        if (lines !== undefined) {
          if (lines.length && !prev) changedCount += 1;
          lineDeleteOrderIds.push(orderId);
          const existing = prevLinesByOrderId.get(orderId) || [];
          if (prevDay) {
            for (const row of existing) {
              bumpProductDayDelta(row.product_id, prevDay, row.title, -row.quantity, -money(row.revenue));
            }
          }
        }
        continue;
      }

      bumpDayDelta(nextCompany, day, 1, nextRevenue);
      orderUpserts.push({
        orderId,
        companyId: nextCompany,
        createdAt: snap.createdAt,
        day,
        revenue: nextRevenue,
        checkoutChannel: nextChannel,
      });
      changedCount += 1;
    }

    if (lines !== undefined && nextCompany) {
      const lineFromDay = prevDay || day;
      lineDeleteOrderIds.push(orderId);
      const existing = prevLinesByOrderId.get(orderId) || [];
      for (const row of existing) {
        bumpProductDayDelta(row.product_id, lineFromDay, row.title, -row.quantity, -money(row.revenue));
      }
      for (const line of lines) {
        lineInserts.push({
          orderId,
          lineId: line.lineId,
          productId: line.productId,
          title: line.title,
          quantity: line.quantity,
          revenue: money(line.revenue),
        });
        bumpProductDayDelta(line.productId, day, line.title, line.quantity, money(line.revenue));
      }
    }
  }

  if (orderDeletes.length) {
    await client.query(`DELETE FROM ${ORDER_TABLE} WHERE shop = $1 AND order_id = ANY($2::text[])`, [shop, orderDeletes]);
  }

  if (orderUpserts.length) {
    await client.query(
      `INSERT INTO ${ORDER_TABLE} (shop, order_id, company_id, created_at, day, revenue, checkout_channel)
       SELECT $1, u.order_id, u.company_id, u.created_at::timestamptz, u.day::date, u.revenue, u.checkout_channel
       FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::date[], $6::numeric[], $7::text[])
         AS u(order_id, company_id, created_at, day, revenue, checkout_channel)
       ON CONFLICT (shop, order_id) DO UPDATE SET
         company_id = EXCLUDED.company_id,
         created_at = EXCLUDED.created_at,
         day = EXCLUDED.day,
         revenue = EXCLUDED.revenue,
         checkout_channel = EXCLUDED.checkout_channel,
         updated_at = now()`,
      [
        shop,
        orderUpserts.map((o) => o.orderId),
        orderUpserts.map((o) => o.companyId),
        orderUpserts.map((o) => o.createdAt),
        orderUpserts.map((o) => o.day),
        orderUpserts.map((o) => o.revenue),
        orderUpserts.map((o) => o.checkoutChannel || CHECKOUT_CHANNEL_COMPANY),
      ],
    );
  }

  if (dayDeltas.size) {
    const deltas = [...dayDeltas.values()];
    await client.query(
      `INSERT INTO ${DAY_TABLE} (shop, company_id, day, order_count, revenue)
       SELECT $1, u.company_id, u.day::date, u.order_delta, u.revenue_delta
       FROM unnest($2::text[], $3::date[], $4::int[], $5::numeric[])
         AS u(company_id, day, order_delta, revenue_delta)
       ON CONFLICT (shop, company_id, day) DO UPDATE SET
         order_count = ${DAY_TABLE}.order_count + EXCLUDED.order_count,
         revenue = ${DAY_TABLE}.revenue + EXCLUDED.revenue,
         updated_at = now()`,
      [
        shop,
        deltas.map((d) => d.companyId),
        deltas.map((d) => d.day),
        deltas.map((d) => d.orderDelta),
        deltas.map((d) => d.revenueDelta),
      ],
    );
  }

  if (lineDeleteOrderIds.length) {
    await client.query(`DELETE FROM ${LINE_TABLE} WHERE shop = $1 AND order_id = ANY($2::text[])`, [shop, lineDeleteOrderIds]);
  }

  if (lineInserts.length) {
    await client.query(
      `INSERT INTO ${LINE_TABLE} (shop, order_id, line_id, product_id, title, quantity, revenue)
       SELECT $1, u.order_id, u.line_id, u.product_id, u.title, u.quantity, u.revenue
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::numeric[])
         AS u(order_id, line_id, product_id, title, quantity, revenue)
       ON CONFLICT (shop, order_id, line_id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         title = EXCLUDED.title,
         quantity = EXCLUDED.quantity,
         revenue = EXCLUDED.revenue`,
      [
        shop,
        lineInserts.map((l) => l.orderId),
        lineInserts.map((l) => l.lineId),
        lineInserts.map((l) => l.productId),
        lineInserts.map((l) => l.title),
        lineInserts.map((l) => l.quantity),
        lineInserts.map((l) => l.revenue),
      ],
    );
  }

  if (productDayDeltas.size) {
    const deltas = [...productDayDeltas.values()];
    await client.query(
      `INSERT INTO ${PRODUCT_DAY_TABLE} (shop, product_id, day, units_sold, revenue, title)
       SELECT $1, u.product_id, u.day::date, u.unit_delta, u.revenue_delta, u.title
       FROM unnest($2::text[], $3::date[], $4::int[], $5::numeric[], $6::text[])
         AS u(product_id, day, unit_delta, revenue_delta, title)
       ON CONFLICT (shop, product_id, day) DO UPDATE SET
         units_sold = ${PRODUCT_DAY_TABLE}.units_sold + EXCLUDED.units_sold,
         revenue = ${PRODUCT_DAY_TABLE}.revenue + EXCLUDED.revenue,
         title = COALESCE(EXCLUDED.title, ${PRODUCT_DAY_TABLE}.title),
         updated_at = now()`,
      [
        shop,
        deltas.map((d) => d.productId),
        deltas.map((d) => d.day),
        deltas.map((d) => d.unitDelta),
        deltas.map((d) => d.revenueDelta),
        deltas.map((d) => d.title),
      ],
    );
  }

  return changedCount;
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
        ALTER TABLE ${ORDER_TABLE} ADD COLUMN IF NOT EXISTS checkout_channel text NOT NULL DEFAULT 'company';
        CREATE INDEX IF NOT EXISTS idx_cmo_shop_company_channel
          ON ${ORDER_TABLE} (shop, company_id, checkout_channel);
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
        CREATE TABLE IF NOT EXISTS ${CONTACT_TABLE} (
          shop text NOT NULL,
          customer_id text NOT NULL,
          company_id text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (shop, customer_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cmc_shop_company
          ON ${CONTACT_TABLE} (shop, company_id);
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

  async function lookupContactCompany(shop, customerId) {
    const id = normalizeCustomerId(customerId);
    if (!shop || !id) return { found: false, companyId: null };
    const { rows } = await pool.query(
      `SELECT company_id FROM ${CONTACT_TABLE} WHERE shop = $1 AND customer_id = $2`,
      [shop, id],
    );
    if (!rows[0]) return { found: false, companyId: null };
    return { found: true, companyId: rows[0].company_id || null };
  }

  async function upsertContactCompany(shop, customerId, companyId) {
    const id = normalizeCustomerId(customerId);
    if (!shop || !id) return;
    await pool.query(
      `INSERT INTO ${CONTACT_TABLE} (shop, customer_id, company_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (shop, customer_id) DO UPDATE SET
         company_id = EXCLUDED.company_id,
         updated_at = now()`,
      [shop, id, normalizeCompanyId(companyId)],
    );
  }

  const CONTACT_MAP_FRESH_MS = 6 * 60 * 60 * 1000;

  async function contactMapIsFresh(shop) {
    const { rows } = await pool.query(
      `SELECT MAX(updated_at) AS refreshed_at, COUNT(*)::int AS n
       FROM ${CONTACT_TABLE} WHERE shop = $1`,
      [shop],
    );
    const count = rows[0]?.n || 0;
    const refreshedAt = rows[0]?.refreshed_at ? new Date(rows[0].refreshed_at).getTime() : NaN;
    return count > 0 && Number.isFinite(refreshedAt) && (Date.now() - refreshedAt) < CONTACT_MAP_FRESH_MS;
  }

  async function refreshContactMap(shop, graphqlClient) {
    if (!shop || !graphqlClient) return 0;
    await ensureReady();
    let after = null;
    let hasNextPage = true;
    /** @type {Map<string, { companyId: string, isMain: boolean }>} */
    const preferred = new Map();

    while (hasNextPage) {
      const data = await shopifyGraphql(
        graphqlClient,
        COMPANIES_CONTACTS_QUERY,
        { first: 50, after },
        'company contact map for rollup',
      );
      const conn = data?.companies;
      for (const company of conn?.nodes || []) {
        const companyId = normalizeCompanyId(company?.id);
        if (!companyId) continue;
        for (const contact of company.contacts?.nodes || []) {
          const customerId = normalizeCustomerId(contact?.customer?.id);
          if (!customerId) continue;
          const isMain = Boolean(contact.isMainContact);
          const existing = preferred.get(customerId);
          if (!existing) {
            preferred.set(customerId, { companyId, isMain });
            continue;
          }
          if (existing.companyId === companyId) {
            preferred.set(customerId, { companyId, isMain: existing.isMain || isMain });
            continue;
          }
          // Ambiguous multi-company contact: keep a main-contact company when
          // only one side is main; otherwise drop so we do not guess.
          if (isMain && !existing.isMain) {
            preferred.set(customerId, { companyId, isMain: true });
          } else if (isMain === existing.isMain) {
            preferred.delete(customerId);
          }
        }
      }
      hasNextPage = Boolean(conn?.pageInfo?.hasNextPage);
      after = conn?.pageInfo?.endCursor || null;
    }

    const customerIds = [...preferred.keys()];
    const companyIds = customerIds.map((id) => preferred.get(id).companyId);
    if (customerIds.length) {
      await pool.query(
        `INSERT INTO ${CONTACT_TABLE} (shop, customer_id, company_id, updated_at)
         SELECT $1, u.customer_id, u.company_id, now()
         FROM unnest($2::text[], $3::text[]) AS u(customer_id, company_id)
         ON CONFLICT (shop, customer_id) DO UPDATE SET
           company_id = EXCLUDED.company_id,
           updated_at = now()`,
        [shop, customerIds, companyIds],
      );
    }
    console.log('[company-metrics] refreshed contact map', { shop, contacts: customerIds.length });
    return customerIds.length;
  }

  async function resolveCompanyForWebhook(shop, snap, payload, graphqlClient) {
    if (snap.companyId) return snap;

    if (snap.customerId) {
      const mapped = await lookupContactCompany(shop, snap.customerId);
      if (mapped.found) {
        return mapped.companyId
          ? {
            ...snap,
            companyId: mapped.companyId,
            checkoutChannel: resolveCheckoutChannel({
              fromPurchasingCompany: false,
              companyId: mapped.companyId,
              existingChannel: snap.checkoutChannel,
            }),
          }
          : snap;
      }
    }

    const maybeB2b = Boolean(
      payload.company || payload.company_id || payload.purchasing_entity || payload.purchasingEntity,
    );
    const shouldLookup = Boolean(maybeB2b || snap.customerId);
    if (!shouldLookup) return snap;

    const client = graphqlClient || (typeof getOfflineGraphqlClient === 'function'
      ? await getOfflineGraphqlClient(shop)
      : null);
    if (!client) return snap;

    try {
      if (snap.orderId && (maybeB2b || snap.customerId)) {
        const data = await shopifyGraphql(
          client,
          ORDER_COMPANY_QUERY,
          { id: snap.orderId },
          'order company for rollup',
        );
        const lookedUp = snapshotFromGraphqlOrder(data?.order);
        if (lookedUp) {
          const next = {
            ...lookedUp,
            lines: snap.lines !== undefined ? snap.lines : lookedUp.lines,
            customerId: lookedUp.customerId || snap.customerId,
          };
          if (next.customerId) {
            await upsertContactCompany(shop, next.customerId, next.companyId || null);
          }
          return next;
        }
      }

      if (snap.customerId) {
        const data = await shopifyGraphql(
          client,
          CUSTOMER_COMPANIES_QUERY,
          { id: snap.customerId },
          'customer companies for rollup',
        );
        const companyId = resolveCompanyFromContacts(data?.customer?.companyContactProfiles);
        await upsertContactCompany(shop, snap.customerId, companyId);
        return companyId
          ? {
            ...snap,
            companyId,
            checkoutChannel: resolveCheckoutChannel({
              fromPurchasingCompany: false,
              companyId,
              existingChannel: snap.checkoutChannel,
            }),
          }
          : snap;
      }
    } catch (err) {
      console.warn('[company-metrics] webhook company lookup failed', err.message);
    }
    return snap;
  }

  async function ingestWebhook(shopDomain, payload, { graphqlClient } = {}) {
    const shop = normalizeShop(shopDomain);
    const parsed = parseOrderPayload(payload);
    if (!shop || !parsed) return { applied: false, reason: 'invalid-payload' };

    await ensureReady();
    const snap = await resolveCompanyForWebhook(shop, parsed, payload, graphqlClient);

    if (!snap.companyId) return { applied: false, reason: 'not-b2b' };

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

    // Rebuilding the company→customer map pages every B2B company before a
    // single order is saved. Doing that on every cron tick held the lease
    // without moving the order cursor, so the percent stayed put. The map is
    // a cache; order pages already carry companyContactProfiles.
    try {
      if (await contactMapIsFresh(shop)) {
        console.log('[company-metrics] contact map still fresh, skipping refresh', { shop });
      } else {
        await pool.query(
          `UPDATE ${META_TABLE} SET backfill_started_at = now() WHERE shop = $1`,
          [shop],
        );
        await refreshContactMap(shop, graphqlClient);
      }
    } catch (err) {
      console.warn('[company-metrics] contact map refresh failed', err.message);
    }

    let cursor = parseBackfillCursor(claim.cursor);
    let ingested = claim.ingested || 0;
    let pages = 0;
    let complete = false;

    async function ingestNodes(nodes, companyIdHint) {
      const snaps = [];
      const contactUpserts = new Map();
      for (const node of nodesInHistoricalRange(nodes)) {
        const customerId = normalizeCustomerId(node?.customer?.id);
        let hint = companyIdHint;
        if (!hint && customerId) {
          const profiles = node?.customer?.companyContactProfiles;
          const fromProfiles = resolveCompanyFromContacts(profiles);
          if (fromProfiles) {
            hint = fromProfiles;
          } else if (profiles == null) {
            const mapped = await lookupContactCompany(shop, customerId);
            if (mapped.found && mapped.companyId) hint = mapped.companyId;
          }
        }
        const snap = snapshotFromGraphqlOrder(node, hint);
        if (snap?.companyId) snaps.push(snap);
        if (snap?.customerId) {
          contactUpserts.set(snap.customerId, snap.companyId || null);
        }
      }
      if (contactUpserts.size) {
        const customerIds = [...contactUpserts.keys()];
        const companyIds = customerIds.map((id) => contactUpserts.get(id));
        await pool.query(
          `INSERT INTO ${CONTACT_TABLE} (shop, customer_id, company_id, updated_at)
           SELECT $1, u.customer_id, u.company_id, now()
           FROM unnest($2::text[], $3::text[]) AS u(customer_id, company_id)
           ON CONFLICT (shop, customer_id) DO UPDATE SET
             company_id = EXCLUDED.company_id,
             updated_at = now()`,
          [shop, customerIds, companyIds],
        );
      }
      if (!snaps.length) return 0;
      const db = await pool.connect();
      let added = 0;
      try {
        await db.query('BEGIN');
        added = await applySnapshotsBatch(db, shop, snaps);
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

    // The cursor has to be durable per page, not just at the end of the run.
    // On Vercel the invocation is frozen the moment a response is sent, so a
    // chunk that outruns the route's timeout guard never reaches the terminal
    // UPDATE below — the ingested order rows commit, but the cursor stays put
    // and the next run re-pages the exact same window forever. Checkpointing
    // also doubles as the lease heartbeat: refreshing backfill_started_at
    // keeps a long, healthy run from being stolen by the staleness check in
    // claimBackfill, while a run that dies still ages out within that window.
    async function checkpoint() {
      await pool.query(
        `UPDATE ${META_TABLE}
         SET backfill_cursor = $2,
             ingested_orders = $3,
             backfill_started_at = now(),
             last_backfill_at = now()
         WHERE shop = $1`,
        [shop, serializeBackfillCursor(cursor), ingested],
      );
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
            withCount: matched == null,
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
        // A run now spans hundreds of pages, so log a sample rather than every
        // page — per-page lines would dominate the function's log volume.
        if (pages === 1 || pages % 25 === 0) {
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
        }
        noteProgress();

        if (!conn?.pageInfo?.hasNextPage) {
          const nextStatus = nextBackfillStatus(cursor.status);
          if (!nextStatus) {
            complete = true;
            break;
          }
          cursor.status = nextStatus;
          cursor.ordersAfter = null;
          matched = null;
          await checkpoint();
          continue;
        }
        cursor.ordersAfter = conn.pageInfo.endCursor;
        await checkpoint();
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
              COUNT(*) FILTER (
                WHERE created_at >= $2::timestamptz
                  AND created_at <= $3::timestamptz
                  AND checkout_channel = 'contact'
              )::int AS contact_order_count,
              COALESCE(SUM(CASE
                WHEN created_at >= $2::timestamptz
                  AND created_at <= $3::timestamptz
                  AND checkout_channel = 'contact'
                THEN revenue ELSE 0 END), 0) AS contact_revenue,
              MAX(created_at) AS last_order_date
       FROM ${ORDER_TABLE}
       WHERE shop = $1 AND company_id IS NOT NULL
       GROUP BY company_id`,
      [shop, startIso || '1970-01-01T00:00:00.000Z', endIso || '9999-12-31T23:59:59.999Z'],
    );
    const map = new Map();
    for (const row of rows) {
      const lastOrderDate = row.last_order_date ? new Date(row.last_order_date).toISOString() : null;
      const contactOrderCount = row.contact_order_count || 0;
      map.set(row.company_id, {
        totalSpend: money(row.revenue),
        orderCount: row.order_count || 0,
        contactCheckoutOrderCount: contactOrderCount,
        contactCheckoutRevenue: money(row.contact_revenue),
        hasContactCheckout: contactOrderCount > 0,
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
    if (!shop || !id) {
      return {
        revenue: 0,
        orderCount: 0,
        contactCheckoutOrderCount: 0,
        contactCheckoutRevenue: 0,
        companyCheckoutOrderCount: 0,
        lastOrderDate: null,
        days: [],
      };
    }
    await ensureReady();
    const [totals, days] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(CASE
                  WHEN created_at >= $3::timestamptz AND created_at <= $4::timestamptz THEN revenue
                  ELSE 0 END), 0) AS revenue,
                COUNT(*) FILTER (
                  WHERE created_at >= $3::timestamptz AND created_at <= $4::timestamptz
                )::int AS order_count,
                COUNT(*) FILTER (
                  WHERE created_at >= $3::timestamptz
                    AND created_at <= $4::timestamptz
                    AND checkout_channel = 'contact'
                )::int AS contact_order_count,
                COALESCE(SUM(CASE
                  WHEN created_at >= $3::timestamptz
                    AND created_at <= $4::timestamptz
                    AND checkout_channel = 'contact'
                  THEN revenue ELSE 0 END), 0) AS contact_revenue,
                COUNT(*) FILTER (
                  WHERE created_at >= $3::timestamptz
                    AND created_at <= $4::timestamptz
                    AND checkout_channel IS DISTINCT FROM 'contact'
                )::int AS company_order_count,
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
    const contactCheckoutOrderCount = row.contact_order_count || 0;
    return {
      revenue: money(row.revenue),
      orderCount: row.order_count || 0,
      contactCheckoutOrderCount,
      contactCheckoutRevenue: money(row.contact_revenue),
      companyCheckoutOrderCount: row.company_order_count || 0,
      hasContactCheckout: contactCheckoutOrderCount > 0,
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

  async function companyProductsRange(shopDomain, companyId, startIso, endIso, limit = 8) {
    const shop = normalizeShop(shopDomain);
    const normalizedCompanyId = normalizeCompanyId(companyId);
    if (!shop || !normalizedCompanyId) return [];
    await ensureReady();
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20);
    const { rows } = await pool.query(
      `SELECT l.product_id,
              MAX(l.title) AS title,
              COUNT(DISTINCT l.order_id)::int AS order_count,
              SUM(l.quantity)::int AS units_sold,
              SUM(l.revenue) AS revenue
       FROM ${LINE_TABLE} l
       INNER JOIN ${ORDER_TABLE} o
         ON o.shop = l.shop AND o.order_id = l.order_id
       WHERE l.shop = $1
         AND o.company_id = $2
         AND ($3::date IS NULL OR o.day >= $3::date)
         AND ($4::date IS NULL OR o.day <= $4::date)
       GROUP BY l.product_id
       ORDER BY COUNT(DISTINCT l.order_id) DESC, SUM(l.revenue) DESC
       LIMIT $5`,
      [
        shop,
        normalizedCompanyId,
        startIso ? startIso.slice(0, 10) : null,
        endIso ? endIso.slice(0, 10) : null,
        safeLimit,
      ],
    );
    return rows.map((row) => ({
      id: row.product_id,
      title: row.title || 'Untitled',
      orderCount: row.order_count || 0,
      unitsSold: row.units_sold || 0,
      revenue: money(row.revenue),
      currencyCode: 'USD',
    }));
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
    companyProductsRange,
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
  normalizeCustomerId,
  resolveCompanyFromContacts,
  parseOrderPayload,
  snapshotFromGraphqlOrder,
  utcDay,
  money,
  estimateBackfillProgress,
  decodeOrdersCursorTime,
};
