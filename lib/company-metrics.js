'use strict';

const { Pool } = require('pg');
const { resolvePostgresUrl } = require('./configure-session-storage');
const { shopifyGraphql } = require('./shopify-gql');

const ORDER_TABLE = 'company_metric_order';
const DAY_TABLE = 'company_metric_day';
const LINE_TABLE = 'company_metric_line';
const PRODUCT_DAY_TABLE = 'company_metric_product_day';
const META_TABLE = 'company_metric_meta';

const BACKFILL_ORDERS_QUERY = `
  query BackfillB2bOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          createdAt
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
  };
}

function snapshotFromGraphqlOrder(node) {
  if (!node?.id || !node.createdAt) return null;
  const companyId = node.purchasingEntity?.__typename === 'PurchasingCompany'
    ? normalizeCompanyId(node.purchasingEntity.company?.id)
    : null;
  return {
    orderId: node.id,
    companyId,
    createdAt: node.createdAt,
    revenue: money(node.currentTotalPriceSet?.shopMoney?.amount),
    lines: parseLinesFromGraphql(node),
  };
}

function disabledStore() {
  return {
    enabled: false,
    async isReady() { return false; },
    async isProductsReady() { return false; },
    async status() { return { enabled: false, ready: false, productsReady: false, status: 'disabled' }; },
    async ingestWebhook() { return { applied: false, reason: 'disabled' }; },
    async backfillChunk() { return { enabled: false, ready: false }; },
    async backfillProductChunk() { return { enabled: false, ready: false }; },
    async sumJobs() { return new Map(); },
    async shopRangeTotals() { return { revenue: 0, orderCount: 0, activeCompanies: 0 }; },
    async companiesRange() { return new Map(); },
    async companyRange() { return { revenue: 0, orderCount: 0, lastOrderDate: null, days: [] }; },
    async productsRange() { return []; },
    async revenueByDay() { return []; },
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
  const nextCompany = snap.companyId || null;
  const nextRevenue = money(snap.revenue);
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

  async function isReady(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return false;
    const meta = await loadMeta(shop);
    return meta?.backfill_status === 'complete';
  }

  async function status(shopDomain) {
    const shop = normalizeShop(shopDomain);
    if (!shop) return { enabled: true, ready: false, status: 'unknown' };
    try {
      const meta = await loadMeta(shop);
      return {
        enabled: true,
        ready: meta?.backfill_status === 'complete',
        productsReady: meta?.product_backfill_status === 'complete'
          || (meta?.backfill_status === 'complete' && (await hasProductLines(shop))),
        status: meta?.backfill_status || 'pending',
        ingested: meta?.ingested_orders || 0,
        error: meta?.backfill_error || null,
        lastBackfillAt: meta?.last_backfill_at || null,
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

  async function claimBackfill(shop, { rebuild } = {}) {
    await ensureReady();
    if (rebuild) {
      await pool.query(`DELETE FROM ${LINE_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(`DELETE FROM ${PRODUCT_DAY_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(`DELETE FROM ${ORDER_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(`DELETE FROM ${DAY_TABLE} WHERE shop = $1`, [shop]);
      await pool.query(
        `INSERT INTO ${META_TABLE} (shop, backfill_status, backfill_cursor, backfill_error, ingested_orders, backfill_started_at, product_backfill_status, product_backfill_cursor)
         VALUES ($1, 'running', NULL, NULL, 0, now(), 'running', NULL)
         ON CONFLICT (shop) DO UPDATE SET
           backfill_status = 'running',
           backfill_cursor = NULL,
           backfill_error = NULL,
           ingested_orders = 0,
           backfill_started_at = now(),
           product_backfill_status = 'running',
           product_backfill_cursor = NULL`,
        [shop],
      );
      return { claimed: true, cursor: null, ingested: 0 };
    }

    const { rows } = await pool.query(
      `INSERT INTO ${META_TABLE} (shop, backfill_status, backfill_started_at, ingested_orders)
       VALUES ($1, 'running', now(), 0)
       ON CONFLICT (shop) DO UPDATE SET
         backfill_status = 'running',
         backfill_started_at = now()
       WHERE ${META_TABLE}.backfill_status IS DISTINCT FROM 'complete'
         AND (
           ${META_TABLE}.backfill_status IS DISTINCT FROM 'running'
           OR ${META_TABLE}.backfill_started_at < now() - interval '3 minutes'
         )
       RETURNING backfill_cursor, ingested_orders, backfill_status`,
      [shop],
    );
    if (!rows[0]) {
      const meta = await loadMeta(shop);
      return {
        claimed: false,
        ready: meta?.backfill_status === 'complete',
        status: meta?.backfill_status || 'pending',
      };
    }
    return { claimed: true, cursor: rows[0].backfill_cursor || null, ingested: rows[0].ingested_orders || 0 };
  }

  async function backfillChunk(shopDomain, graphqlClient, options = {}) {
    const shop = normalizeShop(shopDomain);
    if (!shop || !graphqlClient) return { enabled: true, ready: false };
    const maxPages = Math.max(1, options.maxPages || 6);
    const pageSize = Math.min(100, Math.max(10, options.pageSize || 100));
    const maxMs = options.maxMs || 18000;
    const started = Date.now();

    const claim = await claimBackfill(shop, { rebuild: Boolean(options.rebuild) });
    if (!claim.claimed) {
      return { enabled: true, ready: Boolean(claim.ready), status: claim.status, ingested: 0 };
    }

    let cursor = claim.cursor;
    let ingested = claim.ingested || 0;
    let pages = 0;
    let complete = false;

    try {
      while (pages < maxPages && Date.now() - started < maxMs) {
        const data = await shopifyGraphql(
          graphqlClient,
          BACKFILL_ORDERS_QUERY,
          { first: pageSize, after: cursor },
          'company metric backfill',
        );
        const conn = data?.orders;
        const nodes = (conn?.edges || []).map((edge) => edge.node).filter(Boolean);
        const snaps = nodes.map(snapshotFromGraphqlOrder).filter(Boolean);

        const db = await pool.connect();
        try {
          await db.query('BEGIN');
          for (const snap of snaps) {
            const result = await applySnapshot(db, shop, snap);
            if (result.changed) ingested += 1;
          }
          await db.query('COMMIT');
        } catch (err) {
          await db.query('ROLLBACK');
          throw err;
        } finally {
          db.release();
        }

        pages += 1;
        if (typeof options.onProgress === 'function') {
          options.onProgress({
            phase: 'rollup',
            done: ingested,
            total: ingested + (conn?.pageInfo?.hasNextPage ? pageSize : 0),
            label: 'Building order rollup',
          });
        }

        if (!conn?.pageInfo?.hasNextPage) {
          complete = true;
          break;
        }
        cursor = conn.pageInfo.endCursor;
      }

      await pool.query(
        `UPDATE ${META_TABLE}
         SET backfill_status = $2,
             backfill_cursor = $3,
             backfill_error = NULL,
             ingested_orders = $4,
             last_backfill_at = now(),
             product_backfill_status = CASE WHEN $2 = 'complete' THEN 'complete' ELSE product_backfill_status END,
             product_backfill_cursor = CASE WHEN $2 = 'complete' THEN NULL ELSE product_backfill_cursor END
         WHERE shop = $1`,
        [shop, complete ? 'complete' : 'pending', complete ? null : cursor, ingested],
      );

      return {
        enabled: true,
        ready: complete,
        status: complete ? 'complete' : 'pending',
        ingested,
        pages,
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

  async function backfillProductChunk(shopDomain, graphqlClient, options = {}) {
    const shop = normalizeShop(shopDomain);
    if (!shop || !graphqlClient || !(await isReady(shop))) {
      return { enabled: true, ready: false };
    }
    if (await hasProductLines(shop)) {
      await pool.query(
        `UPDATE ${META_TABLE} SET product_backfill_status = 'complete', product_backfill_cursor = NULL WHERE shop = $1`,
        [shop],
      );
      return { enabled: true, ready: true, status: 'complete' };
    }

    await ensureReady();
    const claimed = await pool.query(
      `UPDATE ${META_TABLE}
       SET product_backfill_status = 'running'
       WHERE shop = $1
         AND product_backfill_status IS DISTINCT FROM 'complete'
         AND (
           product_backfill_status IS DISTINCT FROM 'running'
           OR backfill_started_at < now() - interval '3 minutes'
         )
       RETURNING product_backfill_cursor`,
      [shop],
    );
    if (!claimed.rows[0]) {
      return { enabled: true, ready: await isProductsReady(shop) };
    }

    const maxPages = Math.max(1, options.maxPages || 6);
    const pageSize = Math.min(50, Math.max(10, options.pageSize || 50));
    const maxMs = options.maxMs || 18000;
    const started = Date.now();
    let cursor = claimed.rows[0].product_backfill_cursor || null;
    let pages = 0;
    let complete = false;

    try {
      while (pages < maxPages && Date.now() - started < maxMs) {
        const data = await shopifyGraphql(
          graphqlClient,
          BACKFILL_ORDERS_QUERY,
          { first: pageSize, after: cursor },
          'product metric backfill',
        );
        const conn = data?.orders;
        const snaps = (conn?.edges || []).map((edge) => snapshotFromGraphqlOrder(edge.node)).filter(Boolean);
        const db = await pool.connect();
        try {
          await db.query('BEGIN');
          for (const snap of snaps) {
            await applySnapshot(db, shop, snap);
          }
          await db.query('COMMIT');
        } catch (err) {
          await db.query('ROLLBACK');
          throw err;
        } finally {
          db.release();
        }
        pages += 1;
        if (!conn?.pageInfo?.hasNextPage) {
          complete = true;
          break;
        }
        cursor = conn.pageInfo.endCursor;
      }

      await pool.query(
        `UPDATE ${META_TABLE}
         SET product_backfill_status = $2, product_backfill_cursor = $3, last_backfill_at = now()
         WHERE shop = $1`,
        [shop, complete ? 'complete' : 'pending', complete ? null : cursor],
      );
      return { enabled: true, ready: complete, status: complete ? 'complete' : 'pending', pages };
    } catch (err) {
      await pool.query(
        `UPDATE ${META_TABLE} SET product_backfill_status = 'error', backfill_error = $2 WHERE shop = $1`,
        [shop, err.message],
      );
      throw err;
    }
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

  async function rebuild(shopDomain, graphqlClient, options = {}) {
    return backfillChunk(shopDomain, graphqlClient, { ...options, rebuild: true });
  }

  return {
    enabled: true,
    isReady,
    isProductsReady,
    status,
    ingestWebhook,
    backfillChunk,
    backfillProductChunk,
    sumJobs,
    shopRangeTotals,
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
};
