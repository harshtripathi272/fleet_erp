/* Fleet ERP API console. Plain JavaScript; everything it shows comes from the API itself
   (/api/v1/meta/*), so new masters, fields and endpoints appear without changes here. */
'use strict';

const API = '/api/v1';
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const state = {
  token: store.get('fe.token'),
  refresh: store.get('fe.refresh'),
  me: null, masters: [], overview: null, stats: [], log: [], route: '',
};
const $app = document.getElementById('app');

/* ---------------- Utilities ---------------- */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? values[i] : ''), '');
/** Dates stored at midnight UTC are calendar dates (birthdays, expiries) and show without a time. */
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return esc(v);
  if (/T00:00:00(\.000)?Z$/.test(String(v))) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const short = (id) => (id ? `${String(id).slice(0, 6)}…${String(id).slice(-4)}` : '—');
const masterByKey = (k) => state.masters.find((m) => m.key === k);
const can = (resource, action) => (state.overview?.you?.permissions || []).some((p) => (p.resource === '*' || p.resource === resource) && (p.actions.includes('*') || p.actions.includes(action)));

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

/* ---------------- HTTP client with request log ---------------- */

async function call(method, path, { body, query, auth = true, quiet = false, retry = true } = {}) {
  const url = new URL(API + path, location.origin);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, v);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const started = performance.now();
  let res; let data = null; let text = '';
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    text = await res.text();
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
  window.addEventListener('hashchange', route);
  route();
}

async function loadMeta() {
  const [masters, overview, stats] = await Promise.all([call('GET', '/meta/masters'), call('GET', '/meta/overview'), call('GET', '/meta/stats')]);
  state.masters = masters.ok ? masters.data.data : [];
  state.overview = overview.ok ? overview.data.data : null;
  state.stats = stats.ok ? stats.data.data : [];
}

/* ---------------- Auth screen ---------------- */

function renderAuth(tab = 'login', token = '') {
  document.title = 'Sign in · Fleet ERP API Console';
  $app.className = '';
  $app.innerHTML = h`
  <div class="auth">
    <section class="auth-side">
      <div class="brand">${logo()}<span>Marichi Fleet<small>API console</small></span></div>
      <div>
        <h1>Test every master, rule and endpoint of the Fleet ERP backend.</h1>
        <p>Sign in, or create the first account to become the owner. Every request you make is listed with its status, timing and full response.</p>
      </div>
      <ul class="small"><li>First account on a fresh database gets the Owner role.</li><li>Later sign-ups get the read-only Viewer role.</li><li>Passwords: 8–128 characters, at least one letter and one digit.</li></ul>
    </section>
    <section class="auth-main">
      <div class="tabs" role="tablist">
        ${[['login', 'Sign in'], ['register', 'Create account'], ['forgot', 'Forgot password'], ['reset', 'Reset password']].map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
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
  const box = document.getElementById('authForm');
  box.innerHTML = h`<form class="form" id="af">${forms[tab].map(([n, l, t]) => `<label class="f">${l}<input class="in" name="${n}" type="${t}" required ${n === 'token' ? `value="${esc(token)}"` : ''} autocomplete="${t === 'password' ? (tab === 'login' ? 'current-password' : 'new-password') : n}"></label>`).join('')}
    <button class="btn primary" type="submit">${labels[tab]}</button><div id="authMsg" class="small"></div></form>`;
  document.getElementById('af').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const msg = document.getElementById('authMsg');
    const paths = { login: '/auth/login', register: '/auth/register', forgot: '/auth/forgot-password', reset: '/auth/reset-password' };
    const r = await call('POST', paths[tab], { body, auth: false, quiet: true });
    if (!r.ok) { msg.className = 'err small'; msg.textContent = errorText(r.data); return; }
    if (tab === 'login' || tab === 'register') {
      setTokens(r.data.data);
      if (tab === 'register' && r.data.data.firstOwner) toast('Account created. You are the owner of this workspace.');
      history.replaceState(null, '', '#overview');
      boot();
    } else if (tab === 'forgot') {
      msg.className = 'small';
      msg.textContent = r.data.message;
      if (r.data.data?.resetToken) { msg.textContent += ' (Development: the token was returned and filled in for you.)'; setTimeout(() => renderAuth('reset', r.data.data.resetToken), 900); }
    } else {
      history.replaceState(null, '', '#');
      msg.className = 'small'; msg.textContent = r.data.message;
      setTimeout(() => renderAuth('login'), 1200);
    }
  });
}

function logo() {
  return '<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="8" fill="#1f6b55"/><path d="M8 23c3-6 6-8 9-8s5-2 7-7" fill="none" stroke="#f3e1b8" stroke-width="2.4" stroke-linecap="round"/><circle cx="24" cy="8" r="2.3" fill="#fff"/></svg>';
}

/* ---------------- Shell ---------------- */

function renderShell() {
  $app.className = '';
  const groups = [...new Set(state.masters.map((m) => m.group))];
  const count = (k) => state.stats.find((s) => s.key === k);
  const user = state.me.user;
  $app.innerHTML = h`
  <div class="shell">
    <aside class="side">
      <div class="brand">${logo()}<span>Marichi Fleet<small>API console</small></span></div>
      <div class="side-search"><input id="navFilter" placeholder="Find a master" aria-label="Find a master"></div>
      <nav class="nav" id="nav">
        <h4>Workspace</h4>
        <a href="#overview">Overview</a>
        <a href="#account">Account and sign-in</a>
        <a href="#company">Company</a>
        <a href="#audit">Audit log</a>
        <a href="#api">API reference</a>
        <a href="#requests">Request log</a>
        ${groups.map((g) => `<h4>${esc(g)}</h4>${state.masters.filter((m) => m.group === g && m.key !== 'custom-records').map((m) => `<a href="#m/${m.key}" data-label="${esc(m.label.toLowerCase())}"><span>${esc(m.label)}</span><span class="n">${count(m.key)?.total ?? ''}</span></a>`).join('')}`).join('')}
      </nav>
      <div class="me"><span><b>${esc(user.name)}</b><br>${esc(user.email)}</span><span>${esc(state.me.roles.map((r) => r.name).join(', ') || 'No role')}</span><button type="button" id="signOut">Sign out</button></div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  document.getElementById('signOut').addEventListener('click', async () => { await call('POST', '/auth/logout', { quiet: true }); signOutLocal(); });
  document.getElementById('navFilter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#nav a[data-label]').forEach((a) => { a.hidden = q && !a.dataset.label.includes(q); });
  });
}

function setActiveNav() {
  const hash = location.hash || '#overview';
  document.querySelectorAll('#nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('on', hash === href || hash.startsWith(`${href}/`));
  });
}

