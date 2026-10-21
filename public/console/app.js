/* Marichi Fleet API console. Plain JavaScript; everything it shows comes from the API itself
   (/api/v1/meta/*), so new masters, fields and endpoints appear without changes here.
   Order is top-down: the core records a trip is built from, then the rules trips follow,
   then reference lists, then company setup. */
'use strict';

const API = '/api/v1';
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const state = {
  token: store.get('fe.token'), refresh: store.get('fe.refresh'),
  me: null, masters: [], overview: null, stats: [], log: [],
  openGroups: new Set(['core']), expanded: new Set(), refCache: new Map(), samples: new Map(),
};
const $app = document.getElementById('app');

/** How the models are presented, most important first. Models not listed fall into Reference lists. */
const TIERS = [
  { key: 'core', title: 'Core records', keys: ['vehicles', 'trailers', 'pairings', 'drivers', 'parties', 'places', 'routes', 'products', 'compliance-documents'] },
  { key: 'rules', title: 'Trip rules', keys: ['trip-types', 'trip-stages', 'trip-budgets', 'fuel-norms', 'advance-policies', 'expense-categories', 'expense-items', 'shortage-policies', 'recovery-rules', 'border-posts', 'stop-types', 'load-types', 'pod-types', 'cancellation-reasons'] },
  { key: 'lists', title: 'Reference lists', keys: ['vehicle-makes', 'vehicle-models', 'vehicle-types', 'trailer-types', 'licence-classes', 'document-types', 'permit-types', 'insurance-types', 'product-groups', 'fuel-types', 'countries', 'provinces', 'cities', 'units', 'unit-conversions', 'currencies', 'exchange-rates', 'payment-methods', 'order-sources'] },
  { key: 'setup', title: 'Company setup', keys: ['branches', 'users', 'roles', 'numbering-series', 'approval-policies', 'message-templates', 'notification-rules', 'print-layouts', 'lists', 'field-definitions', 'custom-masters'] },
];
/** custom-records is reached through each custom master, not on its own. */
const HIDDEN_MASTERS = new Set(['custom-records']);

/* ---------------- Utilities ---------------- */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Dates stored at midnight UTC are calendar dates (birthdays, expiries) and show without a time. */
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return esc(v);
  if (/T00:00:00(\.000)?Z$/.test(String(v))) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const short = (id) => (id ? `${String(id).slice(0, 6)}…${String(id).slice(-4)}` : '—');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const masterByKey = (k) => state.masters.find((m) => m.key === k);
const labelOf = (k) => masterByKey(k)?.label || k;
const countOf = (k) => state.stats.find((s) => s.key === k)?.total ?? 0;
const can = (resource, action) => (state.overview?.you?.permissions || []).some((p) => (p.resource === '*' || p.resource === resource) && (p.actions.includes('*') || p.actions.includes(action)));
const firstSentence = (s) => { const t = String(s || ''); const i = t.indexOf('. '); return i > 0 ? t.slice(0, i + 1) : t; };
const humanize = (path) => {
  const last = String(path).split('.').pop().replace(/Ids?$/, (x) => (x === 'Ids' ? 's' : ''));
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[-_]/g, ' ')
    .split(' ').map((w) => (w.length > 1 ? w.toLowerCase() : w)).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const getPath = (obj, path) => path.split('.').reduce((acc, k) => (Array.isArray(acc) ? acc.flatMap((x) => (x == null ? [] : [x[k]])) : acc?.[k]), obj);
const titleOf = (m, rec) => rec?.[m?.titleField] ?? rec?.name ?? rec?.title ?? rec?.code ?? rec?.id;

const ICON = {
  chev: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="m10.5 10.5 3 3"/></svg>',
  models: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.8" y="2" width="5.4" height="5" rx="1.2"/><rect x="8.8" y="9" width="5.4" height="5" rx="1.2"/><rect x="8.8" y="2" width="5.4" height="5" rx="1.2"/><path d="M4.5 7v4.5h4.3"/></svg>',
  api: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/></svg>',
  menu: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></svg>',
};
const logo = () => '<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="8" fill="#256451"/><rect x="1.5" y="1.5" width="29" height="29" rx="7.5" fill="none" stroke="rgba(255,255,255,.18)"/><path d="M8 23c3-6 6-8 9-8s5-2 7-7" fill="none" stroke="#f3e1b8" stroke-width="2.4" stroke-linecap="round"/><circle cx="24" cy="8" r="2.3" fill="#fff"/></svg>';
const brand = () => `<div class="side-brand">${logo()}<span><b>Marichi</b> Fleet <span>API</span></span></div>`;

function toast(message, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4200);
}

