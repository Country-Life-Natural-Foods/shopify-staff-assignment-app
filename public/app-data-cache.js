/**
 * Session-scoped JSON cache so dashboard / analytics / reports can paint
 * instantly on return visits, then refresh in the background.
 *
 * sessionStorage survives full page loads in the same tab. An in-memory Map
 * plus in-flight dedupe cover the current page. Mutations should call
 * invalidatePrefix() so the next read hits the network.
 */
(function initAppDataCache(global) {
  const PREFIX = 'clnf-cache:v2:';
  const MAX_STORE_BYTES = 2_000_000;
  const memory = new Map();
  const inflight = new Map();

  function normalize(url) {
    try {
      const parsed = new URL(url, global.location.origin);
      const pairs = [...parsed.searchParams.entries()].sort((a, b) => {
        if (a[0] === b[0]) return a[1].localeCompare(b[1]);
        return a[0].localeCompare(b[0]);
      });
      parsed.search = '';
      parsed.hash = '';
      for (const [key, value] of pairs) parsed.searchParams.append(key, value);
      return parsed.pathname + parsed.search;
    } catch {
      return String(url);
    }
  }

  function storageKey(url) {
    return PREFIX + normalize(url);
  }

  function shopHostQuery() {
    const params = new URLSearchParams(global.location.search);
    const query = new URLSearchParams();
    const shop = params.get('shop');
    const host = params.get('host');
    if (shop) query.set('shop', shop);
    if (host) query.set('host', host);
    return query;
  }

  function withShopHost(path) {
    const parsed = new URL(path, global.location.origin);
    const extra = shopHostQuery();
    extra.forEach((value, key) => {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    });
    return parsed.pathname + parsed.search;
  }

  function peek(url) {
    const key = normalize(url);
    const mem = memory.get(key);
    if (mem) return mem.data;
    try {
      const raw = global.sessionStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) return null;
      memory.set(key, parsed);
      return parsed.data;
    } catch {
      return null;
    }
  }

  function set(url, data) {
    const key = normalize(url);
    const entry = { data, savedAt: Date.now() };
    memory.set(key, entry);
    try {
      const raw = JSON.stringify(entry);
      if (raw.length > MAX_STORE_BYTES) return;
      global.sessionStorage.setItem(PREFIX + key, raw);
    } catch {
      evictOldest();
      try {
        global.sessionStorage.setItem(PREFIX + key, JSON.stringify(entry));
      } catch {
        /* quota — memory cache still works for this page */
      }
    }
  }

  function evictOldest() {
    try {
      const keys = [];
      for (let i = 0; i < global.sessionStorage.length; i += 1) {
        const key = global.sessionStorage.key(i);
        if (key && key.startsWith(PREFIX)) keys.push(key);
      }
      if (!keys.length) return;
      let oldestKey = keys[0];
      let oldestAt = Infinity;
      for (const key of keys) {
        try {
          const parsed = JSON.parse(global.sessionStorage.getItem(key) || '');
          const savedAt = parsed && parsed.savedAt ? parsed.savedAt : 0;
          if (savedAt < oldestAt) {
            oldestAt = savedAt;
            oldestKey = key;
          }
        } catch {
          oldestKey = key;
          break;
        }
      }
      global.sessionStorage.removeItem(oldestKey);
    } catch {
      /* ignore */
    }
  }

  function invalidate(url) {
    const key = normalize(url);
    memory.delete(key);
    inflight.delete(key);
    try {
      global.sessionStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  }

  function invalidatePrefix(pathnamePrefix) {
    const prefix = String(pathnamePrefix || '');
    for (const key of [...memory.keys()]) {
      if (key.startsWith(prefix)) {
        memory.delete(key);
        inflight.delete(key);
      }
    }
    try {
      const toRemove = [];
      for (let i = 0; i < global.sessionStorage.length; i += 1) {
        const storage = global.sessionStorage.key(i);
        if (!storage || !storage.startsWith(PREFIX)) continue;
        const urlKey = storage.slice(PREFIX.length);
        if (urlKey.startsWith(prefix)) toRemove.push(storage);
      }
      toRemove.forEach((key) => global.sessionStorage.removeItem(key));
    } catch {
      /* ignore */
    }
  }

  function fetcher() {
    return global.shopifyApiFetch || global.fetch.bind(global);
  }

  async function fetchFresh(url) {
    const key = normalize(url);
    if (inflight.has(key)) return inflight.get(key);

    const pending = (async () => {
      const res = await fetcher()(url, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data && data.code;
        err.data = data;
        err.res = res;
        throw err;
      }
      set(url, data);
      return { data, res, fromCache: false };
    })();

    inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inflight.get(key) === pending) inflight.delete(key);
    }
  }

  async function loadJson(url, { onCached } = {}) {
    const cached = peek(url);
    if (cached != null && typeof onCached === 'function') {
      try {
        onCached(cached);
      } catch (err) {
        console.warn('[app-cache] onCached failed', err);
      }
    }

    if (cached != null) {
      const revalidate = fetchFresh(url).catch((err) => {
        console.warn('[app-cache] revalidate failed', normalize(url), err);
        return null;
      });
      return { data: cached, fromCache: true, revalidate };
    }

    return fetchFresh(url);
  }

  function whenIdle(fn, timeout = 1800) {
    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(() => fn(), { timeout });
      return;
    }
    global.setTimeout(fn, Math.min(timeout, 700));
  }

  function prefetchPages(paths) {
    (paths || []).forEach((path) => {
      const href = withShopHost(path);
      if (document.querySelector(`link[data-app-prefetch="${href}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      link.setAttribute('data-app-prefetch', href);
      document.head.appendChild(link);
    });
  }

  function prefetchAsset(href, as) {
    if (!href || document.querySelector(`link[data-app-prefetch="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    if (as) link.as = as;
    link.setAttribute('data-app-prefetch', href);
    document.head.appendChild(link);
  }

  async function prefetchJson(urls) {
    for (const url of urls || []) {
      if (peek(url)) continue;
      try {
        await fetchFresh(url);
      } catch (err) {
        console.warn('[app-cache] prefetch failed', normalize(url), err);
      }
    }
  }

  function ytdRange() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return {
      startDate: `${year}-01-01T00:00:00.000Z`,
      endDate: `${year}-${month}-${day}T23:59:59.999Z`,
    };
  }

  function analyticsUrl(pathname, extraParams) {
    const parsed = new URL(pathname, global.location.origin);
    Object.entries(extraParams || {}).forEach(([key, value]) => {
      if (value != null && value !== '') parsed.searchParams.set(key, value);
    });
    return withShopHost(parsed.pathname + parsed.search);
  }

  function defaultAnalyticsUrls() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const ytd = {
      startDate: `${year}-01-01T00:00:00.000Z`,
      endDate: `${year}-${month}-${day}T23:59:59.999Z`,
    };
    const yoyTrend = {
      startDate: `${year - 1}-01-01T00:00:00.000Z`,
      endDate: `${year}-${month}-${day}T23:59:59.999Z`,
    };
    return {
      summary: analyticsUrl('/api/analytics/summary', ytd),
      trend: analyticsUrl('/api/analytics/revenue-trend', { ...yoyTrend, period: 'monthly' }),
      companies: analyticsUrl('/api/analytics/companies', {
        ...ytd,
        sortBy: 'revenue',
        sortOrder: 'desc',
      }),
      products: analyticsUrl('/api/analytics/products', ytd),
    };
  }

  function dashboardUrls() {
    return {
      session: withShopHost('/api/session-info'),
      companies: withShopHost('/api/companies'),
      locations: withShopHost('/api/locations'),
      staff: withShopHost('/api/staff'),
    };
  }

  async function warmAnalytics() {
    prefetchPages(['/analytics', '/reports']);
    prefetchAsset('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js', 'script');
    const urls = defaultAnalyticsUrls();
    const summary = peek(urls.summary);
    if (!summary || summary.source !== 'rollup') return;
    await prefetchJson([urls.trend, urls.companies, urls.products]);
  }

  async function warmDashboard() {
    prefetchPages(['/', '/reports', '/analytics']);
    const urls = dashboardUrls();
    await prefetchJson([urls.session, urls.companies, urls.locations, urls.staff]);
  }

  global.AppDataCache = {
    normalize,
    withShopHost,
    peek,
    set,
    invalidate,
    invalidatePrefix,
    loadJson,
    fetchFresh,
    prefetchJson,
    prefetchPages,
    prefetchAsset,
    whenIdle,
    ytdRange,
    defaultAnalyticsUrls,
    dashboardUrls,
    warmAnalytics,
    warmDashboard,
  };
})(window);