function route() {
  closeOverlays();
  const hash = location.hash || '#overview';
  state.route = hash;
  setActiveNav();
  const main = document.getElementById('main');
  if (!main) return;
  main.scrollTop = 0;
  const [, page, a, b] = hash.match(/^#([a-z]+)\/?([^/]*)\/?(.*)$/) || [];
  if (page === 'm' && a) return renderMaster(a, b || 'records');
  if (page === 'custom' && a) return renderCustomRecords(a);
  if (page === 'account') return renderAccount();
  if (page === 'company') return renderCompany();
  if (page === 'audit') return renderAudit();
  if (page === 'api') return renderApi();
  if (page === 'requests') return renderRequests();
  return renderOverview();
}

/* ---------------- Overview ---------------- */

function renderOverview() {
  document.title = 'Overview · Fleet ERP API Console';
  const o = state.overview || {};
  const sys = o.system || {};
  const totals = state.stats.reduce((t, s) => ({ records: t.records + s.total, masters: t.masters + 1 }), { records: 0, masters: 0 });
  const groups = [...new Set(state.stats.map((s) => s.group))];
  main().innerHTML = h`
  <div class="page">
    <div class="page-head"><h1>Overview</h1><p>System status, your access, the API's limits, and how many records each master holds.</p></div>
    <div class="grid cols-3">
      <div class="panel"><div class="panel-head"><h3>System</h3></div><div class="panel-body"><dl class="kv">
        <dt>Environment</dt><dd>${esc(sys.environment)}</dd><dt>MongoDB</dt><dd><span class="st ${sys.mongo === 'connected' ? 'ok' : 'bad'}">${esc(sys.mongo)}</span></dd>
        <dt>Redis</dt><dd>${esc(sys.redis)}</dd><dt>SMTP</dt><dd>${esc(sys.smtp)}</dd><dt>Masters</dt><dd>${totals.masters}</dd><dt>Records</dt><dd>${totals.records}</dd></dl></div></div>
      <div class="panel"><div class="panel-head"><h3>You</h3></div><div class="panel-body"><dl class="kv">
        <dt>Name</dt><dd>${esc(o.you?.name)}</dd><dt>E-mail</dt><dd>${esc(o.you?.email)}</dd><dt>Roles</dt><dd>${esc((o.you?.roles || []).join(', ') || 'none')}</dd>
        <dt>Permissions</dt><dd class="small">${(o.you?.permissions || []).slice(0, 8).map((p) => `<span class="mono">${esc(p.resource)}:${esc(p.actions.join(','))}</span>`).join('<br>')}${(o.you?.permissions || []).length > 8 ? `<br><span class="muted">+${o.you.permissions.length - 8} more</span>` : ''}</dd></dl></div></div>
      <div class="panel"><div class="panel-head"><h3>Limits</h3></div><div class="panel-body"><dl class="kv small">${Object.entries(o.limits || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl></div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Records per master</h3><div class="toolbar">
        <button class="btn" type="button" id="reloadStats">Refresh counts</button>
        ${can('company', 'update') && sys.environment !== 'production' ? '<button class="btn primary" type="button" id="loadSample">Load sample data</button>' : ''}
      </div></div>
      <div class="tbl"><table class="t"><thead><tr><th>Area</th><th>Master</th><th>Collection</th><th class="num">Active</th><th class="num">Inactive</th><th class="num">Archived</th><th class="num">Total</th></tr></thead><tbody>
        ${groups.map((g) => state.stats.filter((s) => s.group === g).map((s, i) => `<tr class="click" data-go="#m/${s.key}"><td class="muted">${i ? '' : esc(g)}</td><td>${esc(s.label)}</td><td class="mono small">${esc(masterByKey(s.key)?.collection)}</td><td class="num">${s.active}</td><td class="num">${s.inactive}</td><td class="num">${s.archived}</td><td class="num">${s.total}</td></tr>`).join('')).join('')}
      </tbody></table></div>
    </div>
  </div>`;
  bindGo();
  document.getElementById('reloadStats').addEventListener('click', async () => { await loadMeta(); renderShell(); route(); });
  const sample = document.getElementById('loadSample');
  if (sample) sample.addEventListener('click', async () => {
    sample.disabled = true;
    const r = await call('POST', '/meta/sample-data');
    if (r.ok) { toast(`Sample data loaded: ${r.data.data.created} records`); await loadMeta(); renderShell(); route(); } else sample.disabled = false;
  });
}

const main = () => document.getElementById('main');
function bindGo(root = document) {
  root.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.go; }));
}

/* ---------------- Master page ---------------- */

const listState = {};

function renderMaster(key, tab) {
  const m = masterByKey(key);
  if (!m) { main().innerHTML = '<div class="page"><p class="empty">Unknown master.</p></div>'; return; }
  document.title = `${m.label} · Fleet ERP API Console`;
  const tabs = [['records', 'Records'], ['schema', 'Fields and rules'], ['endpoints', 'Endpoints'], ['contract', 'Request schemas']];
  main().innerHTML = h`
  <div class="page">
    <div class="page-head">
      <div class="crumbs"><span>${esc(m.group)}</span><span class="mono">${esc(m.basePath)}</span><span class="mono">collection: ${esc(m.collection)}</span></div>
      <h1>${esc(m.label)}</h1><p>${esc(m.description)}</p>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="tabBody"></div>
  </div>`;
  main().querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `#m/${key}/${b.dataset.tab}`; }));
  if (tab === 'schema') return renderSchemaTab(m);
  if (tab === 'endpoints') return renderEndpointsTab(m);
  if (tab === 'contract') return renderContractTab(m);
  return renderRecordsTab(m);
}

function columnsFor(m) {
  const title = m.titleField;
  const fields = m.fields.filter((f) => f.group === 'master' && !f.hidden && !f.path.includes('.') && !f.array && ['string', 'number', 'boolean', 'date'].includes(f.type) && f.path !== title);
  const cols = [title];
  if (m.fields.some((f) => f.path === 'code') && title !== 'code') cols.unshift('code');
  for (const f of fields) if (!cols.includes(f.path) && cols.length < 6) cols.push(f.path);
  return cols;
}

