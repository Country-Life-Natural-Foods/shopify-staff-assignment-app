/**
 * Shared PIN gate + API helpers for /reports and /staff.
 */
function adminApiUrl(path) {
  const params = new URLSearchParams(window.location.search);
  const q = new URLSearchParams();
  const shop = params.get('shop');
  const host = params.get('host');
  if (shop) q.set('shop', shop);
  if (host) q.set('host', host);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

function setBanner(el, tone, text) {
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.setAttribute('tone', tone);
  el.textContent = text;
}

async function adminFetch(path, options = {}) {
  const res = await window.shopifyApiFetch(adminApiUrl(path), {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(raw.slice(0, 180) || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.code = data?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function waitForPolaris() {
  if (!window.customElements) return;
  const tags = ['s-page', 's-select', 's-password-field', 's-button'];
  await Promise.all(
    tags.map((tag) => customElements.whenDefined(tag).catch(() => undefined)),
  );
}

window.AdminApp = {
  apiUrl: adminApiUrl,
  fetch: adminFetch,
  setBanner,
  async initGate({ requireAdmin, onReady }) {
    await waitForPolaris();
    const gate = document.getElementById('gate');
    const app = document.getElementById('admin-app');
    const banner = document.getElementById('gate-banner');
    const setupPanel = document.getElementById('setup-panel');
    const loginPanel = document.getElementById('login-panel');
    const accountSelect = document.getElementById('account-select');
    const pinField = document.getElementById('pin-field');
    const setupName = document.getElementById('setup-name');
    const setupPin = document.getElementById('setup-pin');
    const whoami = document.getElementById('whoami');
    const signOutBtn = document.getElementById('sign-out-btn');

    function showApp(session) {
      gate.hidden = true;
      app.hidden = false;
      if (whoami) {
        whoami.textContent = session.isAdmin
          ? `${session.name} · Admin`
          : session.name;
      }
    }

    function showGate() {
      gate.hidden = false;
      app.hidden = true;
    }

    async function loadAccounts() {
      const data = await adminFetch('/api/app-users');
      return data.users || [];
    }

    function fillAccounts(users) {
      accountSelect.replaceChildren(
        ...users.map((user) => {
          const option = document.createElement('s-option');
          option.value = user.id;
          option.textContent = user.isAdmin ? `${user.name} (Admin)` : user.name;
          return option;
        }),
      );
      if (users.length) accountSelect.value = users[0].id;
    }

    async function refreshGate() {
      setBanner(banner, 'info', '');
      let session = null;
      try {
        session = await adminFetch('/api/admin/me');
      } catch (err) {
        if (err.status !== 401) {
          setBanner(banner, 'critical', err.message);
        }
      }
      if (session?.user) {
        if (requireAdmin && !session.user.isAdmin) {
          showGate();
          loginPanel.hidden = false;
          setupPanel.hidden = true;
          setBanner(banner, 'warning', 'This page is limited to admin accounts.');
          fillAccounts(await loadAccounts());
          return;
        }
        showApp(session.user);
        onReady(session.user);
        return;
      }

      showGate();
      let users = [];
      try {
        users = await loadAccounts();
      } catch (err) {
        setupPanel.hidden = true;
        loginPanel.hidden = true;
        setBanner(banner, 'critical', err.message);
        return;
      }
      if (users.length === 0) {
        setupPanel.hidden = false;
        loginPanel.hidden = true;
        if (setupName && !setupName.value) setupName.value = 'Admin';
        return;
      }
      setupPanel.hidden = true;
      loginPanel.hidden = false;
      fillAccounts(users);
    }

    document.getElementById('login-btn')?.addEventListener('click', async () => {
      try {
        setBanner(banner, 'info', '');
        const data = await adminFetch('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({
            userId: accountSelect.value,
            pin: pinField.value,
          }),
        });
        if (requireAdmin && !data.user?.isAdmin) {
          setBanner(banner, 'warning', 'This page is limited to admin accounts.');
          return;
        }
        pinField.value = '';
        showApp(data.user);
        onReady(data.user);
      } catch (err) {
        setBanner(banner, 'critical', err.message);
      }
    });

    document.getElementById('setup-btn')?.addEventListener('click', async () => {
      try {
        setBanner(banner, 'info', '');
        const data = await adminFetch('/api/admin/setup', {
          method: 'POST',
          body: JSON.stringify({
            name: setupName.value || 'Admin',
            pin: setupPin.value,
          }),
        });
        setupPin.value = '';
        showApp(data.user);
        onReady(data.user);
      } catch (err) {
        setBanner(banner, 'critical', err.message);
      }
    });

    signOutBtn?.addEventListener('click', async () => {
      try {
        await adminFetch('/api/admin/logout', { method: 'POST', body: '{}' });
      } catch {
        /* still return to gate */
      }
      showGate();
      await refreshGate();
    });

    try {
      await refreshGate();
    } catch (err) {
      setBanner(banner, 'critical', err.message);
    }
  },
};

window.addEventListener('shopify:api-fetch-ready', () => {
  window.dispatchEvent(new Event('admin-app-ready'));
}, { once: true });
window.addEventListener('load', () => {
  window.dispatchEvent(new Event('admin-app-ready'));
}, { once: true });