function jsonHtml(value) {
  const text = JSON.stringify(value, null, 2) ?? 'undefined';
  return esc(text).replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="j-k">${str}</span>${colon}` : `<span class="j-s">${str}</span>`;
    if (bool) return `<span class="j-b">${m}</span>`;
    if (m === 'null') return `<span class="j-z">${m}</span>`;
    return `<span class="j-n">${m}</span>`;
  });
}

function errorText(body) {
  if (!body || !body.error) return 'Request failed';
  const e = body.error;
  let text = `${e.code}: ${e.message}`;
  if (e.details) text += `\n${JSON.stringify(e.details, null, 2)}`;
  return text;
}

function resultHtml(r) {
  return `<div class="result ${r.ok ? 'ok' : 'bad'}"><div class="bar"><b>HTTP ${r.status}</b><span>${r.ms} ms</span>${r.entry?.requestId ? `<span class="mono">request ${esc(r.entry.requestId)}</span>` : ''}${r.entry?.rateLimit ? `<span>${esc(r.entry.rateLimit)}</span>` : ''}</div><pre class="json">${jsonHtml(r.data)}</pre></div>`;
}

/* ---------------- Model order and links ---------------- */

function tierOf(key) {
  return TIERS.find((t) => t.keys.includes(key)) || TIERS[2];
}
/** Models of a tier in their listed order, then any unlisted ones (new masters) at the end. */
function tierModels(tier) {
  const listed = tier.keys.map(masterByKey).filter(Boolean);
  const extra = tier.key === 'lists' ? state.masters.filter((m) => !HIDDEN_MASTERS.has(m.key) && !TIERS.some((t) => t.keys.includes(m.key))) : [];
  return [...listed, ...extra];
}
/** References a model makes, grouped by target. branchIds (on every master) is left out. */
function linksOut(m) {
  const by = new Map();
  for (const r of m.references || []) {
    if (r.path === 'branchIds' || r.usageOnly) continue;
    if (!by.has(r.target)) by.set(r.target, []);
    by.get(r.target).push(r);
  }
  return [...by.entries()].map(([target, refs]) => ({ target, refs }));
}
function linksIn(key) {
  return state.masters.filter((m) => m.key !== key && !HIDDEN_MASTERS.has(m.key)).map((m) => ({ m, refs: linksOut(m).find((l) => l.target === key)?.refs })).filter((x) => x.refs);
}
/** Own fields, required first, each followed by its nested fields. */
function orderedFields(m) {
  const own = m.fields.filter((f) => f.group === 'master' && !f.hidden);
  const depth = (f) => f.path.split('.').length - 1;
  const children = (path) => own.filter((f) => f.path.startsWith(`${path}.`) && depth(f) === path.split('.').length);
  const top = own.filter((f) => depth(f) === 0);
  const sorted = [...top.filter((f) => f.required), ...top.filter((f) => !f.required)];
  const out = [];
  const walk = (f) => { out.push({ f, depth: depth(f) }); children(f.path).forEach(walk); };
  sorted.forEach(walk);
  return out;
}
function uniqueFields(m) {
  const set = new Map();
  for (const i of m.indexes || []) {
    const keys = Object.keys(i.fields);
    if (i.unique && keys.length === 1) set.set(keys[0], i.partial ? 'unique when set' : 'unique');
  }
  return set;
}
function typeText(f) {
  if (f.ref) return `→ ${labelOf(f.ref)}`;
  if (f.enum) return 'choice';
  const t = { objectid: 'id', mixed: 'any', string: 'text' }[f.type] || f.type;
  return f.array ? `list of ${t}` : t;
}

/* ---------------- HTTP client with request log ---------------- */

async function call(method, path, { body, query, auth = true, quiet = false, retry = true } = {}) {
  const url = new URL(API + path, location.origin);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, v);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const started = performance.now();
  let res; let data = null;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  } catch (err) {
    res = { status: 0, headers: new Headers(), ok: false };
    data = { success: false, error: { code: 'NETWORK', message: String(err.message || err) } };
  }
  const ms = Math.round(performance.now() - started);
  const entry = {
    at: new Date(), method, path: url.pathname + url.search, status: res.status, ms,
    requestId: res.headers.get('x-request-id'),
    rateLimit: res.headers.get('ratelimit-remaining') !== null ? `${res.headers.get('ratelimit-remaining')}/${res.headers.get('ratelimit-limit')} left` : null,
    request: body === undefined ? undefined : redact(typeof body === 'string' ? safeParse(body) : body),
    response: data,
  };
  state.log.unshift(entry);
  state.log.length = Math.min(state.log.length, 200);
  if (res.status === 401 && auth && retry && state.refresh && !path.startsWith('/auth/')) {
    if (await refreshTokens()) return call(method, path, { body, query, auth, quiet, retry: false });
  }
  if (!res.ok && !quiet) toast(data?.error?.message || `HTTP ${res.status}`, true);
  return { ok: res.ok, status: res.status, data, ms, entry };
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };
/** Passwords and tokens never appear in the request log. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /password|token/i.test(k) ? '••••' : redact(v)]));
  return value;
}

async function refreshTokens() {
  const r = await call('POST', '/auth/refresh', { body: { refreshToken: state.refresh }, auth: false, quiet: true, retry: false });
  if (r.ok) { setTokens(r.data.data); return true; }
  signOutLocal();
  return false;
}
function setTokens(d) {
  state.token = d.accessToken; state.refresh = d.refreshToken;
  store.set('fe.token', state.token); store.set('fe.refresh', state.refresh);
}
function signOutLocal() {
  state.token = null; state.refresh = null; state.me = null; state.overview = null;
  store.set('fe.token', null); store.set('fe.refresh', null);
  renderAuth();
}

/* ---------------- Boot ---------------- */

async function boot() {
  const resetMatch = location.hash.match(/^#reset=([A-Za-z0-9_-]+)/);
  if (resetMatch) { renderAuth('reset', resetMatch[1]); return; }
  if (!state.token) { renderAuth(); return; }
  const me = await call('GET', '/auth/me', { quiet: true });
  if (!me.ok) { signOutLocal(); return; }
  state.me = me.data.data;
  await loadMeta();
  renderShell();
  if (!boot.bound) { window.addEventListener('hashchange', route); window.addEventListener('resize', () => redrawEdges()); boot.bound = true; }
  route();
}

async function loadMeta() {
  const [masters, overview, stats] = await Promise.all([call('GET', '/meta/masters'), call('GET', '/meta/overview'), call('GET', '/meta/stats')]);
  state.masters = masters.ok ? masters.data.data : [];
  state.overview = overview.ok ? overview.data.data : null;
  state.stats = stats.ok ? stats.data.data : [];
}
async function refreshCounts() {
  const s = await call('GET', '/meta/stats', { quiet: true });
  if (s.ok) state.stats = s.data.data;
  document.querySelectorAll('#nav [data-count]').forEach((el) => { el.textContent = countOf(el.dataset.count); });
}

/* ---------------- Sign in ---------------- */

function renderAuth(tab = 'login', token = '') {
  document.title = 'Sign in · Marichi Fleet API';
  $app.className = '';
  const tabs = [['login', 'Sign in'], ['register', 'Create account'], ['forgot', 'Forgot password'], ['reset', 'Reset password']];
  $app.innerHTML = `
  <div class="auth">
    <section class="auth-side">
      ${brand()}
      <ul><li>The first account on a fresh database becomes the Owner.</li><li>Later sign-ups get the read-only Viewer role.</li><li>Passwords need 8–128 characters with a letter and a digit.</li></ul>
    </section>
    <section class="auth-main">
      <h1>Fleet ERP models and API</h1>
      <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="authForm"></div>
    </section>
  </div>`;
  $app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.tab, token)));
  const forms = {
    login: [['email', 'E-mail', 'email'], ['password', 'Password', 'password']],
    register: [['name', 'Full name', 'text'], ['email', 'E-mail', 'email'], ['password', 'Password', 'password']],
    forgot: [['email', 'E-mail', 'email']],
    reset: [['token', 'Reset token', 'text'], ['password', 'New password', 'password']],
  };
  const labels = { login: 'Sign in', register: 'Create account', forgot: 'Send reset link', reset: 'Set new password' };
  document.getElementById('authForm').innerHTML = `<form class="form" id="af">${forms[tab].map(([n, l, t]) => `<label class="field"><span>${l}</span><input class="input" name="${n}" type="${t}" required ${n === 'token' ? `value="${esc(token)}"` : ''} autocomplete="${t === 'password' ? (tab === 'login' ? 'current-password' : 'new-password') : n}"></label>`).join('')}
    <div class="row"><button class="btn btn-primary" type="submit">${labels[tab]}</button></div><div id="authMsg" class="small"></div></form>`;
  document.getElementById('af').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const msg = document.getElementById('authMsg');
    const paths = { login: '/auth/login', register: '/auth/register', forgot: '/auth/forgot-password', reset: '/auth/reset-password' };
    const r = await call('POST', paths[tab], { body, auth: false, quiet: true });
    if (!r.ok) { msg.className = 'err'; msg.textContent = errorText(r.data); return; }
    if (tab === 'login' || tab === 'register') {
      setTokens(r.data.data);
      if (tab === 'register' && r.data.data.firstOwner) toast('Account created. You are the owner of this workspace.');
      history.replaceState(null, '', '#models');
      boot();
    } else if (tab === 'forgot') {
      msg.className = 'small';
      msg.textContent = r.data.message;
      if (r.data.data?.resetToken) { msg.textContent += ' The development server returned the token, so it is filled in for you.'; setTimeout(() => renderAuth('reset', r.data.data.resetToken), 900); }
    } else {
      history.replaceState(null, '', '#');
      msg.className = 'small'; msg.textContent = r.data.message;
      setTimeout(() => renderAuth('login'), 1200);
    }
  });
}

/* ---------------- Shell ---------------- */

function renderShell() {
  const user = state.me.user;
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  $app.className = '';
  $app.innerHTML = `
  <div class="shell" id="shell">
    <aside class="side">
      ${brand()}
      <div class="side-search"><input id="navFilter" placeholder="Find a model" aria-label="Find a model" autocomplete="off"></div>
      <nav class="nav" id="nav">
        <a class="nav-link" href="#models">${ICON.models}Models</a>
        <a class="nav-link" href="#api">${ICON.api}API testing</a>
        <div class="nav-gap"></div>
        ${TIERS.map((t) => `<div class="nav-group${state.openGroups.has(t.key) ? ' open' : ''}" data-group="${t.key}">
          <button type="button" aria-expanded="${state.openGroups.has(t.key)}">${ICON.chev}<span>${esc(t.title)}</span><span class="n">${tierModels(t).length}</span></button>
          <div class="items">${tierModels(t).map((m) => `<a class="nav-link" href="#model/${m.key}" data-label="${esc(m.label.toLowerCase())}"><span>${esc(m.label)}</span><span class="n" data-count="${m.key}">${countOf(m.key)}</span></a>`).join('')}</div>
        </div>`).join('')}
      </nav>
      <div class="side-foot">
        <a class="side-user" href="#account"><span class="avatar">${esc(initials)}</span><span><strong>${esc(user.name)}</strong><span>${esc(state.me.roles.map((r) => r.name).join(', ') || 'No role')}</span></span></a>
        <div class="side-tools"><a href="#company">Company</a><a href="#audit">Audit log</a><a href="#requests">Request log</a><button type="button" id="signOut">Sign out</button></div>
      </div>
    </aside>
    <div class="main">
      <div class="topbar"><button class="btn btn-sm" type="button" id="menuBtn">${ICON.menu}Menu</button><b>Marichi Fleet API</b></div>
      <main id="main"></main>
    </div>
  </div>`;
  document.getElementById('signOut').addEventListener('click', async () => { await call('POST', '/auth/logout', { quiet: true }); signOutLocal(); });
  document.getElementById('menuBtn').addEventListener('click', () => toggleMenu(true));
  document.querySelectorAll('.nav-group > button').forEach((b) => b.addEventListener('click', () => {
    const g = b.parentElement;
    const open = g.classList.toggle('open');
    b.setAttribute('aria-expanded', open);
    open ? state.openGroups.add(g.dataset.group) : state.openGroups.delete(g.dataset.group);
  }));
  document.getElementById('navFilter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.nav-group').forEach((g) => {
      let any = false;
      g.querySelectorAll('a[data-label]').forEach((a) => { const hit = !q || a.dataset.label.includes(q); a.hidden = !hit; any ||= hit; });
      g.hidden = Boolean(q) && !any;
      g.classList.toggle('open', q ? any : state.openGroups.has(g.dataset.group));
    });
  });
}

function toggleMenu(open) {
  const shell = document.getElementById('shell');
  shell?.classList.toggle('menu-open', open);
  document.querySelector('.menu-scrim')?.remove();
  if (open) {
    const s = document.createElement('div');
    s.className = 'scrim menu-scrim';
    s.addEventListener('click', () => toggleMenu(false));
    document.body.append(s);
  }
}

function setActiveNav(hash) {
  document.querySelectorAll('#nav a, .side-tools a, .side-user').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('on', hash === href || hash.startsWith(`${href}/`));
  });
}

const main = () => document.getElementById('main');

function route() {
  closeOverlays();
  toggleMenu(false);
  const hash = location.hash || '#models';
  const [, page, a, b] = hash.match(/^#([a-z]+)\/?([^/]*)\/?(.*)$/) || [];
  if (page === 'model' && a) {
    const tier = tierOf(a).key;
    if (!state.openGroups.has(tier)) {
      state.openGroups.add(tier);
      const g = document.querySelector(`.nav-group[data-group="${tier}"]`);
      g?.classList.add('open');
    }
  }
  setActiveNav(page === 'model' ? `#model/${a}` : hash);
  window.scrollTo(0, 0);
  state.redraw = null;
  if (page === 'model' && a) return renderModel(a, b || 'structure');
  if (page === 'custom' && a) return renderCustomRecords(a);
  if (page === 'api') return renderApiTesting();
  if (page === 'account') return renderAccount();
  if (page === 'company') return renderCompany();
  if (page === 'audit') return renderAudit();
  if (page === 'requests') return renderRequests();
  return renderModels();
}

function redrawEdges() { if (state.redraw) state.redraw(); }

/* ---------------- Edges (SVG over HTML) ---------------- */

function curve(a, b, sideA, sideB) {
  const dx = Math.max(36, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + sideA * dx},${a.y} ${b.x + sideB * dx},${b.y} ${b.x},${b.y}`;
}
/** Connects two boxes from the sides that face each other (or both right sides when stacked). */
function connect(box, ra, rb) {
  const ax = ra.left + ra.width / 2; const bx = rb.left + rb.width / 2;
  const ya = ra.top + ra.height / 2 - box.top; const yb = rb.top + rb.height / 2 - box.top;
  if (bx > ax + ra.width / 2) return { d: curve({ x: ra.right - box.left, y: ya }, { x: rb.left - box.left, y: yb }, 1, -1), end: { x: rb.left - box.left, y: yb } };
  if (bx < ax - ra.width / 2) return { d: curve({ x: ra.left - box.left, y: ya }, { x: rb.right - box.left, y: yb }, -1, 1), end: { x: rb.right - box.left, y: yb } };
  return { d: curve({ x: ra.right - box.left, y: ya }, { x: rb.right - box.left, y: yb }, 1, 1), end: { x: rb.right - box.left, y: yb } };
}

/* ---------------- Models (home) ---------------- */

function renderModels() {
  document.title = 'Models · Marichi Fleet API';
  const sys = state.overview?.system || {};
  const visible = state.masters.filter((m) => !HIDDEN_MASTERS.has(m.key));
  const records = state.stats.reduce((t, s) => t + s.total, 0);
  const showSample = records < 5 && can('company', 'update') && sys.environment !== 'production';
  const coreTier = TIERS[0];
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div>
      <h1>Models</h1>
      <div class="facts"><span><b>${visible.length}</b> models</span><span><b>${records}</b> records</span>
        <span class="status ${sys.mongo === 'connected' ? 'ok' : 'bad'}"><i></i>MongoDB ${esc(sys.mongo || 'unknown')}</span>
        <span class="muted">Redis ${esc(String(sys.redis || '').split(' (')[0])}</span><span class="muted">E-mail ${esc(String(sys.smtp || '').split(' (')[0])}</span></div>
    </div>
    <div class="row"><span class="key"><i></i>Points to</span><span class="key"><i class="in"></i>Used by</span></div></div>
    ${showSample ? `<div class="card"><div class="card-head"><h3>The database is empty</h3><button class="btn btn-primary" type="button" id="loadSample">Load sample data</button></div><div class="card-body muted">A Zambia–Tanzania–DRC fuel and copper operation: 109 records created through the same validated services.</div></div>` : ''}
    <div class="map" id="map">
      <svg class="map-svg" id="mapSvg" aria-hidden="true"></svg>
      <section class="tier core-tier">
        <h2>${esc(coreTier.title)}</h2>
        <div class="core-grid">${tierModels(coreTier).map((m) => `<a class="chip core" href="#model/${m.key}" data-key="${m.key}">
          <span class="core-top"><b>${esc(m.label)}</b><span class="n">${countOf(m.key)}</span></span>
          <span class="core-desc">${esc(firstSentence(m.description))}</span>
          <span class="core-meta">${plural(m.fields.filter((f) => f.group === 'master' && !f.hidden && !f.path.includes('.')).length, 'field')} · links to ${linksOut(m).length}</span>
        </a>`).join('')}</div>
      </section>
      ${TIERS.slice(1).map((t) => `<section class="tier">
        <h2>${esc(t.title)}</h2>
        <div class="area-grid">${areaBlocks(t)}</div>
      </section>`).join('')}
    </div>
  </div>`;
  const sample = document.getElementById('loadSample');
  if (sample) sample.addEventListener('click', async () => {
    sample.disabled = true;
    const r = await call('POST', '/meta/sample-data');
    if (r.ok) { toast(`Sample data loaded: ${r.data.data.created} records`); await loadMeta(); renderShell(); route(); } else sample.disabled = false;
  });
  bindMap();
}