function cell(v, path, m) {
  if (v === undefined || v === null || v === '') return '<span class="muted">—</span>';
  const f = m?.fields.find((x) => x.path === path);
  if (f?.ref && typeof v === 'string') return `<span class="mono small" title="${esc(v)}">${short(v)}</span>`;
  if (f?.type === 'date') return fmtDate(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return `<span class="mono small">${esc(JSON.stringify(v).slice(0, 60))}</span>`;
  return esc(v);
}

async function renderRecordsTab(m) {
  const s = (listState[m.key] ||= { page: 1, limit: 20, search: '', status: '', sort: '', filters: {} });
  const body = document.getElementById('tabBody');
  const creatable = !m.managed.create || m.key === 'users' || m.key === 'pairings';
  body.innerHTML = h`
  <div class="panel">
    <div class="panel-head">
      <div class="toolbar">
        <input class="in grow" id="q" placeholder="Search ${esc(m.searchFields.join(', '))}" value="${esc(s.search)}" aria-label="Search">
        <select class="in" id="status" aria-label="Status"><option value="">Active and inactive</option>${['active', 'inactive', 'archived', 'all'].map((v) => `<option ${s.status === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select class="in" id="sort" aria-label="Sort"><option value="">Default sort${m.defaultSort ? ` (${esc(m.defaultSort)})` : ''}</option>${m.sortFields.flatMap((f) => [f, `-${f}`]).map((v) => `<option ${s.sort === v ? 'selected' : ''} value="${esc(v)}">${esc(v.startsWith('-') ? `${v.slice(1)} ↓` : `${v} ↑`)}</option>`).join('')}</select>
        <select class="in" id="limit" aria-label="Page size">${[10, 20, 50, 100].map((n) => `<option ${s.limit === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <div class="toolbar">${creatable ? `<button class="btn primary" type="button" id="newRec" ${can(m.key, 'create') ? '' : 'disabled title="Your role cannot create these"'}>${m.key === 'pairings' ? 'Pair a truck and trailer' : `New ${esc(m.singular.toLowerCase())}`}</button>` : ''}</div>
    </div>
    ${m.filters.length ? `<div class="panel-body toolbar small" id="filters">${m.filters.map((f) => filterControl(f, s.filters[f.key])).join('')}<button class="btn sm" type="button" id="clearFilters">Clear filters</button></div>` : ''}
    <div id="listBody"><div class="empty">Loading…</div></div>
  </div>`;
  const reload = () => loadRecords(m);
  let timer;
  document.getElementById('q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { s.search = e.target.value.trim(); s.page = 1; reload(); }, 250); });
  for (const id of ['status', 'sort', 'limit']) document.getElementById(id).addEventListener('change', (e) => { s[id] = id === 'limit' ? Number(e.target.value) : e.target.value; s.page = 1; reload(); });
  body.querySelectorAll('[data-filter]').forEach((el) => el.addEventListener('change', () => { s.filters[el.dataset.filter] = el.value; s.page = 1; reload(); }));
  const clear = document.getElementById('clearFilters');
  if (clear) clear.addEventListener('click', () => { s.filters = {}; renderRecordsTab(m); });
  const nb = document.getElementById('newRec');
  if (nb) nb.addEventListener('click', () => openEditor(m, null));
  reload();
}

function filterControl(f, value = '') {
  const sch = f.schema || {};
  const options = sch.enum || (sch.anyOf || []).flatMap((x) => x.enum || []);
  const label = `<span class="muted">${esc(f.key)}</span>`;
  if (options.length) return `<label class="toolbar">${label}<select class="in" data-filter="${esc(f.key)}" title="${esc(f.description)}"><option value="">any</option>${options.map((o) => `<option ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  return `<label class="toolbar">${label}<input class="in" data-filter="${esc(f.key)}" value="${esc(value)}" placeholder="${esc(f.description)}" size="22"></label>`;
}

async function loadRecords(m) {
  const s = listState[m.key];
  const query = { page: s.page, limit: s.limit, search: s.search, status: s.status, sort: s.sort, ...s.filters };
  const r = await call('GET', `/${m.key}`, { query, quiet: true });
  const box = document.getElementById('listBody');
  if (!box) return;
  if (!r.ok) { box.innerHTML = `<div class="panel-body"><pre class="json">${jsonHtml(r.data)}</pre></div>`; return; }
  const rows = r.data.data;
  const meta = r.data.meta;
  const cols = columnsFor(m);
  box.innerHTML = rows.length ? h`
    <div class="tbl"><table class="t"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th>Status</th><th class="num">Version</th><th>Updated</th></tr></thead>
    <tbody>${rows.map((row) => `<tr class="click" data-id="${esc(row.id)}">${cols.map((c) => `<td>${cell(row[c], c, m)}</td>`).join('')}<td><span class="st ${esc(row.status)}">${esc(row.status)}</span></td><td class="num">${esc(row.version)}</td><td class="small muted">${fmtDate(row.updatedAt)}</td></tr>`).join('')}</tbody></table></div>
    <div class="pager"><span>${meta.total} record${meta.total === 1 ? '' : 's'} · page ${meta.page} of ${Math.max(1, meta.totalPages)} · ${r.ms} ms</span>
      <span class="toolbar"><button class="btn sm" type="button" id="prev" ${meta.hasPrevPage ? '' : 'disabled'}>Previous</button><button class="btn sm" type="button" id="next" ${meta.hasNextPage ? '' : 'disabled'}>Next</button></span></div>`
    : `<div class="empty">No records match. ${can(m.key, 'create') ? 'Create one, or load the sample data from Overview.' : ''}</div>`;
  box.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openRecord(m, tr.dataset.id)));
  const prev = document.getElementById('prev'); const next = document.getElementById('next');
  if (prev) prev.addEventListener('click', () => { s.page -= 1; loadRecords(m); });
  if (next) next.addEventListener('click', () => { s.page += 1; loadRecords(m); });
}

/* ---------------- Record drawer ---------------- */

function closeOverlays() { document.querySelectorAll('.drawer, .modal, .scrim').forEach((el) => el.remove()); }

function overlay(cls, html) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.addEventListener('click', () => { el.remove(); scrim.remove(); });
  const el = document.createElement('div');
  el.className = cls;
  el.setAttribute('role', 'dialog');
  el.innerHTML = html;
  document.body.append(scrim, el);
  el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { el.remove(); scrim.remove(); }));
  const onKey = (e) => { if (e.key === 'Escape') { el.remove(); scrim.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return el;
}

async function openRecord(m, id, base = `/${m.key}`, refresh) {
  const r = await call('GET', `${base}/${id}`);
  if (!r.ok) return;
  const rec = r.data.data;
  closeOverlays();
  const title = rec[m.titleField] ?? rec.name ?? rec.code ?? rec.id;
  const archived = rec.status === 'archived';
  const custom = base !== `/${m.key}`;
  const actions = [];
  if (!m.managed.update && !archived) actions.push(`<button class="btn" type="button" data-act="edit" ${can(m.key, 'update') ? '' : 'disabled'}>Edit</button>`);
  if (!m.managed.archive) actions.push(archived ? `<button class="btn" type="button" data-act="restore" ${can(m.key, 'archive') ? '' : 'disabled'}>Restore</button>` : `<button class="btn" type="button" data-act="archive" ${can(m.key, 'archive') ? '' : 'disabled'}>Archive</button>`);
  if (!m.managed.delete) actions.push(`<button class="btn danger" type="button" data-act="delete" ${can(m.key, 'delete') ? '' : 'disabled'}>Delete</button>`);
  if (m.key === 'pairings' && rec.open) actions.push(`<button class="btn" type="button" data-act="end">End pairing</button>`);
  if (m.key === 'users') actions.push('<button class="btn" type="button" data-act="revoke">Sign out everywhere</button><button class="btn" type="button" data-act="unlock">Unlock</button>');
  if (m.key === 'custom-masters') actions.push(`<button class="btn primary" type="button" data-act="records">Open records</button>`);
  if (m.key === 'numbering-series') actions.push('<button class="btn" type="button" data-act="preview">Preview next</button><button class="btn" type="button" data-act="issue">Issue a number</button>');
  if (m.key === 'message-templates') actions.push('<button class="btn" type="button" data-act="render">Preview message</button>');
  const el = overlay('drawer', h`
    <div class="drawer-head">
      <div class="crumbs"><span>${esc(m.singular)}</span><span class="mono">${esc(rec.id)}</span><span>version ${esc(rec.version)}</span><span class="st ${esc(rec.status)}">${esc(rec.status)}</span></div>
      <h2>${esc(title)}</h2>
      <div class="row-actions">${actions.join('')}<button class="btn" type="button" data-close>Close</button></div>
    </div>
    <div class="tabs">${[['json', 'Record'], ['usage', 'Where used'], ['history', 'History']].filter(([k]) => !custom || k === 'json').map(([k, l], i) => `<button type="button" data-dt="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div>
    <div class="drawer-body" id="drawerBody"><pre class="json">${jsonHtml(rec)}</pre></div>`);
  const db = el.querySelector('#drawerBody');
  el.querySelectorAll('[data-dt]').forEach((b) => b.addEventListener('click', async () => {
    el.querySelectorAll('[data-dt]').forEach((x) => x.classList.toggle('on', x === b));
    if (b.dataset.dt === 'json') db.innerHTML = `<pre class="json">${jsonHtml(rec)}</pre>`;
    if (b.dataset.dt === 'usage') {
      const u = await call('GET', `/${m.key}/${id}/usage`);
      db.innerHTML = u.ok ? (u.data.data.usage.length ? `<table class="t"><thead><tr><th>Used by</th><th>Field</th><th class="num">Records</th></tr></thead><tbody>${u.data.data.usage.map((x) => `<tr><td>${esc(x.label)}</td><td class="mono small">${esc(x.path)}</td><td class="num">${x.count}</td></tr>`).join('')}</tbody></table><p class="hint">Records in use can be archived only when no active record points at them, and deleted only when nothing does.</p>` : '<p class="empty">Nothing references this record. It can be deleted.</p>') : '';
    }
    if (b.dataset.dt === 'history') {
      const hi = await call('GET', `/${m.key}/${id}/history`, { query: { limit: 50 } });
      db.innerHTML = hi.ok ? hi.data.data.map((a) => `<div class="panel"><div class="panel-head"><span><b>${esc(a.action)}</b> <span class="muted small">${fmtDate(a.at)}</span></span><span class="small muted">${esc(a.summary || '')}</span></div>${a.changes?.length ? `<div class="tbl"><table class="t"><thead><tr><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>${a.changes.map((c) => `<tr><td class="mono small">${esc(c.path)}</td><td class="small">${esc(JSON.stringify(c.from) ?? '')}</td><td class="small">${esc(JSON.stringify(c.to) ?? '')}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`).join('') || '<p class="empty">No history.</p>' : '';
    }
  }));
  const done = (msg) => { toast(msg); closeOverlays(); (refresh || (() => loadRecords(m)))(); };
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (act === 'edit') return openEditor(m, rec, base, refresh);
    if (act === 'records') { closeOverlays(); location.hash = `#custom/${rec.id}`; return; }
    if (act === 'archive') {
      const reason = await ask('Archive this record', 'Reason (optional, kept in the audit log)');
      if (reason === null) return;
      const r2 = await call('POST', `${base}/${id}/archive`, { body: reason ? { reason } : {} });
      if (r2.ok) done('Archived'); else showResult(db, r2);
    }
    if (act === 'restore') { const r2 = await call('POST', `${base}/${id}/restore`); if (r2.ok) done('Restored'); else showResult(db, r2); }
    if (act === 'delete') {
      if (!(await confirmBox('Delete permanently?', 'This only works if no record refers to it. Archiving is usually the right choice.'))) return;
      const r2 = await call('DELETE', `${base}/${id}`);
      if (r2.ok) done('Deleted'); else showResult(db, r2);
    }
    if (act === 'end') { const r2 = await call('POST', `/pairings/${id}/end`, { body: {} }); if (r2.ok) done('Pairing ended'); else showResult(db, r2); }
    if (act === 'revoke') { const r2 = await call('POST', `/users/${id}/revoke-sessions`); if (r2.ok) toast('All sessions signed out'); }
    if (act === 'unlock') { const r2 = await call('POST', `/users/${id}/unlock`); if (r2.ok) toast('User unlocked'); }
    if (act === 'preview') { const r2 = await call('GET', `/numbering-series/${id}/preview`); showResult(db, r2); }
    if (act === 'issue') { const r2 = await call('POST', `/numbering-series/${id}/next`); showResult(db, r2); }
    if (act === 'render') { const r2 = await call('POST', `/message-templates/${id}/preview`, { body: {} }); showResult(db, r2); }
  }));
}

function showResult(box, r) {
  const div = document.createElement('div');
  div.className = `result ${r.ok ? 'ok' : 'bad'}`;
  div.innerHTML = `<div class="small muted">HTTP ${r.status} · ${r.ms} ms</div><pre class="json">${jsonHtml(r.data)}</pre>`;
  box.prepend(div);
}

function confirmBox(title, text) {
  return new Promise((resolve) => {
    const el = overlay('modal', `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="panel-body">${esc(text)}</div><div class="modal-foot"><span></span><span class="toolbar"><button class="btn" type="button" data-no>Cancel</button><button class="btn danger" type="button" data-yes>Confirm</button></span></div>`);
    el.classList.add('small-modal');
    el.querySelector('[data-no]').addEventListener('click', () => { closeTop(el); resolve(false); });
    el.querySelector('[data-yes]').addEventListener('click', () => { closeTop(el); resolve(true); });
  });
}
function ask(title, label) {
  return new Promise((resolve) => {
    const el = overlay('modal', `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="panel-body"><label class="f">${esc(label)}<input class="in" id="askIn" maxlength="500"></label></div><div class="modal-foot"><span></span><span class="toolbar"><button class="btn" type="button" data-no>Cancel</button><button class="btn primary" type="button" data-yes>Continue</button></span></div>`);
    el.classList.add('small-modal');
    el.querySelector('#askIn').focus();
    el.querySelector('[data-no]').addEventListener('click', () => { closeTop(el); resolve(null); });
    el.querySelector('[data-yes]').addEventListener('click', () => { const v = el.querySelector('#askIn').value.trim(); closeTop(el); resolve(v); });
  });
}
function closeTop(el) { el.previousElementSibling?.classList.contains('scrim') && el.previousElementSibling.remove(); el.remove(); }

/* ---------------- Editor ---------------- */

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

function typeLabel(s) {
  if (!s) return 'any';
  const formats = (s.anyOf || []).map((x) => x.format).filter(Boolean);
  if (formats.length && formats.every((f) => f === 'date' || f === 'date-time')) return `date (YYYY-MM-DD or ISO date-time)${(s.anyOf || []).some((x) => x.type === 'null') ? ' (null clears)' : ''}`;
  if (s.format === 'date' || s.format === 'date-time') return 'date (YYYY-MM-DD or ISO date-time)';
  if (s.anyOf) return s.anyOf.filter((x) => x.type !== 'null').map(typeLabel).join(' or ') + (s.anyOf.some((x) => x.type === 'null') ? ' (null clears)' : '');
  if (s.enum) return `one of ${s.enum.join(', ')}`;
  if (s.type === 'array') return `list of ${typeLabel(s.items)}${s.maxItems ? ` (max ${s.maxItems})` : ''}`;
  if (s.type === 'object') return `object { ${Object.keys(s.properties || {}).join(', ')} }`;
  const bits = [s.type];
  if (s.format) bits.push(s.format);
  if (s.pattern && !s.format) bits.push(`pattern ${s.pattern}`);
  if (s.minLength !== undefined || s.maxLength !== undefined) bits.push(`${s.minLength ?? 0}–${s.maxLength ?? '∞'} chars`);
  if (s.minimum !== undefined || s.maximum !== undefined) bits.push(`${s.minimum ?? '−∞'}…${s.maximum ?? '∞'}`);
  return bits.join(', ');
}

function guideHtml(m, schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const refs = new Map((m?.references || []).map((r) => [r.path.split('.')[0], r]));
  return Object.entries(props).map(([k, s]) => {
    const ref = refs.get(k);
    const field = m?.fields.find((f) => f.path === k);
    return `<div class="row"><span><b>${esc(k)}</b> ${required.has(k) ? '<span class="flag req">required</span>' : ''}${field?.sensitive ? '<span class="flag sens">sensitive</span>' : ''}${m?.immutable?.includes(k) ? '<span class="flag">fixed after create</span>' : ''}</span>
      <span class="muted">${esc(typeLabel(s))}</span>${ref ? `<span>→ ${esc(ref.target)}${ref.partyRoles ? ` (role ${esc(ref.partyRoles.join(' or '))})` : ''} <button class="btn sm" type="button" data-pick="${esc(ref.target)}">Find id</button></span>` : ''}</div>`;
  }).join('');
}

/** JSON editor beside a field guide and a reference finder. Used for create, update and custom requests. */
function openEditor(m, rec, base = `/${m.key}`, refresh, opts = {}) {
  const isEdit = Boolean(rec);
  const special = m.key === 'pairings' ? m.endpoints.find((e) => e.method === 'POST' && e.path.endsWith('/pairings')) : null;
  const schema = opts.schema || (special ? special.schemas.body : isEdit ? m.updateSchema : m.createSchema);
  let initial;
  if (isEdit) {
    const keys = Object.keys(schema?.properties || {}).filter((k) => k !== 'version');
    initial = { version: rec.version };
    for (const k of keys) if (rec[k] !== undefined) initial[k] = rec[k];
  } else initial = opts.initial || exampleFor(schema) || {};
  const el = overlay('modal', h`
    <div class="modal-head"><h2>${isEdit ? `Edit ${esc(m.singular.toLowerCase())}` : esc(opts.title || `New ${m.singular.toLowerCase()}`)}</h2><span class="mono small muted">${isEdit ? 'PATCH' : 'POST'} ${esc(API + base)}${isEdit ? `/${esc(rec.id)}` : ''}</span></div>
    <div class="modal-body">
      <div><textarea class="in" id="edJson" spellcheck="false" aria-label="Request body (JSON)">${esc(JSON.stringify(initial, null, 2))}</textarea><div id="edResult"></div></div>
      <div>
        <h3 class="small">Fields</h3><div class="guide">${guideHtml(m, schema)}</div>
        ${isEdit ? '<p class="hint">Send only what changes plus the version. Optional fields can be cleared with null. A stale version is rejected with 409.</p>' : '<p class="hint">Required fields are pre-filled with empty values. Ids come from the referenced master; use Find id.</p>'}
        <div id="picker"></div>
      </div>
    </div>
    <div class="modal-foot"><span class="hint">Ctrl/⌘ + Enter sends.</span><span class="toolbar"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="edSend">${isEdit ? 'Save changes' : 'Create'}</button></span></div>`);
  const send = async () => {
    const box = el.querySelector('#edResult');
    let body;
    try { body = JSON.parse(el.querySelector('#edJson').value); } catch (err) { box.innerHTML = `<p class="err">Not valid JSON: ${esc(err.message)}</p>`; return; }
    const r = isEdit ? await call('PATCH', `${base}/${rec.id}`, { body, quiet: true }) : await call('POST', base, { body, quiet: true });
    if (r.ok) { toast(r.data.message || 'Saved'); closeOverlays(); (refresh || (() => loadRecords(m)))(); await refreshCounts(); return; }
    box.innerHTML = `<div class="result bad"><div class="small">HTTP ${r.status} · ${r.ms} ms</div><pre class="json">${jsonHtml(r.data)}</pre></div>`;
  };
  el.querySelector('#edSend').addEventListener('click', send);
  el.querySelector('#edJson').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => picker(el.querySelector('#picker'), b.dataset.pick)));
}

