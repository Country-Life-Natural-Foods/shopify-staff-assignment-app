'use strict';

const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;

function createMemorySessionStorage(Session) {
  return {
    sessions: new Map(),
    storeSession(sessionData) {
      return new Promise((resolve) => {
        const payload = JSON.stringify(sessionData.toPropertyArray());
        const expires = sessionData.expires ? sessionData.expires.getTime() : null;
        this.sessions.set(sessionData.id, { payload, expires });
        resolve(true);
      });
    },
    loadSession(id) {
      return new Promise((resolve) => {
        if (!id) return resolve(null);
        const sessionData = this.sessions.get(id);
        if (!sessionData) return resolve(null);
        if (sessionData.expires && sessionData.expires < Date.now()) {
          this.sessions.delete(id);
          return resolve(null);
        }
        try {
          const entries = JSON.parse(sessionData.payload);
          resolve(Session.fromPropertyArray(entries));
        } catch (parseError) {
          console.error('Error parsing session data:', parseError);
          resolve(null);
        }
      });
    },
    deleteSession(id) {
      return new Promise((resolve) => {
        this.sessions.delete(id);
        resolve(true);
      });
    },
    async findSessionsByShop(shopDomain) {
      const needle = String(shopDomain || '')
        .toLowerCase()
        .replace(/^https?:\/\//, '');
      const matches = [];
      for (const id of this.sessions.keys()) {
        const s = await this.loadSession(id);
        if (s && String(s.shop || '').toLowerCase() === needle) {
          matches.push(s);
        }
      }
      return matches;
    },
    async deleteSessions(ids) {
      await Promise.all(ids.map((id) => this.deleteSession(id)));
    },
  };
}

function resolvePostgresUrl() {
  // Prefer Vercel/Neon pooled URLs (pgbouncer); avoid Prisma-style URLs for `pg`.
  const candidates = [
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.DATABASE_URL_UNPOOLED,
  ];
  for (const raw of candidates) {
    const url = String(raw || '').trim();
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      return url;
    }
  }
  return '';
}

function createPgPool(connectionString, isProduction) {
  return new (require('pg').Pool)({
    connectionString,
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
    max: 1,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000,
  });
}

/**
 * Shopify + Express session backends for serverless (Vercel).
 * - Redis (REDIS_URL) — Vercel/Upstash integration
 * - Postgres (DATABASE_URL / POSTGRES_URL) — Neon or Supabase free tier
 * - memory — local dev only; breaks on Vercel production
 */
function configureSessionStorage({ Session, isProduction }) {
  const redisUrl = (process.env.REDIS_URL || process.env.KV_URL || '').trim();
  const postgresUrl = resolvePostgresUrl();

  let shopifySessionStorage = createMemorySessionStorage(Session);
  let expressSessionStore;
  let backend = 'memory';

  if (redisUrl) {
    const { RedisSessionStorage } = require('@shopify/shopify-app-session-storage-redis');
    shopifySessionStorage = new RedisSessionStorage(redisUrl);
    const redisClient = createClient({ url: redisUrl });
    redisClient.on('error', (err) => console.error('[redis] express session client', err));
    redisClient.connect().catch((err) => console.error('[redis] connect failed', err));
    expressSessionStore = new RedisStore({
      client: redisClient,
      prefix: 'staff_app_express:',
    });
    backend = 'redis';
  } else if (postgresUrl) {
    const { ShopifyPostgresSessionStorage } = require('./shopify-postgres-session-storage');
    shopifySessionStorage = new ShopifyPostgresSessionStorage(postgresUrl);
    const pgSession = require('connect-pg-simple')(require('express-session'));
    const pool = createPgPool(postgresUrl, isProduction);
    pool.on('error', (err) => console.error('[postgres] express session pool', err));
    expressSessionStore = new pgSession({
      pool,
      tableName: 'staff_app_express_sessions',
      createTableIfMissing: true,
    });
    backend = 'postgres';
  } else if (isProduction) {
    console.error(
      '[shopify] No shared session store. Set REDIS_URL (Upstash on Vercel) or DATABASE_URL (Neon/Supabase Postgres). In-memory sessions fail on serverless.',
    );
  }

  return {
    shopifySessionStorage,
    expressSessionStore,
    backend,
    hasPersistentStorage: backend !== 'memory',
  };
}

module.exports = {
  configureSessionStorage,
  createMemorySessionStorage,
  resolvePostgresUrl,
};