/** Within a tier, models are boxed by their business area. */
function areaBlocks(tier) {
  const models = tierModels(tier);
  const areas = [...new Set(models.map((m) => m.group))];
  return areas.map((a) => `<div class="area"><h3>${esc(a)}<span>${models.filter((m) => m.group === a).length}</span></h3>
    ${models.filter((m) => m.group === a).map((m) => `<a class="chip" href="#model/${m.key}" data-key="${m.key}"><span>${esc(m.label)}</span><span class="n">${countOf(m.key)}</span></a>`).join('')}</div>`).join('');
}

function bindMap() {
  const map = document.getElementById('map');
  const svg = document.getElementById('mapSvg');
  let current = null;
  const draw = () => {
    map.querySelectorAll('.chip').forEach((c) => c.classList.remove('src', 'out', 'in'));
    svg.innerHTML = '';
    map.classList.toggle('focus', Boolean(current));
    if (!current) return;
    const m = masterByKey(current);
    const box = map.getBoundingClientRect();
    const el = (k) => map.querySelector(`.chip[data-key="${k}"]`);
    const src = el(current);
    if (!src) return;
    src.classList.add('src');
    const rs = src.getBoundingClientRect();
    let out = '';
    for (const l of linksOut(m)) {
      const t = el(l.target);
      if (!t || l.target === current) continue;
      t.classList.add('out');
      const c = connect(box, rs, t.getBoundingClientRect());
      out += `<path class="e-out" d="${c.d}"/><circle class="e-end" cx="${c.end.x}" cy="${c.end.y}" r="3"/>`;
    }
    for (const l of linksIn(current)) {
      const t = el(l.m.key);
      if (!t) continue;
      t.classList.add('in');
      const c = connect(box, t.getBoundingClientRect(), rs);
      out += `<path class="e-in" d="${c.d}"/><circle class="e-end in" cx="${c.end.x}" cy="${c.end.y}" r="3"/>`;
    }
    svg.innerHTML = out;
  };
  map.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('mouseenter', () => { current = c.dataset.key; draw(); });
    c.addEventListener('focus', () => { current = c.dataset.key; draw(); });
  });
  map.addEventListener('mouseleave', () => { current = null; draw(); });
  state.redraw = draw;
}

/* ---------------- Model page ---------------- */

const listState = {};