async function picker(box, target) {
  const tm = masterByKey(target);
  box.innerHTML = `<div class="panel"><div class="panel-head"><h3>${esc(tm?.label || target)}</h3><input class="in" id="pk" placeholder="Search"></div><div id="pkList" class="small"></div></div>`;
  const load = async (q) => {
    const r = await call('GET', `/${target}`, { query: { search: q, limit: 15, status: 'active' }, quiet: true });
    const list = box.querySelector('#pkList');
    if (!r.ok) { list.innerHTML = `<p class="err">${esc(errorText(r.data))}</p>`; return; }
    list.innerHTML = r.data.data.map((x) => `<div class="guide"><div class="row"><span>${esc(x[tm?.titleField] ?? x.name ?? x.code ?? x.id)} <span class="muted">${esc(x.code || '')}</span></span><span class="toolbar"><code>${esc(x.id)}</code><button class="btn sm" type="button" data-copy="${esc(x.id)}">Copy</button></span></div></div>`).join('') || '<p class="muted">No active records.</p>';
    list.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Id copied'); } catch { toast('Copy failed; select the id instead', true); }
    }));
  };
  let t;
  box.querySelector('#pk').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value.trim()), 250); });
  load('');
}

async function refreshCounts() {
  const s = await call('GET', '/meta/stats', { quiet: true });
  if (s.ok) state.stats = s.data.data;
  document.querySelectorAll('#nav a[href^="#m/"]').forEach((a) => {
    const k = a.getAttribute('href').slice(3);
    const n = a.querySelector('.n');
    if (n) n.textContent = state.stats.find((x) => x.key === k)?.total ?? '';
  });
}

