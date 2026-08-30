'use strict';

const { Pool } = require('pg');
const { resolvePostgresUrl } = require('./configure-session-storage');

const STAFF_TABLE = 'staff_members';

// Strips internal PIN fields before anything reaches the client — only a
// `hasPin` boolean (safe: reveals no secret) is ever exposed alongside the
// rest of a staff record.
function sanitizeMemoryStaff(record) {
  if (!record) return null;
  const { pinHash, pinFailedAttempts, ...rest } = record;
  return { ...rest, hasPin: Boolean(pinHash) };
}

function createMemoryStaffStore() {
  const staff = [];
  return {
    backend: 'memory',
    async list() {
      return staff.map(sanitizeMemoryStaff);
    },
    async findById(id) {
      return sanitizeMemoryStaff(staff.find((s) => s.id === id));
    },
    async findByShopifyUserId(shopifyUserId) {
      if (!shopifyUserId) return null;
      return sanitizeMemoryStaff(staff.find((s) => s.shopifyUserId === shopifyUserId));
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
      return sanitizeMemoryStaff(staff.find((s) => s.id === record.id));
    },
    async remove(id) {
      const index = staff.findIndex((s) => s.id === id);
      if (index === -1) return false;
      staff.splice(index, 1);
      return true;
    },
    async findUnclaimed() {
      return staff.filter((s) => !s.shopifyUserId).map(sanitizeMemoryStaff);
    },
    async claim(id, shopifyUserId) {
      const record = staff.find((s) => s.id === id);
      if (!record || record.shopifyUserId) return null;
      record.shopifyUserId = shopifyUserId;
      return sanitizeMemoryStaff(record);
    },
    async getPinInfo(id) {
      const record = staff.find((s) => s.id === id);
      if (!record) return null;
      return { pinHash: record.pinHash || null, pinFailedAttempts: record.pinFailedAttempts || 0 };
    },
    async setPin(id, pinHash) {
      const record = staff.find((s) => s.id === id);
      if (!record || record.pinHash) return false;
      record.pinHash = pinHash;
      record.pinFailedAttempts = 0;
      return true;
    },
    // Unconditional overwrite — used for a manager assigning a starter PIN
    // and for a rep's own "change my code" flow (which independently checks
    // the current code before calling this). setPin above stays first-set-only.
    async forceSetPin(id, pinHash) {
      const record = staff.find((s) => s.id === id);
      if (!record) return false;
      record.pinHash = pinHash;
      record.pinFailedAttempts = 0;
      return true;
    },
    async resetPin(id) {
      const record = staff.find((s) => s.id === id);
      if (!record) return false;
      record.pinHash = null;
      record.pinFailedAttempts = 0;
      return true;
    },
    async recordPinAttempt(id, success) {
      const record = staff.find((s) => s.id === id);
      if (!record) return 0;
      record.pinFailedAttempts = success ? 0 : (record.pinFailedAttempts || 0) + 1;
      return record.pinFailedAttempts;
    },
  };
}

