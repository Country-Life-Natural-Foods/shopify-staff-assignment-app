'use strict';

const { Pool } = require('pg');
const { resolvePostgresUrl } = require('./configure-session-storage');

const STAFF_TABLE = 'staff_members';

function createMemoryStaffStore() {
  const staff = [];
  return {
    backend: 'memory',
    async list() {
      return staff;
    },
    async findById(id) {
      return staff.find((s) => s.id === id) || null;
    },
    async findByShopifyUserId(shopifyUserId) {
      if (!shopifyUserId) return null;
      return staff.find((s) => s.shopifyUserId === shopifyUserId) || null;
    },
    async hasManager() {
      return staff.some((s) => s.role === 'manager');
    },
    async upsert(record) {
      const index = staff.findIndex((s) => s.id === record.id);
      if (index === -1) {
        staff.push(record);
      } else {
        staff[index] = { ...staff[index], ...record };
      }
      return staff.find((s) => s.id === record.id);
    },
    async remove(id) {
      const index = staff.findIndex((s) => s.id === id);
      if (index === -1) return false;
      staff.splice(index, 1);
      return true;
    },
    async findUnclaimed() {
      return staff.filter((s) => !s.shopifyUserId);
    },
    async claim(id, shopifyUserId) {
      const record = staff.find((s) => s.id === id);
      if (!record || record.shopifyUserId) return null;
      record.shopifyUserId = shopifyUserId;
      return record;
    },
  };
}

function rowToStaff(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    commissionTier: Number(row.commission_tier),
    role: row.role,
    shopifyUserId: row.shopify_user_id || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function createPostgresStaffStore(connectionString, isProduction) {
  const pool = new Pool({
    connectionString,
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
    max: 1,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 10000,
    query_timeout: 10000,
  });
  pool.on('error', (err) => console.error('[postgres] staff pool', err));

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS "${STAFF_TABLE}" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "name" varchar(255) NOT NULL,
      "email" varchar(255) NOT NULL DEFAULT '',
      "commission_tier" numeric NOT NULL DEFAULT 0,
      "role" varchar(50) NOT NULL,
      "shopify_user_id" varchar(255),
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Prevent an unhandled rejection crash if this fails before any method awaits `ready`
  // (e.g. a cold-start request that errors out before ever touching the staff store).
  ready.catch((err) => console.error('[postgres] staff store ensureSchema failed', err));

  return {
    backend: 'postgres',
    async list() {
      await ready;
      const { rows } = await pool.query(`SELECT * FROM "${STAFF_TABLE}" ORDER BY created_at ASC`);
      return rows.map(rowToStaff);
    },
    async findById(id) {
      await ready;
      const { rows } = await pool.query(`SELECT * FROM "${STAFF_TABLE}" WHERE "id" = $1`, [id]);
      return rows.length ? rowToStaff(rows[0]) : null;
    },
    async findByShopifyUserId(shopifyUserId) {
      if (!shopifyUserId) return null;
      await ready;
      const { rows } = await pool.query(
        `SELECT * FROM "${STAFF_TABLE}" WHERE "shopify_user_id" = $1`,
        [shopifyUserId],
      );
      return rows.length ? rowToStaff(rows[0]) : null;
    },
    async hasManager() {
      await ready;
      const { rows } = await pool.query(
        `SELECT 1 FROM "${STAFF_TABLE}" WHERE "role" = 'manager' LIMIT 1`,
      );
      return rows.length > 0;
    },
    async upsert(record) {
      await ready;
      const { rows } = await pool.query(
        `INSERT INTO "${STAFF_TABLE}" (id, name, email, commission_tier, role, shopify_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           commission_tier = EXCLUDED.commission_tier,
           role = EXCLUDED.role,
           shopify_user_id = COALESCE(EXCLUDED.shopify_user_id, "${STAFF_TABLE}".shopify_user_id)
         RETURNING *`,
        [
          record.id,
          record.name,
          record.email || '',
          record.commissionTier ?? 0,
          record.role,
          record.shopifyUserId || null,
          record.createdAt || null,
        ],
      );
      return rowToStaff(rows[0]);
    },
    async remove(id) {
      await ready;
      const { rowCount } = await pool.query(`DELETE FROM "${STAFF_TABLE}" WHERE "id" = $1`, [id]);
      return rowCount > 0;
    },
    async findUnclaimed() {
      await ready;
      const { rows } = await pool.query(
        `SELECT * FROM "${STAFF_TABLE}" WHERE "shopify_user_id" IS NULL ORDER BY created_at ASC`,
      );
      return rows.map(rowToStaff);
    },
    async claim(id, shopifyUserId) {
      await ready;
      // WHERE shopify_user_id IS NULL makes this atomic: if two people race to
      // claim the same record, only the first UPDATE matches a row.
      const { rows } = await pool.query(
        `UPDATE "${STAFF_TABLE}" SET "shopify_user_id" = $1 WHERE "id" = $2 AND "shopify_user_id" IS NULL RETURNING *`,
        [shopifyUserId, id],
      );
      return rows.length ? rowToStaff(rows[0]) : null;
    },
  };
}

function configureStaffStore({ isProduction }) {
  const postgresUrl = resolvePostgresUrl();
  if (postgresUrl) {
    return createPostgresStaffStore(postgresUrl, isProduction);
  }
  if (isProduction) {
    console.error(
      '[staff] No Postgres connection found (DATABASE_URL/POSTGRES_URL). Staff roster will not persist across cold starts.',
    );
  }
  return createMemoryStaffStore();
}

module.exports = { configureStaffStore };