/* ---------------- Schema, endpoints and contract tabs ---------------- */

function renderSchemaTab(m) {
  const body = document.getElementById('tabBody');
  const groups = [['master', 'Fields of this master'], ['standard', 'Standard fields (every master)'], ['system', 'System fields (set by the API)']];
  body.innerHTML = h`
  <div class="grid">
    <div class="panel"><div class="panel-head"><h3>Behaviour</h3></div><div class="panel-body"><dl class="kv small">
      <dt>Title field</dt><dd class="mono">${esc(m.titleField)}</dd>
      <dt>Search covers</dt><dd class="mono">${esc(m.searchFields.join(', '))}</dd>
      <dt>Sortable by</dt><dd class="mono">${esc(m.sortFields.join(', '))}</dd>
      <dt>Code generation</dt><dd>${m.autoCode ? 'Automatic from the numbering series when code is omitted' : 'Typed by the user'}</dd>
      <dt>Custom fields</dt><dd>${m.customFieldsAllowed ? `Allowed${m.customFields.length ? `: ${m.customFields.map((f) => `<span class="mono">${esc(f.key)}</span> (${esc(f.type)}${f.required ? ', required' : ''})`).join(', ')}` : ' (none defined yet)'}` : 'Not allowed'}</dd>
      <dt>Sensitive (masked)</dt><dd class="mono">${esc(m.sensitive.join(', ') || '—')}</dd>
      <dt>Fixed after create</dt><dd class="mono">${esc(m.immutable.join(', ') || '—')}</dd>
      <dt>Managed actions</dt><dd>${Object.keys(m.managed).length ? esc(Object.keys(m.managed).join(', ')) + ' use dedicated endpoints' : 'Standard create, update, archive and delete'}</dd>
    </dl></div></div>
    ${groups.map(([g, label]) => `<div class="panel"><div class="panel-head"><h3>${label}</h3></div><div class="tbl"><table class="t"><thead><tr><th>Path</th><th>Type</th><th>Rules</th><th>References</th></tr></thead><tbody>${m.fields.filter((f) => f.group === g).map((f) => `<tr><td class="mono">${esc(f.path)}</td><td>${esc(f.type)}${f.array ? '[]' : ''}</td><td>${f.required ? '<span class="flag req">required</span>' : ''}${f.sensitive ? '<span class="flag sens">sensitive</span>' : ''}${f.immutable ? '<span class="flag">fixed</span>' : ''}${f.hidden ? '<span class="flag">hidden</span>' : ''}${f.enum ? `<span class="small muted">${esc(f.enum.join(', '))}</span>` : ''}${f.default !== undefined ? ` <span class="small muted">default ${esc(JSON.stringify(f.default))}</span>` : ''}${f.min !== undefined ? ` <span class="small muted">min ${f.min}</span>` : ''}${f.max !== undefined ? ` <span class="small muted">max ${f.max}</span>` : ''}</td><td>${f.ref ? (masterByKey(f.ref) ? `<a href="#m/${esc(f.ref)}">${esc(f.ref)}</a>` : esc(f.ref)) : ''}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}
    <div class="split">
      <div class="panel"><div class="panel-head"><h3>Indexes</h3></div><div class="tbl"><table class="t"><thead><tr><th>Fields</th><th>Unique</th><th>Only when</th></tr></thead><tbody>${m.indexes.map((i) => `<tr><td class="mono small">${esc(JSON.stringify(i.fields))}</td><td>${i.unique ? 'Yes' : ''}</td><td class="mono small">${i.partial ? esc(JSON.stringify(i.partial)) : ''}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="panel"><div class="panel-head"><h3>References checked on save</h3></div><div class="tbl"><table class="t"><thead><tr><th>Field</th><th>Must point at an active</th></tr></thead><tbody>${m.references.map((r) => `<tr><td class="mono small">${esc(r.path)}</td><td><a href="#m/${esc(r.target)}">${esc(r.target)}</a>${r.partyRoles ? ` <span class="small muted">with role ${esc(r.partyRoles.join(' or '))}</span>` : ''}${r.usageOnly ? ' <span class="small muted">(checked by the master itself)</span>' : ''}</td></tr>`).join('')}</tbody></table></div></div>
    </div>
    ${m.filters.length ? `<div class="panel"><div class="panel-head"><h3>List filters</h3></div><div class="tbl"><table class="t"><thead><tr><th>Query parameter</th><th>Meaning</th><th>Accepts</th></tr></thead><tbody>${m.filters.map((f) => `<tr><td class="mono">${esc(f.key)}</td><td>${esc(f.description)}</td><td class="small muted">${esc(typeLabel(f.schema))}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
  </div>`;
}

function endpointRows(list) {
  return list.map((e, i) => `<tr><td><span class="m ${e.method}">${e.method}</span></td><td class="mono small">${esc(e.path)}</td><td class="mono small">${esc(e.permission || (e.authenticated ? 'signed in' : 'public'))}</td><td class="small">${(e.rateLimits || []).map((r) => `${r.limit} per ${r.windowSeconds >= 3600 ? `${r.windowSeconds / 3600} h` : `${r.windowSeconds / 60} min`}`).join('; ') || '<span class="muted">—</span>'}</td><td class="small">${Object.keys(e.schemas || {}).join(', ') || '<span class="muted">—</span>'}</td><td><button class="btn sm" type="button" data-try="${i}">Try</button></td></tr>`).join('');
}

function bindTry(root, list) {
  root.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => openTry(list[Number(b.dataset.try)])));
}

function renderEndpointsTab(m) {
  const body = document.getElementById('tabBody');
  body.innerHTML = h`<div class="panel"><div class="tbl"><table class="t"><thead><tr><th>Method</th><th>Path</th><th>Permission</th><th>Rate limit</th><th>Validates</th><th></th></tr></thead><tbody>${endpointRows(m.endpoints)}</tbody></table></div>
    <div class="panel-body small muted">Every master endpoint needs a signed-in user. Page size is 1–100; search is up to 100 characters; unknown query parameters and body fields are rejected with 422.</div></div>`;
  bindTry(body, m.endpoints);
}

function renderContractTab(m) {
  const body = document.getElementById('tabBody');
  body.innerHTML = h`<div class="split">
    <div class="panel"><div class="panel-head"><h3>Create body (POST)</h3></div><div class="panel-body"><pre class="json">${jsonHtml(m.createSchema)}</pre></div></div>
    <div class="panel"><div class="panel-head"><h3>Update body (PATCH)</h3></div><div class="panel-body"><pre class="json">${jsonHtml(m.updateSchema)}</pre></div></div></div>`;
}

/* ---------------- Request builder ---------------- */

function openTry(e) {
  const path = e.path.replace(/^\/api\/v1/, '');
  const bodySchema = e.schemas?.body;
  const example = bodySchema ? exampleFor(bodySchema) : undefined;
  const el = overlay('modal', h`
    <div class="modal-head"><h2><span class="m ${e.method}">${e.method}</span> <span class="mono">${esc(e.path)}</span></h2><span class="small muted">${esc(e.permission || (e.authenticated ? 'signed in' : 'public'))}</span></div>
    <div class="modal-body">
      <div class="grid">
        <label class="f">Path (replace :id and :masterId)<input class="in mono" id="tPath" value="${esc(path)}"></label>
        <label class="f">Query string<input class="in mono" id="tQuery" placeholder="page=1&limit=20"></label>
        ${['POST', 'PATCH', 'PUT'].includes(e.method) ? `<label class="f">Body (JSON)<textarea class="in" id="tBody" rows="12" spellcheck="false">${esc(JSON.stringify(example ?? {}, null, 2))}</textarea></label>` : ''}
        <div id="tOut"></div>
      </div>
      <div><h3 class="small">Request schema</h3>${Object.entries(e.schemas || {}).map(([k, s]) => `<p class="small muted">${esc(k)}</p><pre class="json">${jsonHtml(s)}</pre>`).join('') || '<p class="muted small">No body or parameters are validated.</p>'}</div>
    </div>
    <div class="modal-foot"><span class="hint">Responses also appear in the request log.</span><span class="toolbar"><button class="btn" type="button" data-close>Close</button><button class="btn primary" type="button" id="tSend">Send request</button></span></div>`);
  el.querySelector('#tSend').addEventListener('click', async () => {
    const p = el.querySelector('#tPath').value.trim();
    const q = Object.fromEntries(new URLSearchParams(el.querySelector('#tQuery').value.trim()));
    const raw = el.querySelector('#tBody')?.value;
    const r = await call(e.method, p, { query: q, body: raw === undefined ? undefined : raw, auth: true, quiet: true });
    el.querySelector('#tOut').innerHTML = `<div class="result ${r.ok ? 'ok' : 'bad'}"><div class="small">HTTP ${r.status} · ${r.ms} ms${r.entry.requestId ? ` · request ${esc(r.entry.requestId)}` : ''}${r.entry.rateLimit ? ` · ${esc(r.entry.rateLimit)}` : ''}</div><pre class="json">${jsonHtml(r.data)}</pre></div>`;
  });
}

/* ---------------- Custom master records ---------------- */

async function renderCustomRecords(masterId) {
  const def = await call('GET', `/custom-masters/${masterId}`);
  if (!def.ok) { main().innerHTML = '<div class="page"><p class="empty">Custom master not found.</p></div>'; return; }
  const cm = def.data.data;
  const base = `/custom-masters/${masterId}/records`;
  const rm = masterByKey('custom-records');
  const fieldsSchema = { type: 'object', required: ['data'], properties: { data: { type: 'object', required: cm.fields.filter((f) => f.required).map((f) => f.key), properties: Object.fromEntries(cm.fields.map((f) => [f.key, { type: f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : f.type === 'multi_select' ? 'array' : 'string', ...(f.options ? { enum: f.options } : {}) }])) } } };
  document.title = `${cm.name} · Fleet ERP API Console`;
  main().innerHTML = h`
  <div class="page">
    <div class="page-head"><div class="crumbs"><a href="#m/custom-masters">Custom masters</a><span class="mono">${esc(API + base)}</span></div><h1>${esc(cm.name)}</h1><p>${esc(cm.description || '')}</p></div>
    <div class="panel"><div class="panel-head"><h3>Fields</h3></div><div class="tbl"><table class="t"><thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Rules</th></tr></thead><tbody>${cm.fields.map((f) => `<tr><td class="mono">${esc(f.key)}</td><td>${esc(f.label)}</td><td>${esc(f.type)}${f.referenceMaster ? ` → <a href="#m/${esc(f.referenceMaster)}">${esc(f.referenceMaster)}</a>` : ''}</td><td>${f.required ? '<span class="flag req">required</span>' : ''}${f.key === cm.titleField ? '<span class="flag">title</span>' : ''}<span class="small muted">${esc((f.options || []).join(', '))}${f.pattern ? ` pattern ${esc(f.pattern)}` : ''}</span></td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel"><div class="panel-head"><input class="in" id="cq" placeholder="Search by title"><button class="btn primary" type="button" id="cNew" ${can('custom-records', 'create') ? '' : 'disabled'}>New record</button></div><div id="cList"></div></div>
  </div>`;
  const load = async (q = '') => {
    const r = await call('GET', base, { query: { search: q, limit: 100, status: 'all' }, quiet: true });
    const box = document.getElementById('cList');
    if (!r.ok) { box.innerHTML = `<pre class="json">${jsonHtml(r.data)}</pre>`; return; }
    box.innerHTML = r.data.data.length ? `<div class="tbl"><table class="t"><thead><tr><th>Title</th>${cm.fields.filter((f) => f.key !== cm.titleField).slice(0, 4).map((f) => `<th>${esc(f.label)}</th>`).join('')}<th>Status</th><th class="num">Version</th></tr></thead><tbody>${r.data.data.map((x) => `<tr class="click" data-id="${esc(x.id)}"><td>${esc(x.title)}</td>${cm.fields.filter((f) => f.key !== cm.titleField).slice(0, 4).map((f) => `<td>${esc(Array.isArray(x.data[f.key]) ? x.data[f.key].join(', ') : x.data[f.key] ?? '—')}</td>`).join('')}<td><span class="st ${esc(x.status)}">${esc(x.status)}</span></td><td class="num">${x.version}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No records yet.</p>';
    box.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openRecord(rm, tr.dataset.id, base, () => load(document.getElementById('cq').value))));
  };
  let t;
  document.getElementById('cq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value.trim()), 250); });
  document.getElementById('cNew').addEventListener('click', () => openEditor({ ...rm, references: [] }, null, base, () => load(), { schema: fieldsSchema, title: `New ${cm.name} record`, initial: { data: Object.fromEntries(cm.fields.filter((f) => f.required).map((f) => [f.key, ''])) } }));
  load();
}

/* ---------------- Account ---------------- */

async function renderAccount() {
  document.title = 'Account · Fleet ERP API Console';
  const sessions = await call('GET', '/auth/sessions', { quiet: true });
  const u = state.me.user;
  main().innerHTML = h`
  <div class="page">
    <div class="page-head"><h1>Account and sign-in</h1><p>Your profile, password and devices, plus the reset flow for testing.</p></div>
    <div class="grid cols-2">
      <div class="panel"><div class="panel-head"><h3>Profile</h3></div><form class="panel-body form" id="pf"><label class="f">Name<input class="in" name="name" value="${esc(u.name)}"></label><label class="f">Phone (+260…)<input class="in" name="phone" value="${esc(u.phone || '')}"></label><button class="btn" type="submit">Save profile</button></form></div>
      <div class="panel"><div class="panel-head"><h3>Change password</h3></div><form class="panel-body form" id="cp"><label class="f">Current password<input class="in" type="password" name="currentPassword" required autocomplete="current-password"></label><label class="f">New password<input class="in" type="password" name="newPassword" required autocomplete="new-password"></label><button class="btn" type="submit">Change password</button><p class="hint">Changing the password signs out every other device.</p></form></div>
    </div>
    <div class="panel"><div class="panel-head"><h3>Signed-in devices</h3><button class="btn danger" type="button" id="la">Sign out everywhere</button></div>
      <div class="tbl"><table class="t"><thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Expires</th><th></th></tr></thead><tbody>${(sessions.ok ? sessions.data.data : []).map((s) => `<tr><td class="small">${esc((s.userAgent || 'Unknown').slice(0, 80))}</td><td class="mono small">${esc(s.ip || '')}</td><td class="small">${fmtDate(s.createdAt)}</td><td class="small">${fmtDate(s.expiresAt)}</td><td>${s.current ? '<span class="st ok">this session</span>' : ''}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="grid cols-2">
      <div class="panel"><div class="panel-head"><h3>Test the reset flow</h3></div><div class="panel-body grid"><p class="small">Sends a reset link to an e-mail. With EXPOSE_RESET_TOKEN=true (development only) the token is returned so you can finish the flow here.</p>
        <form class="form" id="fp"><label class="f">E-mail<input class="in" name="email" type="email" value="${esc(u.email)}"></label><button class="btn" type="submit">Request reset</button></form><div id="fpOut"></div></div></div>
      <div class="panel"><div class="panel-head"><h3>Your access token</h3></div><div class="panel-body grid small"><p>Sent as <span class="mono">Authorization: Bearer …</span>. It renews automatically with the refresh token when it expires.</p><textarea class="in" rows="5" readonly aria-label="Access token">${esc(state.token)}</textarea></div></div>
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
    document.getElementById('fpOut').innerHTML = `<div class="result ${r.ok ? 'ok' : 'bad'}"><pre class="json">${jsonHtml(r.data)}</pre></div>`;
  });
}

/* ---------------- Company ---------------- */

async function renderCompany() {
  document.title = 'Company · Fleet ERP API Console';
  const r = await call('GET', '/company', { quiet: true });
  const current = r.ok ? r.data.data : null;
  const editable = current ? Object.fromEntries(Object.entries(current).filter(([k]) => !['id', 'createdAt', 'updatedAt', 'updatedBy'].includes(k))) : { legalName: '' };
  main().innerHTML = h`
  <div class="page">
    <div class="page-head"><h1>Company</h1><p>The transporter using this deployment: legal details, base currency, time zone, fiscal year, modules and whether people may sign up on their own.</p></div>
    <div class="split">
      <div class="panel"><div class="panel-head"><h3>${current ? 'Saved details' : 'Not saved yet'}</h3></div><div class="panel-body">${current ? `<pre class="json">${jsonHtml(current)}</pre>` : '<p class="muted">Save the legal name to create the company record.</p>'}</div></div>
      <div class="panel"><div class="panel-head"><h3>Edit (PUT /company)</h3><button class="btn primary" type="button" id="cs" ${can('company', 'update') ? '' : 'disabled'}>Save</button></div><div class="panel-body grid"><textarea class="in" id="cj" rows="22" spellcheck="false">${esc(JSON.stringify(editable, null, 2))}</textarea><div id="co"></div></div></div>
    </div>
  </div>`;
  document.getElementById('cs').addEventListener('click', async () => {
    let body;
    try { body = JSON.parse(document.getElementById('cj').value); } catch (e) { document.getElementById('co').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const res = await call('PUT', '/company', { body, quiet: true });
    if (res.ok) { toast('Company saved'); renderCompany(); } else document.getElementById('co').innerHTML = `<div class="result bad"><pre class="json">${jsonHtml(res.data)}</pre></div>`;
  });
}

/* ---------------- Audit ---------------- */

const auditState = { page: 1, entity: '', action: '' };
async function renderAudit() {
  document.title = 'Audit log · Fleet ERP API Console';
  const r = await call('GET', '/audit-logs', { query: { page: auditState.page, limit: 50, entity: auditState.entity, action: auditState.action }, quiet: true });
  main().innerHTML = h`
  <div class="page">
    <div class="page-head"><h1>Audit log</h1><p>Every create, change, archive, restore and delete, with who did it and what changed. Sensitive values and secrets are recorded as hidden.</p></div>
    <div class="panel"><div class="panel-head toolbar">
      <select class="in" id="ae"><option value="">All masters</option>${[...state.masters.map((m) => m.key), 'company'].map((k) => `<option ${auditState.entity === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
      <select class="in" id="aa"><option value="">All actions</option>${['create', 'update', 'archive', 'restore', 'delete', 'custom'].map((a) => `<option ${auditState.action === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
    </div>
    ${r.ok ? (r.data.data.length ? `<div class="tbl"><table class="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Master</th><th>Record</th><th>Changes</th></tr></thead><tbody>${r.data.data.map((a) => `<tr><td class="small">${fmtDate(a.at)}</td><td class="small">${esc(a.actorName || '—')}</td><td>${esc(a.action)}</td><td class="mono small">${esc(a.entity)}</td><td class="mono small">${short(a.entityId)}</td><td class="small">${esc(a.summary || '')}${(a.changes || []).slice(0, 6).map((c) => `<div><span class="mono">${esc(c.path)}</span>: ${esc(JSON.stringify(c.from) ?? '')} → ${esc(JSON.stringify(c.to) ?? '')}</div>`).join('')}${(a.changes || []).length > 6 ? `<div class="muted">+${a.changes.length - 6} more</div>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="pager"><span>${r.data.meta.total} entries · page ${r.data.meta.page} of ${Math.max(1, r.data.meta.totalPages)}</span><span class="toolbar"><button class="btn sm" type="button" id="ap" ${r.data.meta.hasPrevPage ? '' : 'disabled'}>Previous</button><button class="btn sm" type="button" id="an" ${r.data.meta.hasNextPage ? '' : 'disabled'}>Next</button></span></div>` : '<p class="empty">No entries.</p>') : `<div class="panel-body"><pre class="json">${jsonHtml(r.data)}</pre></div>`}
    </div>
  </div>`;
  document.getElementById('ae').addEventListener('change', (e) => { auditState.entity = e.target.value; auditState.page = 1; renderAudit(); });
  document.getElementById('aa').addEventListener('change', (e) => { auditState.action = e.target.value; auditState.page = 1; renderAudit(); });
  const p = document.getElementById('ap'); const n = document.getElementById('an');
  if (p) p.addEventListener('click', () => { auditState.page -= 1; renderAudit(); });
  if (n) n.addEventListener('click', () => { auditState.page += 1; renderAudit(); });
}

/* ---------------- API reference ---------------- */

function renderApi() {
  document.title = 'API reference · Fleet ERP API Console';
  const all = [...(state.overview?.endpoints || []), ...state.masters.flatMap((m) => m.endpoints)];
  main().innerHTML = h`
  <div class="page">
    <div class="page-head"><h1>API reference</h1><p>${all.length} endpoints with the permission each needs, its rate limit and what it validates. Responses use one envelope: <span class="mono">{ success, data, meta?, message? }</span> or <span class="mono">{ success: false, error: { code, message, details? }, requestId }</span>.</p></div>
    <div class="panel"><div class="panel-head"><input class="in" id="af2" placeholder="Filter by path, method or permission" size="40"><span class="small muted" id="afc"></span></div>
    <div class="tbl"><table class="t"><thead><tr><th>Method</th><th>Path</th><th>Permission</th><th>Rate limit</th><th>Validates</th><th></th></tr></thead><tbody id="apiRows"></tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h3>Error codes</h3></div><div class="tbl"><table class="t"><thead><tr><th>HTTP</th><th>Code</th><th>When</th></tr></thead><tbody>
      ${[[400, 'BAD_REQUEST', 'Malformed JSON, operator-like keys ($, dots), wrong types'], [401, 'UNAUTHORIZED', 'Missing, expired or revoked token; wrong e-mail or password'], [403, 'FORBIDDEN', 'Your role lacks the permission; account deactivated'], [404, 'NOT_FOUND', 'Record or route does not exist'], [409, 'CONFLICT', 'Duplicate value, stale version, record in use, state conflict'], [413, 'PAYLOAD_TOO_LARGE', 'Body over 1 MB'], [422, 'VALIDATION_ERROR', 'Schema or business rule failed; details list each field'], [429, 'TOO_MANY_REQUESTS', 'Rate limit hit or account temporarily locked'], [500, 'INTERNAL_SERVER_ERROR', 'Unexpected failure (details hidden in production)'], [503, 'SERVICE_UNAVAILABLE', 'Database not reachable']].map(([s, c, w]) => `<tr><td class="num">${s}</td><td class="mono">${c}</td><td>${w}</td></tr>`).join('')}
    </tbody></table></div></div>
  </div>`;
  const rows = document.getElementById('apiRows');
  const draw = (q) => {
    const list = all.filter((e) => !q || `${e.method} ${e.path} ${e.permission || ''}`.toLowerCase().includes(q));
    rows.innerHTML = endpointRows(list);
    document.getElementById('afc').textContent = `${list.length} shown`;
    bindTry(rows, list);
  };
  document.getElementById('af2').addEventListener('input', (e) => draw(e.target.value.trim().toLowerCase()));
  draw('');
}

/* ---------------- Request log ---------------- */

function renderRequests() {
  document.title = 'Request log · Fleet ERP API Console';
  main().innerHTML = h`
  <div class="page">
    <div class="page-head"><h1>Request log</h1><p>Every request this console made in this tab, newest first (up to 200). Open one to see the body sent and the full response.</p></div>
    <div class="panel"><div class="panel-head"><span class="small muted">${state.log.length} requests</span><button class="btn sm" type="button" id="clr">Clear</button></div>
    ${state.log.map((e) => `<details class="log"><summary><span class="small muted">${e.at.toLocaleTimeString()}</span><span class="m ${e.method}">${e.method}</span><span class="mono small">${esc(e.path)}</span><span class="st ${e.status >= 200 && e.status < 300 ? 'ok' : e.status >= 500 || e.status === 0 ? 'bad' : 'warn'}">${e.status}</span><span class="small muted">${e.ms} ms</span></summary><div>${e.requestId ? `<span class="small muted">Request id <span class="mono">${esc(e.requestId)}</span>${e.rateLimit ? ` · ${esc(e.rateLimit)}` : ''}</span>` : ''}${e.request !== undefined ? `<span class="small">Sent</span><pre class="json">${jsonHtml(e.request)}</pre>` : ''}<span class="small">Received</span><pre class="json">${jsonHtml(e.response)}</pre></div></details>`).join('') || '<p class="empty">No requests yet.</p>'}
    </div>
  </div>`;
  document.getElementById('clr').addEventListener('click', () => { state.log = []; renderRequests(); });
}

boot();