function renderModel(key, tab) {
  const m = masterByKey(key);
  if (!m) { main().innerHTML = '<div class="page"><p class="empty">Unknown model.</p></div>'; return; }
  document.title = `${m.label} · Marichi Fleet API`;
  const tabs = [['structure', 'Structure', ''], ['records', 'Records', countOf(key)], ['api', 'API', m.endpoints.length]];
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div>
      <div class="crumb"><a href="#models">${esc(tierOf(key).title)}</a><span>/</span><span>${esc(m.group)}</span></div>
      <h1>${esc(m.label)}</h1>
      <p>${esc(m.description)}</p>
    </div>
    <div class="seg" role="tablist">${tabs.map(([k, l, n]) => `<a role="tab" href="#model/${key}/${k}" class="${tab === k ? 'on' : ''}">${l}${n !== '' ? `<span class="count">${n}</span>` : ''}</a>`).join('')}</div></div>
    <div id="tabBody" class="stack"></div>
  </div>`;
  if (tab === 'records') return renderRecords(m);
  if (tab === 'api') return renderModelApi(m);
  return renderStructure(m);
}

/* ----- Structure ----- */

function renderStructure(m) {
  const body = document.getElementById('tabBody');
  const outs = linksOut(m);
  const ins = linksIn(m.key);
  const fields = orderedFields(m);
  const uniques = uniqueFields(m);
  const expanded = state.expanded.has(m.key);
  const LIMIT = 16;
  const shown = expanded ? fields : fields.slice(0, Math.max(LIMIT, fields.findIndex((x) => !x.f.required && x.depth === 0)));
  const hiddenCount = fields.length - shown.length;
  const std = m.fields.filter((f) => f.group === 'standard' && !f.path.includes('.'));
  const sys = m.fields.filter((f) => f.group === 'system');
  const showStd = state.expanded.has(`${m.key}:std`);
  const row = ({ f, depth }, extra = '') => `<div class="f-row${f.required ? ' req' : ''}${f.ref ? ' ref' : ''} d${Math.min(depth, 3)}${extra}" ${f.ref ? `data-ref="${esc(f.ref)}"` : ''} title="${esc(f.path)}${f.enum ? `: ${esc(f.enum.join(', '))}` : ''}">
      <span class="mk"></span><span class="nm">${esc(f.path.split('.').pop())}${uniques.has(f.path) ? `<span class="u">${uniques.get(f.path)}</span>` : ''}</span><span class="ty">${esc(typeText(f))}</span></div>`;
  body.innerHTML = `
  <div class="erd" id="erd">
    <svg class="erd-svg" id="erdSvg" aria-hidden="true"></svg>
    <div class="erd-col in">
      <h3>Used by</h3>
      ${ins.length ? ins.map(({ m: o, refs }) => `<a class="node in-node" href="#model/${o.key}" data-key="${o.key}"><b>${esc(o.label)}<span>${countOf(o.key)}</span></b><small>${esc(refs.map((r) => r.path).join(', '))}</small></a>`).join('') : '<p>No other model points here.</p>'}
    </div>
    <div class="entity" id="entity">
      <div class="entity-head"><b>${esc(m.label)}<span>${plural(countOf(m.key), 'record')}</span></b><small>${esc(m.collection)}</small></div>
      ${shown.map((x) => row(x)).join('')}
      ${hiddenCount > 0 ? `<button type="button" class="f-more" data-toggle="${m.key}"><span>Show ${plural(hiddenCount, 'more field')}</span><span>${esc(fields.slice(shown.length).filter((x) => !x.depth).map((x) => x.f.path).join(', '))}</span></button>` : expanded && fields.length > LIMIT ? `<button type="button" class="f-more" data-toggle="${m.key}"><span>Show fewer fields</span><span></span></button>` : ''}
      ${showStd ? std.map((f) => row({ f, depth: 0 }, ' std')).join('') : ''}
      <button type="button" class="f-more" data-toggle="${m.key}:std"><span>${showStd ? 'Hide' : 'Standard fields'} ${showStd ? '' : `<span class="muted">${std.length}</span>`}</span><span>${showStd ? '' : esc(std.map((f) => f.path).join(', '))}</span></button>
    </div>
    <div class="erd-col out">
      <h3>Points to</h3>
      ${outs.length ? outs.map(({ target, refs }) => `<a class="node" href="#model/${target}" data-key="${target}"><b>${esc(labelOf(target))}<span>${countOf(target)}</span></b><small>${esc(refs.map((r) => r.path).join(', '))}</small></a>`).join('') : '<p>This model points to no other model.</p>'}
    </div>
  </div>
  <div class="erd-key"><span class="key"><span class="mk req"></span>Required</span><span class="key"><span class="mk"></span>Optional</span><span class="key"><i></i>Points to</span><span class="key"><i class="in"></i>Used by</span></div>
  <div class="card"><div class="card-head"><h3>Rules</h3></div><div class="card-body"><ul class="rules">${rulesInWords(m, sys).map(([k, v]) => `<li><span>${esc(k)}</span><span>${v}</span></li>`).join('')}</ul></div></div>
  <div class="card">
    <details class="fold"><summary>${ICON.chev}Every field <span class="muted">${m.fields.length}</span></summary>${fieldTable(m)}</details>
    <details class="fold"><summary>${ICON.chev}Indexes <span class="muted">${m.indexes.length}</span></summary><div class="table-wrap"><table class="table"><thead><tr><th>Fields</th><th>Unique</th><th>Only when</th></tr></thead><tbody>${m.indexes.map((i) => `<tr><td class="mono">${esc(Object.entries(i.fields).map(([k, v]) => (v === 1 ? k : `${k} (${v})`)).join(' + '))}</td><td>${i.unique ? 'Yes' : ''}</td><td class="mono small">${i.partial ? esc(JSON.stringify(i.partial)) : ''}</td></tr>`).join('')}</tbody></table></div></details>
    ${m.filters.length ? `<details class="fold"><summary>${ICON.chev}List filters <span class="muted">${m.filters.length}</span></summary><div class="table-wrap"><table class="table"><thead><tr><th>Query parameter</th><th>Meaning</th><th>Accepts</th></tr></thead><tbody>${m.filters.map((f) => `<tr><td class="mono">${esc(f.key)}</td><td>${esc(f.description)}</td><td class="small muted">${esc(schemaText(f.schema))}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <details class="fold"><summary>${ICON.chev}Request body schemas</summary><div class="fold-body"><div class="grid-2"><div class="stack"><b class="small">Create (POST)</b><pre class="json">${jsonHtml(m.createSchema)}</pre></div><div class="stack"><b class="small">Update (PATCH)</b><pre class="json">${jsonHtml(m.updateSchema)}</pre></div></div></div></details>
  </div>`;
  body.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.toggle;
    state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    renderStructure(m);
  }));
  bindErd(m);
}

function bindErd(m) {
  const erd = document.getElementById('erd');
  const svg = document.getElementById('erdSvg');
  const entity = document.getElementById('entity');
  const draw = () => {
    if (getComputedStyle(svg).display === 'none') { svg.innerHTML = ''; return; }
    const box = erd.getBoundingClientRect();
    const head = entity.querySelector('.entity-head').getBoundingClientRect();
    const more = entity.querySelector('.f-more');
    let out = '';
    erd.querySelectorAll('.erd-col.out .node').forEach((node) => {
      const target = node.dataset.key;
      const rows = [...entity.querySelectorAll(`.f-row[data-ref="${CSS.escape(target)}"]`)];
      const rn = node.getBoundingClientRect();
      const starts = rows.length ? rows.map((r) => r.getBoundingClientRect()) : [more ? more.getBoundingClientRect() : head];
      for (const rr of starts) {
        const a = { x: rr.right - box.left, y: rr.top + rr.height / 2 - box.top };
        const b = { x: rn.left - box.left, y: rn.top + rn.height / 2 - box.top };
        out += `<path class="e-out" data-k="${esc(target)}" d="${curve(a, b, 1, -1)}"/><circle class="e-end" cx="${a.x}" cy="${a.y}" r="2.6"/>`;
      }
    });
    erd.querySelectorAll('.erd-col.in .node').forEach((node) => {
      const rn = node.getBoundingClientRect();
      const a = { x: rn.right - box.left, y: rn.top + rn.height / 2 - box.top };
      const b = { x: head.left - box.left, y: head.top + head.height / 2 - box.top };
      out += `<path class="e-in" data-k="${esc(node.dataset.key)}" d="${curve(a, b, 1, -1)}"/>`;
    });
    svg.innerHTML = out;
  };
  const hl = (key, on) => {
    erd.querySelectorAll(`[data-key="${CSS.escape(key)}"], .f-row[data-ref="${CSS.escape(key)}"]`).forEach((el) => el.classList.toggle('hl', on));
    svg.querySelectorAll(`path[data-k="${CSS.escape(key)}"]`).forEach((p) => p.classList.toggle('hl', on));
  };
  erd.querySelectorAll('.node[data-key]').forEach((n) => { n.addEventListener('mouseenter', () => hl(n.dataset.key, true)); n.addEventListener('mouseleave', () => hl(n.dataset.key, false)); });
  entity.querySelectorAll('.f-row[data-ref]').forEach((r) => { r.addEventListener('mouseenter', () => hl(r.dataset.ref, true)); r.addEventListener('mouseleave', () => hl(r.dataset.ref, false)); });
  state.redraw = draw;
  requestAnimationFrame(draw);
  document.fonts?.ready.then(() => { if (state.redraw === draw) draw(); });
}

function rulesInWords(m, sys) {
  const out = [];
  const unique = (m.indexes || []).filter((i) => i.unique).map((i) => {
    const keys = Object.keys(i.fields).filter((k) => k !== 'singleton');
    const name = keys.length > 1 ? `${keys[0]} within ${keys.slice(1).join(' + ')}` : keys[0];
    return `<span class="mono">${esc(name)}</span>${i.partial ? ' when set' : ''}`;
  }).filter((x) => !x.startsWith('<span class="mono"></span>'));
  out.push(['Shown as', `<span class="mono">${esc(m.titleField)}</span>; search covers <span class="mono">${esc(m.searchFields.join(', '))}</span>`]);
  if (unique.length) out.push(['Must be unique', unique.join(', ')]);
  const roles = (m.references || []).filter((r) => r.partyRoles);
  out.push(['Links', outsText(m) + (roles.length ? `. ${roles.map((r) => `<span class="mono">${esc(r.path)}</span> must be a party with role ${esc(r.partyRoles.map((x) => x.replace(/_/g, ' ')).join(' or '))}`).join('; ')}` : '')]);
  if (m.autoCode) out.push(['Code', 'Generated from the numbering series when left empty']);
  if (m.immutable.length) out.push(['Fixed after create', `<span class="mono">${esc(m.immutable.join(', '))}</span>`]);
  if (m.sensitive.length) out.push(['Sensitive', `<span class="mono">${esc(m.sensitive.join(', '))}</span> are masked unless the role has the sensitive permission`]);
  const managed = Object.keys(m.managed || {});
  out.push(['Lifecycle', managed.length ? `${esc(managed.join(', '))} go through this model's own endpoints (see API)` : 'Create, update with the current version, archive and restore. Delete works only when nothing refers to the record']);
  out.push(['Custom fields', m.customFieldsAllowed ? (m.customFields.length ? m.customFields.map((f) => `<span class="mono">${esc(f.key)}</span> (${esc(f.type)}${f.required ? ', required' : ''})`).join(', ') : 'Allowed, none defined yet') : 'Not allowed']);
  out.push(['On every record', `${esc(sys.map((f) => f.path).join(', '))}, set by the API`]);
  return out;
}
const outsText = (m) => {
  const outs = linksOut(m);
  return outs.length ? `Every linked record must exist and be active when saved (${outs.length} ${outs.length === 1 ? 'model' : 'models'})` : 'No links to other models';
};

function fieldTable(m) {
  const groups = [['master', 'Own'], ['standard', 'Standard'], ['system', 'System']];
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Field</th><th>Kind</th><th>Type</th><th>Rules</th></tr></thead><tbody>${groups.map(([g, label]) => m.fields.filter((f) => f.group === g).map((f) => `<tr><td class="mono">${esc(f.path)}</td><td class="muted small">${label}</td><td>${f.ref ? `<a href="#model/${esc(f.ref)}">${esc(typeText(f))}</a>` : esc(typeText(f))}</td><td><div class="tags">${f.required ? '<span class="tag pine">required</span>' : ''}${f.sensitive ? '<span class="tag brass">sensitive</span>' : ''}${f.immutable ? '<span class="tag">fixed</span>' : ''}${f.hidden ? '<span class="tag">internal</span>' : ''}${f.enum ? `<span class="small muted">${esc(f.enum.join(', '))}</span>` : ''}${f.default !== undefined ? `<span class="small muted">default ${esc(JSON.stringify(f.default))}</span>` : ''}${f.min !== undefined ? `<span class="small muted">min ${f.min}</span>` : ''}${f.max !== undefined ? `<span class="small muted">max ${f.max}</span>` : ''}</div></td></tr>`).join('')).join('')}</tbody></table></div>`;
}

function schemaText(s) {
  if (!s) return 'any';
  const formats = (s.anyOf || []).map((x) => x.format).filter(Boolean);
  const nullable = (s.anyOf || []).some((x) => x.type === 'null');
  if (formats.length && formats.every((f) => f === 'date' || f === 'date-time')) return `date (YYYY-MM-DD or ISO date-time)${nullable ? ', null clears' : ''}`;
  if (s.format === 'date' || s.format === 'date-time') return 'date (YYYY-MM-DD or ISO date-time)';
  if (s.anyOf) return s.anyOf.filter((x) => x.type !== 'null').map(schemaText).join(' or ') + (nullable ? ', null clears' : '');
  if (s.enum) return `one of ${s.enum.join(', ')}`;
  if (s.pattern === '^[0-9a-fA-F]{24}$') return 'record id';
  if (s.type === 'array') return `list of ${schemaText(s.items)}${s.maxItems ? ` (max ${s.maxItems})` : ''}`;
  if (s.type === 'object') return `object { ${Object.keys(s.properties || {}).join(', ')} }`;
  const bits = [s.type];
  if (s.format) bits.push(s.format);
  if (s.pattern && !s.format) bits.push(`pattern ${s.pattern}`);
  if (s.minLength !== undefined || s.maxLength !== undefined) bits.push(`${s.minLength ?? 0}–${s.maxLength ?? '∞'} chars`);
  if (s.minimum !== undefined || s.maximum !== undefined) bits.push(`${s.minimum ?? '−∞'} to ${s.maximum ?? '∞'}`);
  return bits.join(', ');
}

/* ----- Records ----- */

function columnsFor(m) {
  const title = m.titleField;
  const cols = [];
  if (m.fields.some((f) => f.path === 'code') && title !== 'code') cols.push('code');
  cols.push(title);
  const scalar = orderedFields(m).map((x) => x.f).filter((f) => !f.path.includes('.') && !f.array && !f.ref && ['string', 'number', 'boolean', 'date'].includes(f.type) && !cols.includes(f.path));
  for (const f of scalar) if (cols.length < 5) cols.push(f.path);
  return cols;
}

function cell(v, path, m) {
  if (v === undefined || v === null || v === '') return '<span class="muted">—</span>';
  const f = m?.fields.find((x) => x.path === path);
  if (f?.type === 'date') return fmtDate(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return `<span class="mono small">${esc(JSON.stringify(v).slice(0, 60))}</span>`;
  return esc(String(v).replace(/_/g, ' '));
}

function renderRecords(m) {
  const s = (listState[m.key] ||= { page: 1, limit: 20, search: '', status: '', sort: '', filters: {}, more: false });
  const body = document.getElementById('tabBody');
  const creatable = !m.managed.create || m.key === 'users' || m.key === 'pairings';
  const activeFilters = Object.values(s.filters).filter(Boolean).length + (s.sort ? 1 : 0);
  body.innerHTML = `
  <div class="card">
    <div class="card-head">
      <div class="toolbar">
        <label class="search">${ICON.search}<input id="q" placeholder="Search ${esc(m.label.toLowerCase())}" value="${esc(s.search)}" aria-label="Search"></label>
        <select class="input" id="status" aria-label="Status"><option value="">Active and inactive</option>${[['active', 'Active'], ['inactive', 'Inactive'], ['archived', 'Archived'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${s.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn" type="button" id="moreBtn" aria-expanded="${s.more}">Filters and sort${activeFilters ? ` · ${activeFilters}` : ''}</button>
      </div>
      ${creatable ? `<button class="btn btn-primary" type="button" id="newRec" ${can(m.key, 'create') ? '' : 'disabled title="Your role cannot create these"'}>${m.key === 'pairings' ? 'Pair a truck and trailer' : `New ${esc(m.singular.toLowerCase())}`}</button>` : ''}
    </div>
    <div class="card-body toolbar" id="more" ${s.more ? '' : 'hidden'}>
      ${m.filters.map((f) => filterControl(f, s.filters[f.key])).join('')}
      <label class="field"><span>Sort</span><select class="input" id="sort"><option value="">Default${m.defaultSort ? ` (${esc(m.defaultSort)})` : ''}</option>${m.sortFields.flatMap((f) => [f, `-${f}`]).map((v) => `<option ${s.sort === v ? 'selected' : ''} value="${esc(v)}">${esc(v.startsWith('-') ? `${v.slice(1)}, high to low` : `${v}, low to high`)}</option>`).join('')}</select></label>
      <label class="field"><span>Per page</span><select class="input" id="limit">${[10, 20, 50, 100].map((n) => `<option ${s.limit === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="btn btn-quiet btn-sm" type="button" id="clearFilters">Clear</button>
    </div>
    <div id="listBody"><div class="empty">Loading…</div></div>
  </div>`;
  const reload = () => loadRecords(m);
  let timer;
  document.getElementById('q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { s.search = e.target.value.trim(); s.page = 1; reload(); }, 250); });
  for (const id of ['status', 'sort', 'limit']) document.getElementById(id).addEventListener('change', (e) => { s[id] = id === 'limit' ? Number(e.target.value) : e.target.value; s.page = 1; id === 'status' ? reload() : renderRecords(m); });
  body.querySelectorAll('[data-filter]').forEach((el) => el.addEventListener('change', () => { s.filters[el.dataset.filter] = el.value; s.page = 1; renderRecords(m); }));
  document.getElementById('moreBtn').addEventListener('click', () => { s.more = !s.more; document.getElementById('more').hidden = !s.more; });
  document.getElementById('clearFilters').addEventListener('click', () => { s.filters = {}; s.sort = ''; s.page = 1; renderRecords(m); });
  const nb = document.getElementById('newRec');
  if (nb) nb.addEventListener('click', () => openEditor(m, null));
  reload();
}

function filterControl(f, value = '') {
  const sch = f.schema || {};
  const options = sch.enum || (sch.anyOf || []).flatMap((x) => x.enum || []);
  const label = `<span>${esc(humanize(f.key))}</span>`;
  if (options.length) return `<label class="field">${label}<select class="input" data-filter="${esc(f.key)}" title="${esc(f.description)}"><option value="">Any</option>${options.map((o) => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(String(o).replace(/_/g, ' '))}</option>`).join('')}</select></label>`;
  return `<label class="field">${label}<input class="input" data-filter="${esc(f.key)}" value="${esc(value)}" placeholder="${sch.pattern === '^[0-9a-fA-F]{24}$' ? 'Record id' : esc(f.description)}" size="20"></label>`;
}

async function loadRecords(m) {
  const s = listState[m.key];
  const query = { page: s.page, limit: s.limit, search: s.search, status: s.status, sort: s.sort, ...s.filters };
  const r = await call('GET', `/${m.key}`, { query, quiet: true });
  const box = document.getElementById('listBody');
  if (!box) return;
  if (!r.ok) { box.innerHTML = `<div class="card-body">${resultHtml(r)}</div>`; return; }
  const rows = r.data.data;
  const meta = r.data.meta;
  const cols = columnsFor(m);
  box.innerHTML = rows.length ? `
    <div class="table-wrap"><table class="table"><thead><tr>${cols.map((c) => `<th>${esc(humanize(c))}</th>`).join('')}<th>Status</th><th>Updated</th></tr></thead>
    <tbody>${rows.map((row) => `<tr class="click" data-id="${esc(row.id)}">${cols.map((c) => `<td>${cell(row[c], c, m)}</td>`).join('')}<td><span class="status ${esc(row.status)}"><i></i>${esc(row.status)}</span></td><td class="small muted">${fmtDate(row.updatedAt)}</td></tr>`).join('')}</tbody></table></div>
    <div class="pager"><span>${plural(meta.total, 'record')} · page ${meta.page} of ${Math.max(1, meta.totalPages)} · ${r.ms} ms</span>
      <span class="toolbar"><button class="btn btn-sm" type="button" id="prev" ${meta.hasPrevPage ? '' : 'disabled'}>Previous</button><button class="btn btn-sm" type="button" id="next" ${meta.hasNextPage ? '' : 'disabled'}>Next</button></span></div>`
    : `<div class="empty"><strong>No records match</strong>${can(m.key, 'create') ? '<span>Create one, or load the sample data from Models.</span>' : ''}</div>`;
  box.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openRecord(m, tr.dataset.id)));
  document.getElementById('prev')?.addEventListener('click', () => { s.page -= 1; loadRecords(m); });
  document.getElementById('next')?.addEventListener('click', () => { s.page += 1; loadRecords(m); });
}

/* ----- Record drawer ----- */

function closeOverlays() { document.querySelectorAll('.drawer, .modal, .scrim:not(.menu-scrim)').forEach((el) => el.remove()); }

function overlay(cls, html) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const el = document.createElement('div');
  el.className = cls;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = html;
  const close = () => { el.remove(); scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && el === [...document.querySelectorAll('.drawer, .modal')].pop()) close(); };
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(scrim, el);
  el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  el.close = close;
  return el;
}

/** Looks up the titles of linked records so the record reads as names, not ids. */
async function resolveRefs(m, rec) {
  const wanted = [];
  for (const f of m.fields) {
    if (!f.ref || f.group === 'system') continue;
    const v = getPath(rec, f.path);
    for (const id of [v].flat(Infinity)) if (typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id)) wanted.push([f.ref, id]);
  }
  const todo = [...new Map(wanted.map(([t, id]) => [`${t}/${id}`, [t, id]])).values()].filter(([t, id]) => !state.refCache.has(`${t}/${id}`)).slice(0, 30);
  await Promise.all(todo.map(async ([t, id]) => {
    const r = await call('GET', `/${t}/${id}`, { quiet: true });
    state.refCache.set(`${t}/${id}`, r.ok ? r.data.data : null);
  }));
}
function refHtml(target, id) {
  const rec = state.refCache.get(`${target}/${id}`);
  const tm = masterByKey(target);
  return `<span class="refv"><a href="#model/${esc(target)}/records" data-open="${esc(target)}:${esc(id)}">${esc(rec ? titleOf(tm, rec) : short(id))}</a><span class="id">${esc(tm?.singular || target)}</span></span>`;
}
function moneyHtml(v) {
  const cur = state.refCache.get(`currencies/${v.currencyId}`);
  const digits = cur?.minorUnits ?? 2;
  const amount = (Number(v.amountMinor) / 10 ** digits).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `<span class="num">${esc(amount)}</span> ${esc(cur?.code || '')}`;
}
function valueHtml(m, path, v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return null;
  const f = m.fields.find((x) => x.path === path);
  if (f?.ref) return [v].flat().map((id) => refHtml(f.ref, id)).join(', ');
  if (v && typeof v === 'object' && !Array.isArray(v) && 'amountMinor' in v && 'currencyId' in v) return moneyHtml(v);
  if (Array.isArray(v)) {
    if (v.every((x) => x && typeof x === 'object')) return v.map((item) => `<div class="kv">${kvRows(m, path, item)}</div>`).join('');
    return esc(v.join(', '));
  }
  if (v && typeof v === 'object') { const inner = kvRows(m, path, v); return inner ? `<div class="kv">${inner}</div>` : null; }
  if (f?.type === 'date') return fmtDate(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (f?.enum) return esc(String(v).replace(/_/g, ' '));
  return esc(v);
}
function kvRows(m, prefix, obj) {
  return Object.entries(obj).map(([k, v]) => { const html = valueHtml(m, prefix ? `${prefix}.${k}` : k, v); return html === null ? '' : `<div class="k">${esc(humanize(k))}</div><div>${html}</div>`; }).join('');
}
function recordView(m, rec) {
  const own = orderedFields(m).filter((x) => x.depth === 0).map((x) => x.f.path);
  const std = m.fields.filter((f) => f.group === 'standard' && !f.path.includes('.')).map((f) => f.path);
  const rows = (paths) => paths.map((p) => { const html = valueHtml(m, p, rec[p]); return html === null ? '' : `<div class="k">${esc(humanize(p))}</div><div>${html}</div>`; }).join('');
  const empty = own.filter((p) => valueHtml(m, p, rec[p]) === null);
  return `<div class="kv">${rows(own)}${rows(std.filter((p) => p !== 'status'))}</div>
    ${empty.length ? `<p class="hint">Empty: ${esc(empty.join(', '))}</p>` : ''}
    <div class="card"><details class="fold"><summary>${ICON.chev}Record details</summary><div class="fold-body"><div class="kv">
      <div class="k">Id</div><div class="mono">${esc(rec.id)}</div><div class="k">Version</div><div>${esc(rec.version)}</div>
      <div class="k">Created</div><div>${fmtDate(rec.createdAt)}</div><div class="k">Updated</div><div>${fmtDate(rec.updatedAt)}</div>
      ${rec.archivedAt ? `<div class="k">Archived</div><div>${fmtDate(rec.archivedAt)}${rec.archiveReason ? ` · ${esc(rec.archiveReason)}` : ''}</div>` : ''}
    </div></div></details></div>`;
}

async function openRecord(m, id, base = `/${m.key}`, refresh) {
  const r = await call('GET', `${base}/${id}`);
  if (!r.ok) return;
  const rec = r.data.data;
  const custom = base !== `/${m.key}`;
  if (!custom) await resolveRefs(m, rec);
  closeOverlays();
  const archived = rec.status === 'archived';
  const primary = []; const more = [];
  if (!m.managed.update && !archived) primary.push(`<button class="btn" type="button" data-act="edit" ${can(m.key, 'update') ? '' : 'disabled'}>Edit</button>`);
  if (m.key === 'custom-masters') primary.unshift('<button class="btn btn-primary" type="button" data-act="records">Open records</button>');
  if (m.key === 'pairings' && rec.open) primary.push('<button class="btn" type="button" data-act="end">End pairing</button>');
  if (m.key === 'numbering-series') primary.push('<button class="btn" type="button" data-act="preview">Preview next number</button><button class="btn" type="button" data-act="issue">Issue a number</button>');
  if (m.key === 'message-templates') primary.push('<button class="btn" type="button" data-act="render">Preview message</button>');
  if (m.key === 'users') more.push('<button class="btn" type="button" data-act="revoke">Sign out everywhere</button><button class="btn" type="button" data-act="unlock">Unlock</button>');
  if (!m.managed.archive) more.push(archived ? `<button class="btn" type="button" data-act="restore" ${can(m.key, 'archive') ? '' : 'disabled'}>Restore</button>` : `<button class="btn" type="button" data-act="archive" ${can(m.key, 'archive') ? '' : 'disabled'}>Archive</button>`);
  if (!m.managed.delete) more.push(`<button class="btn btn-danger" type="button" data-act="delete" ${can(m.key, 'delete') ? '' : 'disabled'}>Delete</button>`);
  const tabs = [['view', 'Details'], ['json', 'JSON'], ['usage', 'Used by'], ['history', 'History']].filter(([k]) => !custom || k === 'json' || k === 'view');
  const el = overlay('drawer', `
    <div class="drawer-head">
      <div class="row"><span class="crumb"><span>${esc(m.singular)}</span></span><span class="status ${esc(rec.status)}"><i></i>${esc(rec.status)}</span><span class="spacer"></span><button class="btn btn-quiet btn-sm" type="button" data-close>Close</button></div>
      <h2>${esc(titleOf(m, rec))}</h2>
      <div class="toolbar">${primary.join('')}${more.join('')}</div>
      <div class="seg">${tabs.map(([k, l], i) => `<button type="button" data-dt="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div>
    </div>
    <div class="drawer-body" id="drawerBody"></div>`);
  const db = el.querySelector('#drawerBody');
  db.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]');
    if (!a) return;
    e.preventDefault();
    const [t, rid] = a.dataset.open.split(':');
    openRecord(masterByKey(t), rid);
  });
  const show = async (k) => {
    el.querySelectorAll('[data-dt]').forEach((x) => x.classList.toggle('on', x.dataset.dt === k));
    if (k === 'view') db.innerHTML = custom ? `<div class="kv">${Object.entries(rec.data || {}).map(([dk, v]) => `<div class="k">${esc(humanize(dk))}</div><div>${esc(Array.isArray(v) ? v.join(', ') : v)}</div>`).join('')}</div>` : recordView(m, rec);
    if (k === 'json') db.innerHTML = `<pre class="json">${jsonHtml(rec)}</pre>`;
    if (k === 'usage') {
      const u = await call('GET', `/${m.key}/${id}/usage`);
      db.innerHTML = u.ok ? (u.data.data.usage.length ? `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Used by</th><th>Field</th><th class="r">Records</th></tr></thead><tbody>${u.data.data.usage.map((x) => `<tr><td>${esc(x.label)}</td><td class="mono small">${esc(x.path)}</td><td class="r num">${x.count}</td></tr>`).join('')}</tbody></table></div></div><p class="hint">It can be archived only when no active record uses it, and deleted only when nothing does.</p>` : '<div class="empty"><strong>Nothing uses this record</strong><span>It can be deleted.</span></div>') : '';
    }
    if (k === 'history') {
      const hi = await call('GET', `/${m.key}/${id}/history`, { query: { limit: 50 } });
      db.innerHTML = hi.ok ? (hi.data.data.map((a) => `<div class="card"><div class="card-head"><span><b>${esc(a.action)}</b> <span class="muted small">${fmtDate(a.at)}${a.actorName ? ` · ${esc(a.actorName)}` : ''}</span></span><span class="small muted">${esc(a.summary || '')}</span></div>${a.changes?.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>${a.changes.map((c) => `<tr><td class="mono small">${esc(c.path)}</td><td class="small">${esc(JSON.stringify(c.from) ?? '')}</td><td class="small">${esc(JSON.stringify(c.to) ?? '')}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`).join('') || '<p class="empty">No history.</p>') : '';
    }
  };
  el.querySelectorAll('[data-dt]').forEach((b) => b.addEventListener('click', () => show(b.dataset.dt)));
  show('view');
  const done = async (msg) => { toast(msg); closeOverlays(); (refresh || (() => loadRecords(m)))(); await refreshCounts(); };
  const result = (r2) => { db.insertAdjacentHTML('afterbegin', resultHtml(r2)); };
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (act === 'edit') return openEditor(m, rec, base, refresh);
    if (act === 'records') { closeOverlays(); location.hash = `#custom/${rec.id}`; return; }
    if (act === 'archive') {
      const reason = await ask('Archive this record', 'Reason (optional, kept in the audit log)');
      if (reason === null) return;
      const r2 = await call('POST', `${base}/${id}/archive`, { body: reason ? { reason } : {}, quiet: true });
      return r2.ok ? done('Archived') : result(r2);
    }
    if (act === 'restore') { const r2 = await call('POST', `${base}/${id}/restore`, { quiet: true }); return r2.ok ? done('Restored') : result(r2); }
    if (act === 'delete') {
      if (!(await confirmBox('Delete permanently?', 'This works only if nothing refers to it. Archiving is usually the right choice.'))) return;
      const r2 = await call('DELETE', `${base}/${id}`, { quiet: true });
      return r2.ok ? done('Deleted') : result(r2);
    }
    if (act === 'end') { const r2 = await call('POST', `/pairings/${id}/end`, { body: {}, quiet: true }); return r2.ok ? done('Pairing ended') : result(r2); }
    if (act === 'revoke') { const r2 = await call('POST', `/users/${id}/revoke-sessions`); if (r2.ok) toast('All sessions signed out'); }
    if (act === 'unlock') { const r2 = await call('POST', `/users/${id}/unlock`); if (r2.ok) toast('User unlocked'); }
    if (act === 'preview') result(await call('GET', `/numbering-series/${id}/preview`, { quiet: true }));
    if (act === 'issue') result(await call('POST', `/numbering-series/${id}/next`, { quiet: true }));
    if (act === 'render') result(await call('POST', `/message-templates/${id}/preview`, { body: {}, quiet: true }));
  }));
}

function confirmBox(title, text) {
  return new Promise((resolve) => {
    const el = overlay('modal small', `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-pad">${esc(text)}</div><div class="modal-foot"><span></span><span class="toolbar"><button class="btn" type="button" data-no>Cancel</button><button class="btn btn-danger" type="button" data-yes>Confirm</button></span></div>`);
    el.querySelector('[data-no]').addEventListener('click', () => { el.close(); resolve(false); });
    el.querySelector('[data-yes]').addEventListener('click', () => { el.close(); resolve(true); });
  });
}
function ask(title, label) {
  return new Promise((resolve) => {
    const el = overlay('modal small', `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-pad"><label class="field"><span>${esc(label)}</span><input class="input" id="askIn" maxlength="500"></label></div><div class="modal-foot"><span></span><span class="toolbar"><button class="btn" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>Continue</button></span></div>`);
    el.querySelector('#askIn').focus();
    el.querySelector('[data-no]').addEventListener('click', () => { el.close(); resolve(null); });
    el.querySelector('[data-yes]').addEventListener('click', () => { const v = el.querySelector('#askIn').value.trim(); el.close(); resolve(v); });
  });
}

/* ----- Editor ----- */

function exampleFor(schema, depth = 0) {
  if (!schema || depth > 4) return null;
  if (schema.anyOf) return exampleFor(schema.anyOf.find((s) => s.type !== 'null') || schema.anyOf[0], depth);
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const out = {};
      for (const k of schema.required || []) out[k] = exampleFor(schema.properties?.[k], depth + 1);
      return out;
    }
    case 'array': return schema.minItems ? [exampleFor(schema.items, depth + 1)] : [];
    case 'string': return schema.format === 'date' ? new Date().toISOString().slice(0, 10) : '';
    case 'number': case 'integer': return schema.minimum && schema.minimum > 0 ? schema.minimum : 0;
    case 'boolean': return false;
    default: return null;
  }
}

function guideHtml(m, schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const refs = new Map((m?.references || []).map((r) => [r.path.split('.')[0], r]));
  const keys = [...Object.keys(props).filter((k) => required.has(k)), ...Object.keys(props).filter((k) => !required.has(k))];
  return keys.map((k) => {
    const s = props[k];
    const ref = refs.get(k);
    const field = m?.fields.find((f) => f.path === k);
    return `<div><span class="row"><b>${esc(k)}</b>${required.has(k) ? '<span class="tag pine">required</span>' : ''}${field?.sensitive ? '<span class="tag brass">sensitive</span>' : ''}${m?.immutable?.includes(k) ? '<span class="tag">fixed after create</span>' : ''}</span>
      <span class="muted">${esc(schemaText(s))}</span>${ref ? `<span class="row">→ ${esc(labelOf(ref.target))}${ref.partyRoles ? ` with role ${esc(ref.partyRoles.join(' or '))}` : ''} <button class="btn btn-sm" type="button" data-pick="${esc(ref.target)}">Find id</button></span>` : ''}</div>`;
  }).join('');
}

/** JSON editor beside a field guide and a record finder. Used for create and update. */
function openEditor(m, rec, base = `/${m.key}`, refresh, opts = {}) {
  const isEdit = Boolean(rec);
  const special = m.key === 'pairings' ? m.endpoints.find((e) => e.method === 'POST' && e.path.endsWith('/pairings')) : null;
  const schema = opts.schema || (special ? special.schemas.body : isEdit ? m.updateSchema : m.createSchema);
  let initial;
  if (isEdit) {
    initial = { version: rec.version };
    for (const k of Object.keys(schema?.properties || {})) if (k !== 'version' && rec[k] !== undefined) initial[k] = rec[k];
  } else initial = opts.initial || exampleFor(schema) || {};
  const el = overlay('modal', `
    <div class="modal-head"><h2>${isEdit ? `Edit ${esc(m.singular.toLowerCase())}` : esc(opts.title || `New ${m.singular.toLowerCase()}`)}</h2><span class="mono small muted">${isEdit ? 'PATCH' : 'POST'} ${esc(API + base)}${isEdit ? `/${esc(rec.id)}` : ''}</span></div>
    <div class="modal-split">
      <div><textarea class="input" id="edJson" spellcheck="false" aria-label="Request body (JSON)">${esc(JSON.stringify(initial, null, 2))}</textarea><div id="edResult"></div></div>
      <div><div class="guide">${guideHtml(m, schema)}</div>
        <p class="hint">${isEdit ? 'Send what changes plus the version. Optional fields clear with null; a stale version returns 409.' : 'Required fields are filled with empty values. Use Find id for linked records.'}</p>
        <div id="picker"></div></div>
    </div>
    <div class="modal-foot"><span class="hint">Ctrl or ⌘ + Enter saves</span><span class="toolbar"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" id="edSend">${isEdit ? 'Save changes' : 'Create'}</button></span></div>`);
  const send = async () => {
    const box = el.querySelector('#edResult');
    let body;
    try { body = JSON.parse(el.querySelector('#edJson').value); } catch (err) { box.innerHTML = `<p class="err">Not valid JSON: ${esc(err.message)}</p>`; return; }
    const r = isEdit ? await call('PATCH', `${base}/${rec.id}`, { body, quiet: true }) : await call('POST', base, { body, quiet: true });
    if (r.ok) { toast(r.data.message || 'Saved'); closeOverlays(); state.refCache.clear(); (refresh || (() => loadRecords(m)))(); await refreshCounts(); return; }
    box.innerHTML = resultHtml(r);
  };
  el.querySelector('#edSend').addEventListener('click', send);
  el.querySelector('#edJson').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => picker(el.querySelector('#picker'), b.dataset.pick)));
}

async function picker(box, target) {
  const tm = masterByKey(target);
  box.innerHTML = `<div class="card"><div class="card-head"><h3>${esc(tm?.label || target)}</h3><label class="search">${ICON.search}<input id="pk" placeholder="Search" aria-label="Search ${esc(tm?.label || target)}"></label></div><div id="pkList" class="card-body guide"></div></div>`;
  const load = async (q) => {
    const r = await call('GET', `/${target}`, { query: { search: q, limit: 15, status: 'active' }, quiet: true });
    const list = box.querySelector('#pkList');
    if (!r.ok) { list.innerHTML = `<p class="err">${esc(errorText(r.data))}</p>`; return; }
    list.innerHTML = r.data.data.map((x) => `<div><span class="row"><span>${esc(titleOf(tm, x))}</span><span class="muted">${esc(x.code || '')}</span></span><span class="row"><code>${esc(x.id)}</code><button class="btn btn-sm" type="button" data-copy="${esc(x.id)}">Copy</button></span></div>`).join('') || '<p class="muted">No active records.</p>';
    list.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Id copied'); } catch { toast('Copy failed; select the id instead', true); }
    }));
  };
  let t;
  box.querySelector('#pk').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value.trim()), 250); });
  load('');
}

