'use strict';

const { Pool } = require('pg');
const { Session } = require('@shopify/shopify-api');

const SESSION_TABLE = 'shopify_sessions';

/**
 * Shopify session storage compatible with Neon on Vercel (SSL + pooled URL).
 * @shopify/shopify-app-session-storage-postgresql omits SSL on pg.Pool and can hang on Neon.
 */
class ShopifyPostgresSessionStorage {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 15000,
      statement_timeout: 10000,
      query_timeout: 10000,
    });
    this.pool.on('error', (err) => console.error('[postgres] shopify session pool', err));
    this.ready = this.ensureSchema();
    // Prevent an unhandled rejection crash if this fails before any method awaits `ready`
    // (e.g. a cold-start request that errors out before ever touching session storage).
    this.ready.catch((err) => console.error('[postgres] shopify session ensureSchema failed', err));
  }

  async ensureSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "${SESSION_TABLE}" (
        "id" varchar(255) NOT NULL PRIMARY KEY,
        "shop" varchar(255) NOT NULL,
        "state" varchar(255) NOT NULL,
        "isOnline" boolean NOT NULL,
        "scope" varchar(255),
        "expires" integer,
        "onlineAccessInfo" TEXT,
        "accessToken" TEXT
      );
    `);
  }

  rowToSession(row) {
    if (!row) return undefined;
    const copy = { ...row };
    if (copy.expires) copy.expires *= 1000;
    return Session.fromPropertyArray(Object.entries(copy));
  }

  async storeSession(session) {
    await this.ready;
    const entries = session
      .toPropertyArray()
      .map(([key, value]) => (key === 'expires' ? [key, Math.floor(value / 1000)] : [key, value]));
    const columns = entries.map(([key]) => `"${key}"`).join(', ');
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
    const updates = entries.map(([key]) => `"${key}" = EXCLUDED."${key}"`).join(', ');
    const values = entries.map(([, value]) => {
      if (value !== null && typeof value === 'object') {
        return JSON.stringify(value);
      }
      return value;
    });
    await this.pool.query(
      `INSERT INTO "${SESSION_TABLE}" (${columns}) VALUES (${placeholders})
       ON CONFLICT ("id") DO UPDATE SET ${updates}`,
      values,
    );
    return true;
  }

  async loadSession(id) {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT * FROM "${SESSION_TABLE}" WHERE "id" = $1`,
      [id],
    );
    return rows.length === 1 ? this.rowToSession(rows[0]) : undefined;
  }

  async deleteSession(id) {
    await this.ready;
    await this.pool.query(`DELETE FROM "${SESSION_TABLE}" WHERE "id" = $1`, [id]);
    return true;
  }

  async deleteSessions(ids) {
    await this.ready;
    if (!ids.length) return true;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    await this.pool.query(
      `DELETE FROM "${SESSION_TABLE}" WHERE "id" IN (${placeholders})`,
      ids,
    );
    return true;
  }

  async findSessionsByShop(shop) {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT * FROM "${SESSION_TABLE}" WHERE "shop" = $1`,
      [shop],
    );
    return rows.map((row) => this.rowToSession(row));
  }
}

module.exports = { ShopifyPostgresSessionStorage, SESSION_TABLE };
