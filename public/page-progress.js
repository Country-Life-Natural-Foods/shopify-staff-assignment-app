/**
 * Top-of-screen determinate progress bar. Width is driven by completed work
 * (request count, or server-streamed company counts) — not a fake timer.
 */
(function initPageProgress(global) {
  const STYLE_ID = 'page-progress-styles';
  const ROOT_ID = 'page-progress';

  const css = `
    #${ROOT_ID} {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 80;
      pointer-events: none;
    }
    #${ROOT_ID}[hidden] { display: none !important; }
    #${ROOT_ID} .page-progress-track {
      height: 3px;
      background: rgba(0, 128, 96, 0.12);
    }
    #${ROOT_ID} .page-progress-fill {
      height: 100%;
      width: 0;
      background: #008060;
      transform-origin: left center;
      transition: width 180ms ease-out;
    }
    #${ROOT_ID} .page-progress-label {
      display: none;
      margin: 6px auto 0;
      width: max-content;
      max-width: min(92vw, 28rem);
      padding: 3px 10px;
      border-radius: 999px;
      background: #008060;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.01em;
      line-height: 1.3;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    }
    #${ROOT_ID}.is-active .page-progress-label { display: block; }
    @media print {
      #${ROOT_ID} { display: none !important; }
    }
  `;

  let current = { done: 0, total: 0, label: '' };
  let hideTimer = null;
  let generation = 0;

  function ensureDom() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = css;
      document.head.appendChild(style);
    }
    if (document.getElementById(ROOT_ID)) return;
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.hidden = true;
    root.innerHTML =
      '<div class="page-progress-track">' +
        '<div class="page-progress-fill" data-progress-fill role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Page loading"></div>' +
      '</div>' +
      '<p class="page-progress-label" data-progress-label></p>';
    document.body.prepend(root);
  }

  function render() {
    ensureDom();
    const root = document.getElementById(ROOT_ID);
    const fill = root.querySelector('[data-progress-fill]');
    const labelEl = root.querySelector('[data-progress-label]');
    const pct = current.total > 0
      ? Math.min(100, Math.round((current.done / current.total) * 100))
      : 0;
    fill.style.width = `${pct}%`;
    fill.setAttribute('aria-valuenow', String(pct));
    const remaining = current.total > 0 ? Math.max(0, current.total - current.done) : null;
    if (current.total > 1 && remaining !== null) {
      labelEl.textContent = remaining === 0
        ? `${current.label} · done`
        : `${current.label} · ${current.done} of ${current.total} (${remaining} left)`;
    } else {
      labelEl.textContent = current.label || 'Loading';
    }
    root.hidden = false;
    root.classList.add('is-active');
  }

  const pageProgress = {
    begin({ total = 0, label = 'Loading' } = {}) {
      generation += 1;
      clearTimeout(hideTimer);
      current = { done: 0, total: Math.max(0, total), label };
      render();
      return generation;
    },
    set({ done, total, label } = {}) {
      if (typeof done === 'number') current.done = Math.max(0, done);
      if (typeof total === 'number') current.total = Math.max(0, total);
      if (label) current.label = label;
      render();
    },
    advance(label) {
      if (current.total > 0) current.done = Math.min(current.total, current.done + 1);
      else current.done += 1;
      if (label) current.label = label;
      render();
    },
    finish() {
      if (current.total < 1) current.total = 1;
      current.done = current.total;
      render();
      const gen = generation;
      hideTimer = setTimeout(() => {
        if (gen !== generation) return;
        const root = document.getElementById(ROOT_ID);
        if (!root) return;
        root.classList.remove('is-active');
        root.hidden = true;
        current = { done: 0, total: 0, label: '' };
      }, 280);
    },
    fail() {
      generation += 1;
      clearTimeout(hideTimer);
      const root = document.getElementById(ROOT_ID);
      if (!root) return;
      root.classList.remove('is-active');
      root.hidden = true;
      current = { done: 0, total: 0, label: '' };
    },
  };

  /**
   * Reads a JSON body, or NDJSON `{type:progress|result|error}` from the
   * commissions/reports endpoints so the bar can track remaining companies.
   */
  async function fetchJsonWithProgress(url, options, onProgress) {
    const headers = new Headers(options?.headers || {});
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/x-ndjson, application/json');
    }
    const res = await global.shopifyApiFetch(url, { ...options, headers });
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok || !ctype.includes('ndjson') || !res.body) {
      const data = await res.json().catch(() => ({}));
      return { res, data };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result = null;
    let streamError = null;

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = JSON.parse(trimmed);
      if (msg.type === 'progress') {
        if (typeof onProgress === 'function') onProgress(msg);
      } else if (msg.type === 'result') {
        result = Object.assign({}, msg);
        delete result.type;
      } else if (msg.type === 'error') {
        streamError = new Error(msg.error || 'Request failed');
        streamError.code = msg.code;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) consumeLine(line);
    }
    if (buf.trim()) consumeLine(buf);
    if (streamError) throw streamError;
    return { res, data: result || {} };
  }

  function applyWorkProgress(msg) {
    if (!msg) return;
    if (msg.phase === 'companies') {
      const pct = msg.total ? (msg.done / msg.total) * 15 : 0;
      pageProgress.set({
        done: Math.round(pct),
        total: 100,
        label: msg.label || 'Loading companies',
      });
      return;
    }
    if (msg.phase === 'revenue') {
      const frac = msg.total ? msg.done / msg.total : 0;
      pageProgress.set({
        done: Math.round(15 + frac * 85),
        total: 100,
        label: msg.total
          ? `Calculating commissions`
          : (msg.label || 'Calculating commissions'),
      });
      if (msg.total) {
        const remaining = Math.max(0, msg.total - msg.done);
        const root = document.getElementById(ROOT_ID);
        const labelEl = root && root.querySelector('[data-progress-label]');
        if (labelEl) {
          labelEl.textContent = remaining === 0
            ? 'Calculating commissions · done'
            : `Calculating commissions · ${msg.done} of ${msg.total} (${remaining} left)`;
        }
      }
    }
  }

  global.pageProgress = pageProgress;
  global.fetchJsonWithProgress = fetchJsonWithProgress;
  global.applyWorkProgress = applyWorkProgress;
})(window);