/* ---------------- API testing ---------------- */

const AUTH_LABELS = {
  'GET /api/v1/health': 'Health check', 'GET /api/v1/health/ready': 'Readiness (database reachable)',
  'POST /api/v1/auth/register': 'Create account', 'POST /api/v1/auth/login': 'Sign in', 'POST /api/v1/auth/refresh': 'Refresh tokens',
  'POST /api/v1/auth/forgot-password': 'Request a password reset', 'POST /api/v1/auth/reset-password': 'Reset password',
  'GET /api/v1/auth/me': 'Who am I', 'PATCH /api/v1/auth/me': 'Update my profile', 'GET /api/v1/auth/sessions': 'My signed-in devices',
  'POST /api/v1/auth/change-password': 'Change password', 'POST /api/v1/auth/logout': 'Sign out', 'POST /api/v1/auth/logout-all': 'Sign out everywhere',
  'GET /api/v1/company': 'Get the company', 'PUT /api/v1/company': 'Save the company', 'GET /api/v1/audit-logs': 'List the audit log',
};

function endpointLabel(e, m) {
  const fixed = AUTH_LABELS[`${e.method} ${e.path}`];
  if (fixed) return fixed;
  if (!m) return `${e.method} ${e.path}`;
  const one = m.singular.toLowerCase();
  const rest = e.path.slice(m.basePath.length);
  const std = { 'GET ': `List ${m.label.toLowerCase()}`, 'POST ': `Create a ${one}`, 'GET /:id': `Get one ${one}`, 'PATCH /:id': `Update a ${one}`, 'DELETE /:id': `Delete a ${one}`, 'POST /:id/archive': `Archive a ${one}`, 'POST /:id/restore': `Restore a ${one}`, 'GET /:id/usage': 'Where a record is used', 'GET /:id/history': 'Change history of a record' }[`${e.method} ${rest}`];
  if (std) return std;
  const words = rest.split('/').filter((s) => s && !s.startsWith(':')).map((s) => s.replace(/-/g, ' '));
  const text = words.join(' ').trim() || e.path;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Finds a real value for each :param by listing the collection in front of it. */
async function fillParams(path) {
  const segs = path.replace(/^\/api\/v1/, '').split('/');
  const values = {};
  let sample = null;
  for (let i = 0; i < segs.length; i += 1) {
    if (!segs[i].startsWith(':')) continue;
    let prefix = segs.slice(0, i).map((s) => (s.startsWith(':') ? values[s] || s : s)).join('/');
    const byCode = prefix.endsWith('/by-code');
    if (byCode) prefix = prefix.slice(0, -'/by-code'.length);
    if (!state.samples.has(prefix)) {
      const r = await call('GET', prefix, { query: { limit: 1, status: 'all' }, quiet: true });
      state.samples.set(prefix, r.ok && Array.isArray(r.data.data) ? r.data.data[0] || null : null);
    }
    sample = state.samples.get(prefix);
    values[segs[i]] = sample ? (byCode ? sample.code : sample.id) : '';
  }
  return { values, sample };
}

function apiWorkbench(box, groups, { filter = false } = {}) {
  const flat = groups.flatMap((g) => g.items);
  box.innerHTML = `<div class="card bench">
    <div class="eps">
      ${filter ? `<div class="card-body"><label class="search">${ICON.search}<input id="epFilter" placeholder="Filter endpoints" aria-label="Filter endpoints"></label></div>` : ''}
      <div id="epList"></div>
    </div>
    <div class="try" id="try"></div>
  </div>`;
  const list = box.querySelector('#epList');
  let selected = flat[0];
  const drawList = (q = '') => {
    list.innerHTML = groups.map((g, gi) => {
      const items = g.items.filter((it) => !q || `${it.e.method} ${it.e.path} ${it.label}`.toLowerCase().includes(q));
      if (!items.length) return '';
      const rows = items.map((it) => `<button type="button" class="ep${it === selected ? ' on' : ''}" data-i="${flat.indexOf(it)}"><span class="m ${it.e.method}">${it.e.method}</span><span class="lbl">${esc(it.label)}</span><span class="path">${esc(it.e.path.replace(/^\/api\/v1/, ''))}</span></button>`).join('');
      if (!g.fold) return `${g.title ? `<h4>${esc(g.title)}</h4>` : ''}${rows}`;
      return `<details class="fold" ${q || g.items.includes(selected) ? 'open' : ''} data-g="${gi}"><summary>${ICON.chev}${esc(g.title)} <span class="muted">${items.length}</span></summary>${rows}</details>`;
    }).join('') || '<p class="empty">No endpoint matches.</p>';
    list.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      selected = flat[Number(b.dataset.i)];
      list.querySelectorAll('.ep').forEach((x) => x.classList.toggle('on', x === b));
      drawTry(box.querySelector('#try'), selected);
    }));
  };
  box.querySelector('#epFilter')?.addEventListener('input', (e) => drawList(e.target.value.trim().toLowerCase()));
  drawList();
  if (selected) drawTry(box.querySelector('#try'), selected);
}