// `hasPin` (safe: reveals no secret) is exposed to the client; the raw
// `pin_hash`/`pin_failed_attempts` columns are deliberately never included
// here — see getPinInfo below for the one place that reads them.
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
    hasPin: Boolean(row.pin_hash),
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

  // Lazily (re)runs the schema check rather than capturing one promise at
  // module-init time. A warm container reuses this closure across requests,
  // so a single failed attempt (Neon compute slow to wake, a transient
  // network blip) must not permanently poison the store for that
  // container's remaining lifetime — clearing `readyPromise` on failure
  // means the next call gets a fresh attempt instead of replaying the same
  // rejection forever (which otherwise surfaces as an unhandled rejection
  // that hangs the request until Vercel's 300s timeout forces a 504).
  let readyPromise = null;
  function ensureReady() {
    if (!readyPromise) {
      readyPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS "${STAFF_TABLE}" (
          "id" varchar(255) NOT NULL PRIMARY KEY,
          "name" varchar(255) NOT NULL,
          "email" varchar(255) NOT NULL DEFAULT '',
          "commission_tier" numeric NOT NULL DEFAULT 0,
          "role" varchar(50) NOT NULL,
          "shopify_user_id" varchar(255),
          "created_at" timestamptz NOT NULL DEFAULT now(),
          "pin_hash" text,
          "pin_failed_attempts" integer NOT NULL DEFAULT 0
        );
        ALTER TABLE "${STAFF_TABLE}" ADD COLUMN IF NOT EXISTS "pin_hash" text;
        ALTER TABLE "${STAFF_TABLE}" ADD COLUMN IF NOT EXISTS "pin_failed_attempts" integer NOT NULL DEFAULT 0;
      `).catch((err) => {
        console.error('[postgres] staff store ensureSchema failed', err);
        readyPromise = null;
        throw err;
      });
    }
    return readyPromise;
  }

  return {
    backend: 'postgres',
    async list() {
      await ensureReady();
      const { rows } = await pool.query(`SELECT * FROM "${STAFF_TABLE}" ORDER BY created_at ASC`);
      return rows.map(rowToStaff);
    },
    async findById(id) {
      await ensureReady();
      const { rows } = await pool.query(`SELECT * FROM "${STAFF_TABLE}" WHERE "id" = $1`, [id]);
      return rows.length ? rowToStaff(rows[0]) : null;
    },
    async findByShopifyUserId(shopifyUserId) {
      if (!shopifyUserId) return null;
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT * FROM "${STAFF_TABLE}" WHERE "shopify_user_id" = $1`,
        [shopifyUserId],
      );
      return rows.length ? rowToStaff(rows[0]) : null;
    },
    async hasManager() {
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT 1 FROM "${STAFF_TABLE}" WHERE "role" = 'manager' LIMIT 1`,
      );
      return rows.length > 0;
    },
    async upsert(record) {
      await ensureReady();
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
      await ensureReady();
      const { rowCount } = await pool.query(`DELETE FROM "${STAFF_TABLE}" WHERE "id" = $1`, [id]);
      return rowCount > 0;
    },
    async findUnclaimed() {
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT * FROM "${STAFF_TABLE}" WHERE "shopify_user_id" IS NULL ORDER BY created_at ASC`,
      );
      return rows.map(rowToStaff);
    },
    async claim(id, shopifyUserId) {
      await ensureReady();
      // WHERE shopify_user_id IS NULL makes this atomic: if two people race to
      // claim the same record, only the first UPDATE matches a row.
      const { rows } = await pool.query(
        `UPDATE "${STAFF_TABLE}" SET "shopify_user_id" = $1 WHERE "id" = $2 AND "shopify_user_id" IS NULL RETURNING *`,
        [shopifyUserId, id],
      );
      return rows.length ? rowToStaff(rows[0]) : null;
    },
    // Internal only — the one place allowed to read the raw hash/attempt
    // count. Never route this through rowToStaff or a client response.
    async getPinInfo(id) {
      await ensureReady();
      const { rows } = await pool.query(
        `SELECT "pin_hash", "pin_failed_attempts" FROM "${STAFF_TABLE}" WHERE "id" = $1`,
        [id],
      );
      if (!rows.length) return null;
      return { pinHash: rows[0].pin_hash || null, pinFailedAttempts: rows[0].pin_failed_attempts || 0 };
    },
    async setPin(id, pinHash) {
      await ensureReady();
      // WHERE pin_hash IS NULL enforces first-time-set only — changing an
      // existing code requires a manager reset, not a direct overwrite.
      const { rowCount } = await pool.query(
        `UPDATE "${STAFF_TABLE}" SET "pin_hash" = $1, "pin_failed_attempts" = 0 WHERE "id" = $2 AND "pin_hash" IS NULL`,
        [pinHash, id],
      );
      return rowCount > 0;
    },
    // Unconditional overwrite — used for a manager assigning a starter PIN
    // and for a rep's own "change my code" flow (which independently checks
    // the current code before calling this). setPin above stays first-set-only.
    async forceSetPin(id, pinHash) {
      await ensureReady();
      const { rowCount } = await pool.query(
        `UPDATE "${STAFF_TABLE}" SET "pin_hash" = $1, "pin_failed_attempts" = 0 WHERE "id" = $2`,
        [pinHash, id],
      );
      return rowCount > 0;
    },
    async resetPin(id) {
      await ensureReady();
      const { rowCount } = await pool.query(
        `UPDATE "${STAFF_TABLE}" SET "pin_hash" = NULL, "pin_failed_attempts" = 0 WHERE "id" = $1`,
        [id],
      );
      return rowCount > 0;
    },
    async recordPinAttempt(id, success) {
      await ensureReady();
      const { rows } = await pool.query(
        `UPDATE "${STAFF_TABLE}"
         SET "pin_failed_attempts" = CASE WHEN $2 THEN 0 ELSE "pin_failed_attempts" + 1 END
         WHERE "id" = $1
         RETURNING "pin_failed_attempts"`,
        [id, success],
      );
      return rows.length ? rows[0].pin_failed_attempts : 0;
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