async function drawTry(panel, { e, m, label }) {
  const params = (e.path.match(/:[A-Za-z]+/g) || []);
  const hasBody = ['POST', 'PATCH', 'PUT'].includes(e.method);
  const limits = (e.rateLimits || []).map((r) => `${r.limit} per ${r.windowSeconds >= 3600 ? `${r.windowSeconds / 3600} h` : `${r.windowSeconds / 60} min`}`).join('; ');
  panel.innerHTML = `
    <div class="try-head"><h3>${esc(label)}</h3>
      <div class="facts small"><span>Needs <span class="mono">${esc(e.permission || (e.authenticated ? 'signed in' : 'nothing (public)'))}</span></span>${limits ? `<span>Limit ${esc(limits)}</span>` : ''}${Object.keys(e.schemas || {}).length ? `<span>Validates ${esc(Object.keys(e.schemas).join(', '))}</span>` : ''}</div></div>
    <div class="try-url"><span class="m ${e.method}">${e.method}</span><span id="tUrl">${esc(e.path)}</span></div>
    ${params.length ? `<div class="toolbar">${params.map((p) => `<label class="field"><span>${esc(p.slice(1))}</span><input class="input mono" data-param="${esc(p)}" size="28" placeholder="loading…"></label>`).join('')}</div>` : ''}
    ${e.method === 'GET' || e.schemas?.query ? `<label class="field"><span>Query string</span><input class="input mono" id="tQuery" value="${e.schemas?.query?.properties?.limit ? 'limit=5' : ''}" placeholder="page=1&amp;limit=20"></label>` : ''}
    ${hasBody ? `<label class="field"><span>Body</span><textarea class="input" id="tBody" rows="10" spellcheck="false">${esc(JSON.stringify(e.schemas?.body ? exampleFor(e.schemas.body) ?? {} : {}, null, 2))}</textarea></label>` : ''}
    <div class="row"><button class="btn btn-primary" type="button" id="tSend">Send request</button>${Object.keys(e.schemas || {}).length ? '<button class="btn btn-quiet" type="button" id="tSchema">Show request schema</button>' : ''}<span class="hint">Every request is kept in the request log.</span></div>
    <div id="tSchemaBox" hidden>${Object.entries(e.schemas || {}).map(([k, s]) => `<p class="small muted">${esc(k)}</p><pre class="json">${jsonHtml(s)}</pre>`).join('')}</div>
    <div id="tOut"></div>`;
  const url = () => {
    let p = e.path;
    panel.querySelectorAll('[data-param]').forEach((i) => { p = p.replace(i.dataset.param, i.value.trim() || i.dataset.param); });
    const q = panel.querySelector('#tQuery')?.value.trim();
    return p + (q ? `?${q}` : '');
  };
  const syncUrl = () => { panel.querySelector('#tUrl').textContent = url(); };
  panel.querySelectorAll('input').forEach((i) => i.addEventListener('input', syncUrl));
  panel.querySelector('#tSchema')?.addEventListener('click', (ev) => { const b = panel.querySelector('#tSchemaBox'); b.hidden = !b.hidden; ev.target.textContent = b.hidden ? 'Show request schema' : 'Hide request schema'; });
  panel.querySelector('#tSend').addEventListener('click', async () => {
    const [p, q] = url().replace(/^\/api\/v1/, '').split('?');
    const raw = panel.querySelector('#tBody')?.value;
    const r = await call(e.method, p, { query: Object.fromEntries(new URLSearchParams(q || '')), body: raw === undefined ? undefined : raw, quiet: true });
    panel.querySelector('#tOut').innerHTML = resultHtml(r);
  });
  if (params.length) {
    const { values, sample } = await fillParams(e.path);
    if (!panel.isConnected) return;
    panel.querySelectorAll('[data-param]').forEach((i) => { i.value = values[i.dataset.param] || ''; i.placeholder = 'no record found'; });
    const body = panel.querySelector('#tBody');
    if (body && e.method === 'PATCH' && sample?.version !== undefined && m) body.value = JSON.stringify({ version: sample.version }, null, 2);
    syncUrl();
  }
}

function modelEndpoints(m) {
  return m.endpoints.map((e) => ({ e, m, label: endpointLabel(e, m) }));
}

function renderModelApi(m) {
  apiWorkbench(document.getElementById('tabBody'), [{ title: '', items: modelEndpoints(m) }]);
}

function renderApiTesting() {
  document.title = 'API testing · Marichi Fleet API';
  const general = (state.overview?.endpoints || []).map((e) => ({ e, m: null, label: endpointLabel(e, null) }));
  const pick = (re) => general.filter((it) => re.test(it.e.path));
  const groups = [
    { title: 'Sign-in and account', items: pick(/\/auth\//) },
    { title: 'Company and audit log', items: pick(/\/(company|audit-logs)/) },
    { title: 'Health', items: pick(/\/health/) },
    ...TIERS.flatMap((t) => tierModels(t).map((m) => ({ title: m.label, fold: true, items: modelEndpoints(m) }))),
  ].filter((g) => g.items.length);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const limits = state.overview?.limits || {};
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div><h1>API testing</h1>
      <div class="facts"><span><b>${total}</b> endpoints</span><span>Base <span class="mono">${API}</span></span><span>Bearer token sent for you</span></div></div></div>
    <div id="bench"></div>
    <div class="card">
      <details class="fold"><summary>${ICON.chev}Response format</summary><div class="fold-body"><pre class="json">${jsonHtml({ success: true, data: '…', meta: { page: 1, limit: 20, total: 0 }, message: 'optional' })}</pre><pre class="json">${jsonHtml({ success: false, error: { code: 'VALIDATION_ERROR', message: '…', details: '[…]' }, requestId: '…' })}</pre></div></details>
      <details class="fold"><summary>${ICON.chev}Limits</summary><div class="table-wrap"><table class="table"><tbody>${Object.entries(limits).map(([k, v]) => `<tr><td>${esc(humanize(k))}</td><td class="mono small">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('')}</tbody></table></div></details>
      <details class="fold"><summary>${ICON.chev}Error codes</summary><div class="table-wrap"><table class="table"><thead><tr><th>HTTP</th><th>Code</th><th>When</th></tr></thead><tbody>
        ${[[400, 'BAD_REQUEST', 'Malformed JSON, operator-like keys ($, dots), wrong types'], [401, 'UNAUTHORIZED', 'Missing, expired or revoked token; wrong e-mail or password'], [403, 'FORBIDDEN', 'The role lacks the permission; account deactivated'], [404, 'NOT_FOUND', 'Record or route does not exist'], [409, 'CONFLICT', 'Duplicate value, stale version, record in use, state conflict'], [413, 'PAYLOAD_TOO_LARGE', 'Body over 1 MB'], [422, 'VALIDATION_ERROR', 'Schema or business rule failed; details list each field'], [429, 'TOO_MANY_REQUESTS', 'Rate limit hit or account temporarily locked'], [500, 'INTERNAL_SERVER_ERROR', 'Unexpected failure (details hidden in production)'], [503, 'SERVICE_UNAVAILABLE', 'Database not reachable']].map(([s, c, w]) => `<tr><td class="num">${s}</td><td class="mono">${c}</td><td>${w}</td></tr>`).join('')}
      </tbody></table></div></details>
    </div>
  </div>`;
  apiWorkbench(document.getElementById('bench'), groups, { filter: true });
}

/* ---------------- Custom master records ---------------- */

async function renderCustomRecords(masterId) {
  const def = await call('GET', `/custom-masters/${masterId}`);
  if (!def.ok) { main().innerHTML = '<div class="page"><p class="empty">Custom master not found.</p></div>'; return; }
  const cm = def.data.data;
  const base = `/custom-masters/${masterId}/records`;
  const rm = masterByKey('custom-records');
  const fieldsSchema = { type: 'object', required: ['data'], properties: { data: { type: 'object', required: cm.fields.filter((f) => f.required).map((f) => f.key), properties: Object.fromEntries(cm.fields.map((f) => [f.key, { type: f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : f.type === 'multi_select' ? 'array' : 'string', ...(f.options ? { enum: f.options } : {}) }])) } } };
  const cols = cm.fields.filter((f) => f.key !== cm.titleField).slice(0, 4);
  document.title = `${cm.name} · Marichi Fleet API`;
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div><div class="crumb"><a href="#model/custom-masters">Custom masters</a><span>/</span><span class="mono">${esc(API + base)}</span></div><h1>${esc(cm.name)}</h1>${cm.description ? `<p>${esc(cm.description)}</p>` : ''}</div></div>
    <div class="card"><div class="card-head"><h3>Fields</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Rules</th></tr></thead><tbody>${cm.fields.map((f) => `<tr><td class="mono">${esc(f.key)}</td><td>${esc(f.label)}</td><td>${esc(f.type)}${f.referenceMaster ? ` → <a href="#model/${esc(f.referenceMaster)}">${esc(labelOf(f.referenceMaster))}</a>` : ''}</td><td><div class="tags">${f.required ? '<span class="tag pine">required</span>' : ''}${f.key === cm.titleField ? '<span class="tag">title</span>' : ''}<span class="small muted">${esc((f.options || []).join(', '))}${f.pattern ? ` pattern ${esc(f.pattern)}` : ''}</span></div></td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><div class="card-head"><label class="search">${ICON.search}<input id="cq" placeholder="Search by title" aria-label="Search records"></label><button class="btn btn-primary" type="button" id="cNew" ${can('custom-records', 'create') ? '' : 'disabled'}>New record</button></div><div id="cList"></div></div>
  </div>`;
  const load = async (q = '') => {
    const r = await call('GET', base, { query: { search: q, limit: 100, status: 'all' }, quiet: true });
    const box = document.getElementById('cList');
    if (!r.ok) { box.innerHTML = `<div class="card-body">${resultHtml(r)}</div>`; return; }
    box.innerHTML = r.data.data.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Title</th>${cols.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th>Status</th></tr></thead><tbody>${r.data.data.map((x) => `<tr class="click" data-id="${esc(x.id)}"><td>${esc(x.title)}</td>${cols.map((f) => `<td>${esc(Array.isArray(x.data[f.key]) ? x.data[f.key].join(', ') : x.data[f.key] ?? '—')}</td>`).join('')}<td><span class="status ${esc(x.status)}"><i></i>${esc(x.status)}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No records yet.</p>';
    box.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openRecord(rm, tr.dataset.id, base, () => load(document.getElementById('cq').value))));
  };
  let t;
  document.getElementById('cq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value.trim()), 250); });
  document.getElementById('cNew').addEventListener('click', () => openEditor({ ...rm, references: [] }, null, base, () => load(), { schema: fieldsSchema, title: `New ${cm.name} record`, initial: { data: Object.fromEntries(cm.fields.filter((f) => f.required).map((f) => [f.key, ''])) } }));
  load();
}

/* ---------------- Account ---------------- */

async function renderAccount() {
  document.title = 'Account · Marichi Fleet API';
  const sessions = await call('GET', '/auth/sessions', { quiet: true });
  const u = state.me.user;
  const you = state.overview?.you || {};
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div><h1>${esc(u.name)}</h1><div class="facts"><span>${esc(u.email)}</span><span>${esc((you.roles || []).join(', ') || 'No role')}</span></div></div></div>
    <div class="grid-2">
      <div class="card"><div class="card-head"><h3>Profile</h3></div><form class="card-body form" id="pf"><label class="field"><span>Name</span><input class="input" name="name" value="${esc(u.name)}"></label><label class="field"><span>Phone</span><input class="input" name="phone" value="${esc(u.phone || '')}" placeholder="+260…"></label><div class="row"><button class="btn" type="submit">Save profile</button></div></form></div>
      <div class="card"><div class="card-head"><h3>Password</h3></div><form class="card-body form" id="cp"><label class="field"><span>Current password</span><input class="input" type="password" name="currentPassword" required autocomplete="current-password"></label><label class="field"><span>New password</span><input class="input" type="password" name="newPassword" required autocomplete="new-password"></label><div class="row"><button class="btn" type="submit">Change password</button><span class="hint">Signs out every other device</span></div></form></div>
    </div>
    <div class="card"><div class="card-head"><h3>Signed-in devices</h3><button class="btn btn-danger btn-sm" type="button" id="la">Sign out everywhere</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Expires</th><th></th></tr></thead><tbody>${(sessions.ok ? sessions.data.data : []).map((s) => `<tr><td class="small">${esc((s.userAgent || 'Unknown').slice(0, 80))}</td><td class="mono small">${esc(s.ip || '')}</td><td class="small">${fmtDate(s.createdAt)}</td><td class="small">${fmtDate(s.expiresAt)}</td><td>${s.current ? '<span class="status ok"><i></i>This session</span>' : ''}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card">
      <details class="fold"><summary>${ICON.chev}What your roles allow <span class="muted">${(you.permissions || []).length}</span></summary><div class="table-wrap"><table class="table"><thead><tr><th>Resource</th><th>Actions</th></tr></thead><tbody>${(you.permissions || []).map((p) => `<tr><td class="mono">${esc(p.resource === '*' ? 'every master' : p.resource)}</td><td>${esc(p.actions.includes('*') ? 'all' : p.actions.join(', '))}</td></tr>`).join('')}</tbody></table></div></details>
      <details class="fold"><summary>${ICON.chev}Test the password reset</summary><div class="fold-body"><form class="form" id="fp"><label class="field"><span>E-mail</span><input class="input" name="email" type="email" value="${esc(u.email)}"></label><div class="row"><button class="btn" type="submit">Request reset</button></div></form><div id="fpOut"></div></div></details>
      <details class="fold"><summary>${ICON.chev}Access token</summary><div class="fold-body"><textarea class="input" rows="5" readonly aria-label="Access token">${esc(state.token)}</textarea><p class="hint">Sent as Authorization: Bearer. Renewed with the refresh token when it expires.</p></div></details>
    </div>
  </div>`;
  document.getElementById('pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await call('PATCH', '/auth/me', { body: { name: f.name, phone: f.phone ? f.phone : null } });
    if (r.ok) { state.me = r.data.data; toast('Profile saved'); }
  });
  document.getElementById('cp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await call('POST', '/auth/change-password', { body: Object.fromEntries(new FormData(e.target)) });
    if (r.ok) { setTokens(r.data.data); toast('Password changed'); e.target.reset(); }
  });
  document.getElementById('la').addEventListener('click', async () => {
    if (!(await confirmBox('Sign out everywhere?', 'Every device, including this one, will need to sign in again.'))) return;
    await call('POST', '/auth/logout-all');
    signOutLocal();
  });
  document.getElementById('fp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await call('POST', '/auth/forgot-password', { body: Object.fromEntries(new FormData(e.target)), auth: false, quiet: true });
    document.getElementById('fpOut').innerHTML = resultHtml(r);
  });
}

/* ---------------- Company ---------------- */

async function renderCompany() {
  document.title = 'Company · Marichi Fleet API';
  const r = await call('GET', '/company', { quiet: true });
  const current = r.ok ? r.data.data : null;
  const editable = current ? Object.fromEntries(Object.entries(current).filter(([k]) => !['id', 'createdAt', 'updatedAt', 'updatedBy', 'singleton'].includes(k))) : { legalName: '' };
  const view = current ? Object.entries(editable).map(([k, v]) => (v === null || v === undefined || v === '' ? '' : `<div class="k">${esc(humanize(k))}</div><div>${typeof v === 'object' ? `<span class="mono small">${esc(JSON.stringify(v))}</span>` : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : esc(v)}</div>`)).join('') : '';
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div><h1>${esc(current?.tradingName || current?.legalName || 'Company')}</h1>${current ? `<div class="facts"><span>Updated ${fmtDate(current.updatedAt)}</span></div>` : ''}</div></div>
    <div class="grid-2">
      <div class="card"><div class="card-head"><h3>Saved details</h3></div><div class="card-body">${current ? `<div class="kv">${view}</div>` : '<p class="muted">Not saved yet. Save a legal name to create it.</p>'}</div></div>
      <div class="card"><div class="card-head"><h3>Edit</h3><button class="btn btn-primary btn-sm" type="button" id="cs" ${can('company', 'update') ? '' : 'disabled'}>Save</button></div><div class="card-body stack"><textarea class="input" id="cj" rows="22" spellcheck="false" aria-label="Company JSON">${esc(JSON.stringify(editable, null, 2))}</textarea><div id="co"></div></div></div>
    </div>
  </div>`;
  document.getElementById('cs').addEventListener('click', async () => {
    let body;
    try { body = JSON.parse(document.getElementById('cj').value); } catch (e) { document.getElementById('co').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const res = await call('PUT', '/company', { body, quiet: true });
    if (res.ok) { toast('Company saved'); renderCompany(); } else document.getElementById('co').innerHTML = resultHtml(res);
  });
}

/* ---------------- Audit log ---------------- */

const auditState = { page: 1, entity: '', action: '' };
async function renderAudit() {
  document.title = 'Audit log · Marichi Fleet API';
  const r = await call('GET', '/audit-logs', { query: { page: auditState.page, limit: 50, entity: auditState.entity, action: auditState.action }, quiet: true });
  const entities = [...TIERS.flatMap((t) => tierModels(t)).map((m) => [m.key, m.label]), ['company', 'Company']];
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div><h1>Audit log</h1></div></div>
    <div class="card"><div class="card-head"><div class="toolbar">
      <select class="input" id="ae" aria-label="Model"><option value="">Every model</option>${entities.map(([k, l]) => `<option value="${esc(k)}" ${auditState.entity === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select class="input" id="aa" aria-label="Action"><option value="">Every action</option>${['create', 'update', 'archive', 'restore', 'delete', 'custom'].map((a) => `<option ${auditState.action === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
    </div></div>
    ${r.ok ? (r.data.data.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Model</th><th>Record</th><th>Changes</th></tr></thead><tbody>${r.data.data.map((a) => `<tr><td class="small">${fmtDate(a.at)}</td><td class="small">${esc(a.actorName || '—')}</td><td>${esc(a.action)}</td><td class="small">${esc(labelOf(a.entity))}</td><td class="mono small">${short(a.entityId)}</td><td class="small">${esc(a.summary || '')}${(a.changes || []).slice(0, 6).map((c) => `<div><span class="mono">${esc(c.path)}</span>: ${esc(JSON.stringify(c.from) ?? '')} → ${esc(JSON.stringify(c.to) ?? '')}</div>`).join('')}${(a.changes || []).length > 6 ? `<div class="muted">+${a.changes.length - 6} more</div>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="pager"><span>${plural(r.data.meta.total, 'entry').replace('entrys', 'entries')} · page ${r.data.meta.page} of ${Math.max(1, r.data.meta.totalPages)}</span><span class="toolbar"><button class="btn btn-sm" type="button" id="ap" ${r.data.meta.hasPrevPage ? '' : 'disabled'}>Previous</button><button class="btn btn-sm" type="button" id="an" ${r.data.meta.hasNextPage ? '' : 'disabled'}>Next</button></span></div>` : '<p class="empty">No entries.</p>') : `<div class="card-body">${resultHtml(r)}</div>`}
    </div>
  </div>`;
  document.getElementById('ae').addEventListener('change', (e) => { auditState.entity = e.target.value; auditState.page = 1; renderAudit(); });
  document.getElementById('aa').addEventListener('change', (e) => { auditState.action = e.target.value; auditState.page = 1; renderAudit(); });
  document.getElementById('ap')?.addEventListener('click', () => { auditState.page -= 1; renderAudit(); });
  document.getElementById('an')?.addEventListener('click', () => { auditState.page += 1; renderAudit(); });
}

/* ---------------- Request log ---------------- */

function renderRequests() {
  document.title = 'Request log · Marichi Fleet API';
  main().innerHTML = `
  <div class="page">
    <div class="page-head"><div><h1>Request log</h1><div class="facts"><span>${plural(state.log.length, 'request')} from this tab, newest first</span></div></div><button class="btn btn-sm" type="button" id="clr">Clear</button></div>
    <div class="card">
    ${state.log.map((e) => `<details class="log"><summary><span class="small muted">${e.at.toLocaleTimeString()}</span><span class="m ${e.method}">${e.method}</span><span class="mono small">${esc(e.path)}</span><span class="status ${e.status >= 200 && e.status < 300 ? 'ok' : e.status >= 500 || e.status === 0 ? 'bad' : 'wait'}">${e.status}</span><span class="small muted">${e.ms} ms</span></summary><div>${e.requestId ? `<span class="small muted">Request id <span class="mono">${esc(e.requestId)}</span>${e.rateLimit ? ` · ${esc(e.rateLimit)}` : ''}</span>` : ''}${e.request !== undefined ? `<b class="small">Sent</b><pre class="json">${jsonHtml(e.request)}</pre>` : ''}<b class="small">Received</b><pre class="json">${jsonHtml(e.response)}</pre></div></details>`).join('') || '<p class="empty">No requests yet.</p>'}
    </div>
  </div>`;
  document.getElementById('clr').addEventListener('click', () => { state.log = []; renderRequests(); });
}

boot();
