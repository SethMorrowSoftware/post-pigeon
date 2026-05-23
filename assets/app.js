/* =============================================================
   Post Pigeon — vanilla JS app
   No frameworks. State is a plain object, persisted to localStorage
   and (when authenticated) to MySQL via api.php on the server.
   ============================================================= */

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- State ---------------- */
const STATE = {
  tabs: [],          // [{id, name, dirty, request}]
  activeTabId: null,
  collections: [],   // [{id, name, open:true, requests:[reqLite]}]
  history: [],       // [{id, ts, method, url, status, timeMs}]
  envs: [],          // [{id, name, vars:[{key,val,enabled}]}]
  activeEnvId: null,
  serverProxy: null, // 'ok' | 'fallback' | null
  user: null,        // {id, email, username, is_admin, must_change_password, ...}
};

/* ---------------- HTTP helpers (auth-aware) ---------------- */
// Wrap fetch so any 401 from our own endpoints kicks us back to login.html
// rather than silently failing or producing confusing UI states.
async function ppFetch(url, opts = {}) {
  const init = { credentials: 'same-origin', ...opts };
  const r = await fetch(url, init);
  if (r.status === 401) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace('login.html?reason=expired&next=' + next);
    // Returning a never-resolving promise prevents callers from racing the redirect.
    return new Promise(() => {});
  }
  return r;
}

const newRequest = (over={}) => ({
  id: uid(),
  name: 'Untitled',
  method: 'GET',
  url: '',
  params:    [],
  headers:   [],
  form:      [],
  urlencoded:[],
  body:      { mode: 'none', raw: '', rawType: 'json', binary: null },
  auth:      { type: 'none', basic: {user:'',pass:''}, bearer:{token:''}, apikey:{key:'',value:'',in:'header'} },
  description: '',
  prescript: '',
  tests: '',
  settings: { followRedirects: false, verifySSL: true, timeout: 30 },
  response: null,    // {status, timeMs, sizeBytes, headers, body, error?}
  testResults: [],
  ...over,
});

/* ---------------- Persistence ---------------- */
const LS_KEY = 'postpigeon.v1';
// Tabs are deliberately NOT pushed to the server — they're a per-browser
// editor state, not a workspace artifact. Persisting locally means reload
// doesn't drop unsaved in-flight requests.
const LS_TABS_KEY = 'postpigeon.tabs.v1';
let _tabPersistTimer = null;
function persistTabsLocal() {
  if (_tabPersistTimer) clearTimeout(_tabPersistTimer);
  _tabPersistTimer = setTimeout(() => {
    try {
      // Strip volatile fields before persisting so the cache stays small.
      const slim = STATE.tabs.map(t => ({
        id: t.id, name: t.name, dirty: !!t.dirty,
        request: simplify(t.request),
      }));
      localStorage.setItem(LS_TABS_KEY, JSON.stringify({
        tabs: slim, activeTabId: STATE.activeTabId,
      }));
    } catch {}
  }, 300);
}
function loadTabsLocal() {
  try {
    const raw = localStorage.getItem(LS_TABS_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.tabs) || !j.tabs.length) return null;
    j.tabs.forEach(t => { if (t.request) normalizeRequest(t.request); });
    return j;
  } catch { return null; }
}
// Debounce server writes so a flurry of UI changes coalesces into one PUT.
let _persistTimer = null;
let _persistInFlight = false;
let _persistPending  = false;

async function persist() {
  const snap = {
    collections: STATE.collections,
    history:     STATE.history.slice(0, 200),
    envs:        STATE.envs,
    activeEnvId: STATE.activeEnvId,
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(snap)); } catch {}
  // Coalesce: schedule one server write 250 ms after the latest change.
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => persistFlush(snap), 250);
}

async function persistFlush(snap) {
  if (_persistInFlight) { _persistPending = true; return; }
  _persistInFlight = true;
  try {
    const r = await ppFetch('api.php?resource=workspace', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(snap),
    });
    if (!r.ok && r.status !== 401) {
      const j = await r.json().catch(() => ({}));
      console.warn('post-pigeon: workspace save failed', j.error || r.status);
    }
  } catch (e) {
    console.warn('post-pigeon: workspace save error', e);
  } finally {
    _persistInFlight = false;
    if (_persistPending) {
      _persistPending = false;
      // Re-snapshot — STATE may have changed while the request was in flight.
      const next = {
        collections: STATE.collections,
        history:     STATE.history.slice(0, 200),
        envs:        STATE.envs,
        activeEnvId: STATE.activeEnvId,
      };
      persistFlush(next);
    }
  }
}
// Old rows may have been persisted with {name, value}; the UI binds {key, val}.
// Normalize so we don't silently drop user-entered headers.
function normalizeKVRows(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(r => {
    if (!r || typeof r !== 'object') return { key:'', val:'', desc:'', enabled:true };
    const out = { ...r };
    if (out.key === undefined && out.name !== undefined) out.key = out.name;
    if (out.val === undefined && out.value !== undefined) out.val = out.value;
    if (out.enabled === undefined) out.enabled = true;
    return out;
  });
}
function normalizeRequest(r) {
  if (!r || typeof r !== 'object') return newRequest();
  for (const k of ['params','headers','form','urlencoded']) {
    r[k] = normalizeKVRows(r[k]);
  }
  return r;
}
function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  if (Array.isArray(snap.collections)) {
    STATE.collections = snap.collections.map(c => {
      const out = { ...c };
      out.requests = Array.isArray(c.requests) ? c.requests.map(normalizeRequest) : [];
      return out;
    });
  }
  if (Array.isArray(snap.history)) {
    STATE.history = snap.history.map(h => {
      const out = { ...h };
      if (out.snapshot) out.snapshot = normalizeRequest(out.snapshot);
      return out;
    });
  }
  if (Array.isArray(snap.envs)) STATE.envs = snap.envs;
  if (typeof snap.activeEnvId === 'string') STATE.activeEnvId = snap.activeEnvId;
}
async function hydrate() {
  // Prefer server snapshot (canonical source).
  try {
    const r = await ppFetch('api.php?resource=workspace');
    if (r.ok) {
      const j = await r.json();
      if (j && j.data) applySnapshot(j.data);
    }
  } catch {}
  // Fallback to localStorage cache (offline / first run / network blip).
  if (!STATE.collections.length && !STATE.history.length && !STATE.envs.length) {
    try {
      const cached = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (cached) applySnapshot(cached);
    } catch {}
  }
  if (!STATE.collections.length && !STATE.envs.length) seed();
}

async function fetchCurrentUser() {
  try {
    const r = await ppFetch('auth.php?action=me');
    if (!r.ok) return null;
    const j = await r.json();
    return j.user || null;
  } catch {
    return null;
  }
}

function seed() {
  STATE.envs = [
    { id: uid(), name: 'Local', vars: [
      {key:'baseUrl', val:'http://localhost:3000', enabled:true},
      {key:'token',   val:'dev_token_xxx',         enabled:true},
    ]},
    { id: uid(), name: 'Staging', vars: [
      {key:'baseUrl', val:'https://staging.api.example.com', enabled:true},
      {key:'token',   val:'',                                enabled:true},
    ]},
    { id: uid(), name: 'Production', vars: [
      {key:'baseUrl', val:'https://api.example.com', enabled:true},
      {key:'token',   val:'',                        enabled:true},
    ]},
  ];
  STATE.activeEnvId = STATE.envs[0].id;

  STATE.collections = [
    { id: uid(), name: 'Sample · httpbin', open: true, requests: [
      makeLite('GET',  'https://httpbin.org/get?hello=world',  'List things'),
      makeLite('POST', 'https://httpbin.org/post',             'Create thing',
        {body:{mode:'raw', raw:'{\n  "name": "Post Pigeon",\n  "ok": true\n}', rawType:'json'}}),
      makeLite('PUT',  'https://httpbin.org/put',              'Update thing'),
      makeLite('DELETE','https://httpbin.org/delete',          'Delete thing'),
    ]},
    { id: uid(), name: 'My API', open: false, requests: [
      makeLite('GET',  '{{baseUrl}}/v1/users',                 'GET /users'),
      makeLite('GET',  '{{baseUrl}}/v1/users/{{userId}}',      'GET /users/:id'),
      makeLite('POST', '{{baseUrl}}/v1/auth/login',            'Login',
        {body:{mode:'raw', raw:'{\n  "email": "you@example.com",\n  "password": ""\n}', rawType:'json'}}),
    ]},
  ];
}
function makeLite(method, url, name, over={}) {
  return newRequest({ method, url, name, ...over });
}

/* ---------------- Variable resolution ---------------- */
function activeEnv() { return STATE.envs.find(e => e.id === STATE.activeEnvId) || null; }
function getVarMap() {
  const env = activeEnv();
  const m = new Map();
  if (env) for (const v of env.vars) if (v.enabled && v.key) m.set(v.key, v.val);
  return m;
}
function resolveVars(str) {
  if (!str) return str;
  const m = getVarMap();
  return String(str).replace(/\{\{([^}]+)\}\}/g, (_, k) => m.has(k.trim()) ? m.get(k.trim()) : `{{${k}}}`);
}
function highlightVars(text) {
  const m = getVarMap();
  const escaped = text.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  return escaped.replace(/\{\{([^}]+)\}\}/g, (_, k) => {
    const trimmed = k.trim();
    return `<span class="var ${m.has(trimmed) ? '' : 'unset'}">{{${trimmed}}}</span>`;
  });
}

/* ---------------- Send ---------------- */
async function sendRequest(req) {
  // Apply pre-request script (sandboxed).
  try {
    runUserScript(req.prescript, { req });
  } catch (e) { /* swallow */ }

  // Build the actual request after variable substitution.
  const url = buildUrl(req);
  const headers = buildHeaders(req);
  const body = buildBody(req);

  let timeout = +req.settings.timeout || 30;
  if (timeout < 1)   timeout = 1;
  if (timeout > 600) timeout = 600;
  const payload = {
    method: req.method,
    url,
    headers,
    body,
    timeout,
    followRedirects: !!req.settings.followRedirects,
    verifySSL: req.settings.verifySSL !== false,
  };
  const t0 = performance.now();
  let resp;
  try {
    if (STATE.serverProxy === 'ok') {
      const r = await ppFetch('proxy.php', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
      try {
        resp = await r.json();
      } catch (e) {
        resp = { error: 'Proxy returned a non-JSON response (HTTP ' + r.status + ')', timeMs: Math.round(performance.now() - t0) };
      }
    } else {
      // Direct fetch fallback (will hit CORS for many APIs).
      const init = { method: req.method, headers: {} };
      for (const h of headers) if (h.name) init.headers[h.name] = h.value || '';
      if (body && !['GET','HEAD'].includes(req.method)) init.body = body;
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      let timer = null;
      if (ctl) {
        init.signal = ctl.signal;
        timer = setTimeout(() => ctl.abort(), timeout * 1000);
      }
      try {
        const r = await fetch(url, init);
        const txt = await r.text();
        const hdrs = []; r.headers.forEach((v,k) => hdrs.push({name:k, value:v}));
        resp = {
          status: r.status, headers: hdrs, body: txt,
          timeMs: Math.round(performance.now() - t0),
          sizeBytes: txt.length, finalUrl: r.url, redirects: 0,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } catch (err) {
    resp = { error: String(err && err.message || err), timeMs: Math.round(performance.now() - t0) };
  }

  // Some proxy responses fall back to base64 for non-UTF-8 bodies. Decode
  // here so the response viewer sees the raw bytes (interpreted as latin-1
  // text — good enough for hex inspection and avoids a base64 wall of text).
  if (resp && resp.bodyEncoding === 'base64' && typeof resp.body === 'string') {
    try {
      resp.body = atob(resp.body);
    } catch { /* malformed payload — leave as-is */ }
    delete resp.bodyEncoding;
  }

  req.response = resp;
  // Run tests
  req.testResults = runTests(req);
  // History
  STATE.history.unshift({
    id: uid(), ts: Date.now(),
    method: req.method, url, status: resp.status || 0,
    timeMs: resp.timeMs || 0, snapshot: structuredClone(simplify(req)),
  });
  STATE.history = STATE.history.slice(0, 200);
  await persist();
}

function buildUrl(req) {
  let url = resolveVars(req.url || '');
  const params = req.params.filter(p => p.enabled !== false && p.key);
  if (params.length) {
    const search = params.map(p =>
      encodeURIComponent(resolveVars(p.key)) + '=' + encodeURIComponent(resolveVars(p.val||''))).join('&');
    url += (url.includes('?') ? '&' : '?') + search;
  }
  return url;
}
function buildHeaders(req) {
  // KV rows store {key, val, desc, enabled}. The proxy wire format uses {name, value}.
  const out = req.headers.filter(h => h.enabled !== false && (h.key || h.name))
    .map(h => ({
      name:  resolveVars(h.key  ?? h.name  ?? ''),
      value: resolveVars(h.val  ?? h.value ?? ''),
    }));
  // Auth
  const a = req.auth;
  if (a.type === 'basic' && a.basic.user) {
    out.push({ name: 'Authorization', value: 'Basic ' + utf8Btoa(resolveVars(a.basic.user)+':'+resolveVars(a.basic.pass||'')) });
  } else if (a.type === 'bearer' && a.bearer.token) {
    out.push({ name: 'Authorization', value: 'Bearer ' + resolveVars(a.bearer.token) });
  } else if (a.type === 'apikey' && a.apikey.key) {
    if (a.apikey.in === 'header') out.push({ name: resolveVars(a.apikey.key), value: resolveVars(a.apikey.value || '') });
  }
  // Body content-type defaults
  if (req.body.mode === 'raw') {
    const map = { json:'application/json', xml:'application/xml', html:'text/html', text:'text/plain', javascript:'application/javascript' };
    if (!out.some(h => h.name.toLowerCase() === 'content-type')) {
      out.push({ name: 'Content-Type', value: map[req.body.rawType] || 'text/plain' });
    }
  } else if (req.body.mode === 'urlencoded') {
    if (!out.some(h => h.name.toLowerCase() === 'content-type'))
      out.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
  }
  return out;
}
function buildBody(req) {
  if (['GET','HEAD'].includes(req.method)) return null;
  if (req.body.mode === 'raw') return resolveVars(req.body.raw || '');
  if (req.body.mode === 'urlencoded') {
    return req.urlencoded.filter(p => p.enabled !== false && p.key)
      .map(p => encodeURIComponent(resolveVars(p.key))+'='+encodeURIComponent(resolveVars(p.val||''))).join('&');
  }
  if (req.body.mode === 'form') {
    return req.form.filter(p => p.enabled !== false && p.key)
      .map(p => encodeURIComponent(resolveVars(p.key))+'='+encodeURIComponent(resolveVars(p.val||''))).join('&');
  }
  return null;
}

function simplify(req) {
  const { response, testResults, ...rest } = req;
  return rest;
}

/* ---------------- Tests sandbox ---------------- */
function runUserScript(src, ctx) {
  if (!src || !src.trim()) return;
  const env = activeEnv();
  const rb = {
    env: {
      get: k => env ? (env.vars.find(v => v.key===k)||{}).val : undefined,
      set: (k,v) => { if (!env) return;
        const f = env.vars.find(x=>x.key===k);
        if (f) f.val = String(v); else env.vars.push({key:k, val:String(v), enabled:true});
      }
    },
    req: ctx.req,
    res: ctx.res,
    test: () => {}, expect: () => ({ toEqual:()=>{}, toBeTruthy:()=>{}, toContain:()=>{} }),
  };
  // eslint-disable-next-line no-new-func
  new Function('rb', src)(rb);
}
function runTests(req) {
  if (!req.tests || !req.tests.trim() || !req.response) return [];
  const results = [];
  let parsedJson = null;
  try { parsedJson = JSON.parse(req.response.body); } catch {}
  const env = activeEnv();
  const rb = {
    env: { get: k => env ? (env.vars.find(v => v.key===k)||{}).val : undefined, set: ()=>{} },
    req,
    res: { status: req.response.status, headers: req.response.headers, body: req.response.body, json: parsedJson },
    test(name, fn) {
      try { fn(); results.push({ name, pass: true }); }
      catch (e) { results.push({ name, pass: false, msg: String(e.message||e) }); }
    },
    expect(actual) {
      return {
        toEqual: x => { if (actual !== x && JSON.stringify(actual) !== JSON.stringify(x)) throw new Error(`expected ${JSON.stringify(x)}, got ${JSON.stringify(actual)}`); },
        toBeTruthy: () => { if (!actual) throw new Error('expected truthy, got '+JSON.stringify(actual)); },
        toContain: x => { if (!String(actual).includes(x)) throw new Error(`expected to contain ${x}`); },
      };
    },
  };
  try { new Function('rb', req.tests)(rb); }
  catch (e) { results.push({ name: 'script error', pass: false, msg: String(e.message||e) }); }
  return results;
}

/* ---------------- Render ---------------- */
function activeTab() { return STATE.tabs.find(t => t.id === STATE.activeTabId); }

function openRequestInTab(req) {
  const id = uid();
  const tab = { id, name: req.name || nameFromUrl(req.url) || 'Untitled', request: structuredClone(req) };
  STATE.tabs.push(tab);
  STATE.activeTabId = id;
  renderTabs();
  renderActivePanel();
  persistTabsLocal();
}
function nameFromUrl(u) { try { return new URL(u).pathname.replace(/^\/+/, '') || u; } catch { return u; } }

function renderTabs() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  for (const t of STATE.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === STATE.activeTabId ? ' is-active' : '');
    el.dataset.tabId = t.id;
    el.innerHTML = `
      <span class="tab-method method-tag" data-m="${t.request.method}">${t.request.method}</span>
      <span class="tab-name">${escapeHtml(t.name)}</span>
      <span class="tab-dot"></span>
      <button class="tab-close" title="Close">×</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('tab-close')) { closeTab(t.id); return; }
      STATE.activeTabId = t.id; renderTabs(); renderActivePanel(); persistTabsLocal();
    });
    bar.appendChild(el);
  }
  const add = document.createElement('button');
  add.className = 'tab-add'; add.textContent = '+';
  add.addEventListener('click', () => openRequestInTab(newRequest()));
  bar.appendChild(add);
}
function closeTab(id) {
  const i = STATE.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  STATE.tabs.splice(i, 1);
  if (STATE.activeTabId === id) STATE.activeTabId = (STATE.tabs[i] || STATE.tabs[i-1] || {}).id || null;
  if (!STATE.tabs.length) openRequestInTab(newRequest()); else { renderTabs(); renderActivePanel(); }
  persistTabsLocal();
}

function renderActivePanel() {
  const body = $('#workspaceBody');
  body.innerHTML = '';
  const tab = activeTab(); if (!tab) return;
  const tpl = $('#tpl-tab-panel').content.cloneNode(true);
  const panel = tpl.querySelector('.tab-panel');
  panel.classList.add('is-active');
  body.appendChild(panel);
  bindPanel(panel, tab);
}

function bindPanel(panel, tab) {
  const r = tab.request;

  // ---- Method + URL
  const methodSel = $('select[data-bind="method"]', panel);
  methodSel.value = r.method;
  methodSel.dataset.m = r.method;
  methodSel.addEventListener('change', () => {
    r.method = methodSel.value; methodSel.dataset.m = r.method;
    renderTabs(); markDirty(tab);
  });

  const urlInput = $('input[data-bind="url"]', panel);
  const urlOver = $('[data-overlay]', panel);
  urlInput.value = r.url;
  const refreshOverlay = () => { urlOver.innerHTML = highlightVars(urlInput.value); urlOver.scrollLeft = urlInput.scrollLeft; };
  urlInput.addEventListener('input', () => { r.url = urlInput.value; refreshOverlay(); markDirty(tab); });
  urlInput.addEventListener('scroll', refreshOverlay);
  refreshOverlay();

  // ---- Subtabs
  bindSubtabs(panel, '[data-subtabs="req"]', '[data-subtab-body] > [data-pane]');

  // ---- KV editors
  bindKV(panel, 'params');
  bindKV(panel, 'headers');
  bindKV(panel, 'form');
  bindKV(panel, 'urlencoded');

  // ---- Body modes
  const modeRadios = $$('input[name="bodymode"]', panel);
  modeRadios.forEach(rad => {
    rad.checked = (rad.value === r.body.mode);
    rad.addEventListener('change', () => {
      r.body.mode = rad.value; refreshBodyView(); updateBadges(); markDirty(tab);
    });
  });
  const refreshBodyView = () => {
    $$('[data-bodyview]', panel).forEach(el => el.hidden = (el.dataset.bodyview !== r.body.mode));
    $('.body-rawtype', panel).hidden  = r.body.mode !== 'raw';
    $('[data-bodyformat]', panel).hidden = r.body.mode !== 'raw';
  };
  refreshBodyView();

  const rawType = $('[data-bind="body.rawType"]', panel);
  rawType.value = r.body.rawType;
  rawType.addEventListener('change', () => { r.body.rawType = rawType.value; markDirty(tab); });

  const rawArea = $('textarea[data-bind="body.raw"]', panel);
  rawArea.value = r.body.raw || '';
  rawArea.addEventListener('input', () => { r.body.raw = rawArea.value; updateBadges(); markDirty(tab); });

  $('[data-action="format-body"]', panel).addEventListener('click', () => {
    if (r.body.rawType !== 'json') return;
    try { r.body.raw = JSON.stringify(JSON.parse(r.body.raw), null, 2); rawArea.value = r.body.raw; toast('Formatted','ok'); }
    catch (e) { toast('Invalid JSON: ' + e.message, 'err'); }
  });

  // ---- Auth
  const authType = $('select[data-bind="auth.type"]', panel);
  authType.value = r.auth.type;
  authType.addEventListener('change', () => { r.auth.type = authType.value; renderAuthForm(); markDirty(tab); });
  const authForm = $('[data-auth-form]', panel);
  function renderAuthForm() {
    authForm.innerHTML = '';
    const t = r.auth.type;
    const mk = (label, key, type='text') => {
      const wrap = document.createElement('label'); wrap.className = 'field';
      wrap.innerHTML = `<span class="field-label">${label}</span><input type="${type}" data-k="${key}">`;
      const inp = wrap.querySelector('input');
      inp.value = key.split('.').reduce((o,p)=>o?.[p], r.auth) || '';
      inp.addEventListener('input', () => {
        const parts = key.split('.');
        let o = r.auth; for (let i=0; i<parts.length-1; i++) o = o[parts[i]];
        o[parts.at(-1)] = inp.value; markDirty(tab);
      });
      authForm.appendChild(wrap);
    };
    if (t === 'basic')  { mk('Username','basic.user'); mk('Password','basic.pass','password'); }
    if (t === 'bearer') { mk('Token','bearer.token'); }
    if (t === 'apikey') {
      mk('Key','apikey.key'); mk('Value','apikey.value');
      const sel = document.createElement('label'); sel.className='field';
      sel.innerHTML = `<span class="field-label">Add To</span><select><option value="header">Header</option><option value="query">Query Param</option></select>`;
      const s = sel.querySelector('select'); s.value = r.auth.apikey.in || 'header';
      s.addEventListener('change', () => { r.auth.apikey.in = s.value; markDirty(tab); });
      authForm.appendChild(sel);
    }
    if (t === 'none') { authForm.innerHTML = '<p class="muted" style="font:500 12px var(--mono)">No auth will be sent with this request.</p>'; }
  }
  renderAuthForm();

  // ---- Scripts + settings
  bindBindings(panel, r, tab);

  // ---- Send
  const sendBtn = $('[data-action="send"]', panel);
  sendBtn.addEventListener('click', async () => {
    sendBtn.dataset.loading = 'true';
    await sendRequest(r);
    sendBtn.dataset.loading = 'false';
    renderResponse(panel, r);
    renderHistory();
    updateBadges();
  });

  // ---- Save / code-gen
  $('[data-action="save-request"]', panel).addEventListener('click', () => openSaveModal(tab));
  $('[data-action="code-gen"]', panel).addEventListener('click', () => openCodegenModal(r));

  // ---- Splitter
  bindSplitter(panel);

  // ---- Response (if exists)
  renderResponse(panel, r);

  updateBadges();
  function updateBadges() {
    panel.querySelector('[data-count="params"]').textContent = (r.params.filter(p=>p.enabled!==false&&p.key).length||'');
    panel.querySelector('[data-count="headers"]').textContent = (r.headers.filter(p=>p.enabled!==false&&p.key).length||'');
    const bodyCount = r.body.mode==='none' ? '' :
      r.body.mode==='raw' ? (r.body.raw?'•':'') :
      (r[r.body.mode] || []).filter(p=>p.enabled!==false&&p.key).length || '';
    panel.querySelector('[data-count="body"]').textContent = bodyCount;
  }
  // Recompute counts live as KV rows change.
  const onKVChanged = () => { if (panel.isConnected) updateBadges(); };
  document.addEventListener('pp:kv-changed', onKVChanged);
  // Drop the listener once the panel is detached.
  new MutationObserver((_, obs) => {
    if (!panel.isConnected) {
      document.removeEventListener('pp:kv-changed', onKVChanged);
      obs.disconnect();
    }
  }).observe(document.getElementById('workspaceBody'), { childList: true });

  // Keyboard shortcut: Ctrl/Cmd+Enter to send
  panel.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); openSaveModal(tab); }
  });
}

function bindBindings(panel, r, tab) {
  $$('[data-bind]', panel).forEach(el => {
    const key = el.dataset.bind;
    if (['method','url','auth.type','body.rawType','body.raw'].includes(key)) return;
    if (key === 'body.binary') return;
    const get = () => key.split('.').reduce((o,p)=>o?.[p], r);
    const set = v => {
      const parts = key.split('.'); let o = r;
      for (let i=0;i<parts.length-1;i++) o = o[parts[i]];
      o[parts.at(-1)] = v;
    };
    if (el.type === 'checkbox') { el.checked = !!get(); el.addEventListener('change', ()=>{set(el.checked); markDirty(tab);}); }
    else { el.value = get() ?? ''; el.addEventListener('input', ()=>{set(el.type==='number'?+el.value:el.value); markDirty(tab);}); }
  });
}

function markDirty(tab) {
  tab.dirty = true;
  const el = $(`.tab[data-tab-id="${tab.id}"]`); if (el) el.dataset.dirty = 'true';
  const r = tab.request;
  if (r.url) {
    const nm = nameFromUrl(resolveVars(r.url)); tab.name = r.name && r.name !== 'Untitled' ? r.name : nm;
    const span = el?.querySelector('.tab-name'); if (span) span.textContent = tab.name;
    const meth = el?.querySelector('.tab-method'); if (meth) { meth.dataset.m = r.method; meth.textContent = r.method; }
  }
  persistTabsLocal();
}

/* ---------------- Subtab + KV ---------------- */
function bindSubtabs(root, tabsSel, paneAncestorSel) {
  const tabs = $$(tabsSel + ' .subtab', root);
  const panes = $$(paneAncestorSel, root);
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.toggle('is-active', x === t));
    panes.forEach(p => p.hidden = (p.dataset.pane !== t.dataset.subtab));
  }));
}

function bindKV(panel, target) {
  const list = $(`[data-rows="${target}"]`, panel);
  const tab = activeTab(); const arr = tab.request[target];
  list.innerHTML = '';
  arr.forEach(row => list.appendChild(buildKVRow(target, row)));
  // ensure at least one empty row for entry
  if (!arr.length) { addRow(target); }
  $(`[data-action="add-row"][data-row-target="${target}"]`, panel).addEventListener('click', () => addRow(target));
}
function addRow(target) {
  const tab = activeTab();
  const row = { key:'', val:'', desc:'', enabled:true };
  tab.request[target].push(row);
  const list = document.querySelector(`[data-rows="${target}"]`);
  list.appendChild(buildKVRow(target, row));
}
function buildKVRow(target, row) {
  const tpl = $('#tpl-kv-row').content.cloneNode(true);
  const el = tpl.querySelector('.kv-row');
  el.dataset.disabled = (row.enabled === false);
  const refresh = () => {
    const tab = activeTab();
    if (tab) markDirty(tab);
    // Recompute count badges live as keys are typed.
    document.dispatchEvent(new CustomEvent('pp:kv-changed', { detail: { target } }));
  };
  const c = el.querySelector('.kv-check');
  c.checked = row.enabled !== false;
  c.addEventListener('change', () => { row.enabled = c.checked; el.dataset.disabled = !c.checked; refresh(); });
  const k = el.querySelector('.kv-key'); k.value = row.key || '';  k.addEventListener('input', () => { row.key = k.value; refresh(); });
  const v = el.querySelector('.kv-val'); v.value = row.val || '';  v.addEventListener('input', () => { row.val = v.value; refresh(); });
  const d = el.querySelector('.kv-desc'); d.value = row.desc||''; d.addEventListener('input', () => { row.desc = d.value; refresh(); });
  if (target === 'form') d.placeholder = 'text · file';
  el.querySelector('.kv-del').addEventListener('click', () => {
    const arr = activeTab().request[target];
    const i = arr.indexOf(row); if (i>=0) arr.splice(i,1);
    el.remove();
    refresh();
  });
  return el;
}

/* ---------------- Splitter ---------------- */
function bindSplitter(panel) {
  const top = $('.splitpane-top', panel);
  const bot = $('.splitpane-bot', panel);
  const div = $('.splitpane-divider', panel);
  let dragging = false;
  const onMove = e => {
    if (!dragging) return;
    if (!panel.isConnected) { stop(); return; }
    const rect = panel.getBoundingClientRect();
    const reqRect = $('.reqbar', panel).getBoundingClientRect();
    const offset = e.clientY - reqRect.bottom;
    const total = rect.bottom - reqRect.bottom;
    if (total <= 0) return;
    const ratio = Math.max(0.18, Math.min(0.82, offset / total));
    top.style.flex = `${ratio} 0 0`; bot.style.flex = `${1-ratio} 0 0`;
  };
  const stop = () => {
    dragging = false; document.body.style.cursor = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', stop);
  };
  div.addEventListener('mousedown', () => {
    dragging = true; document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  });
}

/* ---------------- Response render ---------------- */
function renderResponse(panel, r) {
  const meta = $('[data-resp-meta]', panel);
  const tabsBar = $('[data-subtabs="resp"]', panel);
  const body = $('[data-resp-body]', panel);
  if (!r.response) {
    meta.innerHTML = '<span class="resp-empty muted">No response yet — hit <kbd>Send</kbd> to fire this request.</span>';
    tabsBar.hidden = true; body.hidden = true; return;
  }
  tabsBar.hidden = false; body.hidden = false;
  const res = r.response;

  if (res.error) {
    meta.innerHTML = `<span class="status-pill" data-class="5">FAIL</span>
      <span class="resp-meta-item"><strong>${res.timeMs||0}</strong> ms</span>`;
    body.innerHTML = `<div class="resp-error">⚠ ${escapeHtml(res.error)}</div>`;
    return;
  }
  // status=0 with no .error means a soft failure (e.g. proxy returned an
  // empty envelope). Treat it like a 5xx so the pill doesn't end up styled
  // as data-class="0" (which has no styling and looks broken).
  const cls = res.status > 0 ? String(res.status)[0] : '5';
  const sizeKb = res.sizeBytes ? (res.sizeBytes/1024).toFixed(1) : '0';
  meta.innerHTML = `
    <span class="status-pill" data-class="${cls}">${res.status} ${statusText(res.status)}</span>
    <span class="resp-meta-item">⏱ <strong>${res.timeMs} ms</strong></span>
    <span class="resp-meta-item">⇣ <strong>${sizeKb} KB</strong></span>
    ${res.redirects?`<span class="resp-meta-item">↻ ${res.redirects} redirects</span>`:''}
    <span class="resp-meta-spacer"></span>
    <button class="ghost-btn" data-action="copy-resp">copy</button>
    <button class="ghost-btn" data-action="save-resp">save</button>
  `;
  meta.querySelector('[data-action="copy-resp"]').onclick = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(res.body || '');
    toast('Response copied', 'ok');
  };
  meta.querySelector('[data-action="save-resp"]').onclick = () => {
    const blob = new Blob([res.body || ''], {type: 'text/plain'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'response.txt'; a.click();
  };

  $('[data-bodyviewmode]', panel).hidden = false;
  $('.resp-search', panel).hidden = false;

  // Subtab switching — use .onclick so re-renders replace, not stack, handlers.
  const respTabs = $$('.subtab', tabsBar);
  respTabs.forEach(t => t.classList.remove('is-active'));
  respTabs[0].classList.add('is-active');
  respTabs.forEach(t => t.onclick = () => {
    respTabs.forEach(x => x.classList.toggle('is-active', x===t));
    drawRespBody(t.dataset.subtab);
  });

  // View mode
  const vmBtns = $$('[data-bodyviewmode] .seg', panel);
  let viewMode = 'pretty';
  vmBtns.forEach(b => b.onclick = () => {
    vmBtns.forEach(x => x.classList.toggle('is-active', x===b));
    viewMode = b.dataset.viewmode; drawRespBody('body');
  });

  // Search
  let searchTerm = '';
  const searchInput = panel.querySelector('[data-action="search-resp"]');
  searchInput.value = '';
  searchInput.oninput = () => { searchTerm = searchInput.value; drawRespBody('body'); };

  // Header/test counts
  panel.querySelector('[data-count="resp-headers"]').textContent = res.headers.length || '';
  panel.querySelector('[data-count="resp-tests"]').textContent = r.testResults.length || '';

  drawRespBody('body');

  function drawRespBody(which) {
    body.innerHTML = '';
    if (which === 'body') {
      const ct = (res.headers.find(h => h.name.toLowerCase()==='content-type')||{}).value || '';
      const isJson = ct.includes('json') || /^[\s\[{]/.test(res.body || '');
      const pre = document.createElement('pre');
      pre.className = 'resp-pre';
      let txt = res.body || '';
      if (viewMode === 'pretty' && isJson) {
        try { txt = JSON.stringify(JSON.parse(res.body), null, 2); }
        catch {}
        pre.innerHTML = colorJson(txt, searchTerm);
      } else if (viewMode === 'preview' && ct.includes('html')) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'flex:1; width:100%; border:0; background:#fff;';
        // Sandbox: never run scripts or top-level navigation from previewed HTML.
        iframe.setAttribute('sandbox', '');
        iframe.referrerPolicy = 'no-referrer';
        iframe.srcdoc = res.body || '';
        body.appendChild(iframe); return;
      } else {
        pre.textContent = txt;
        if (searchTerm) {
          const safe = escapeHtml(txt);
          const re = new RegExp(escapeRegex(searchTerm), 'gi');
          pre.innerHTML = safe.replace(re, m => `<span class="search-hit">${m}</span>`);
        }
      }
      body.appendChild(pre);
      return;
    }
    if (which === 'headers') {
      body.appendChild(buildKvTable('Header', res.headers.map(h => [h.name, h.value])));
      return;
    }
    if (which === 'cookies') {
      const setCookie = res.headers.filter(h => h.name.toLowerCase()==='set-cookie');
      if (!setCookie.length) { body.innerHTML = '<p class="muted" style="padding:18px">No cookies in response.</p>'; return; }
      body.appendChild(buildKvTable('Cookie', setCookie.map(h => {
        const m = (h.value||'').split(';')[0].split('='); return [m[0], m[1]||''];
      })));
      return;
    }
    if (which === 'tests') {
      const wrap = document.createElement('div'); wrap.className = 'test-list';
      if (!r.testResults.length) { wrap.innerHTML = '<p class="muted">No tests defined for this request.</p>'; }
      r.testResults.forEach(t => {
        const row = document.createElement('div'); row.className = 'test-row';
        row.dataset.pass = t.pass;
        row.innerHTML = `<span class="test-status">${t.pass?'PASS':'FAIL'}</span>
                        <span class="test-name">${escapeHtml(t.name)}</span>
                        ${t.msg?`<span class="test-msg">${escapeHtml(t.msg)}</span>`:''}`;
        wrap.appendChild(row);
      });
      body.appendChild(wrap); return;
    }
    if (which === 'timeline') {
      const total = res.timeMs || 0;
      // Prefer real cURL phases (proxy.php returns them via curl_getinfo).
      // Fall back to a synthetic split so old responses in history still draw.
      let dns, tcp, tls, wait, dl, real = false;
      if (res.phases && typeof res.phases === 'object') {
        dns  = +res.phases.dns      || 0;
        tcp  = +res.phases.tcp      || 0;
        tls  = +res.phases.tls      || 0;
        wait = +res.phases.wait     || 0;
        dl   = +res.phases.download || 0;
        real = true;
      } else {
        dns  = Math.round(total*0.05);
        tcp  = Math.round(total*0.10);
        tls  = Math.round(total*0.10);
        wait = Math.round(total*0.65);
        dl   = Math.max(0, total - dns - tcp - tls - wait);
      }
      const denom = Math.max(1, dns + tcp + tls + wait + dl);
      const pct = n => ((n / denom) * 100).toFixed(2);
      const wrap = document.createElement('div'); wrap.className = 'timeline';
      wrap.innerHTML = `
        <div class="timeline-bar">
          <span class="seg-dns" style="width:${pct(dns)}%"></span>
          <span class="seg-tcp" style="width:${pct(tcp)}%"></span>
          <span class="seg-tls" style="width:${pct(tls)}%"></span>
          <span class="seg-wait" style="width:${pct(wait)}%"></span>
          <span class="seg-download" style="width:${pct(dl)}%"></span>
        </div>
        <div class="timeline-legend">
          <span><i class="seg-dns" style="background:#5b8def"></i>DNS ${dns} ms</span>
          <span><i class="seg-tcp" style="background:#4fb286"></i>TCP ${tcp} ms</span>
          <span><i class="seg-tls" style="background:#b07cd9"></i>TLS ${tls} ms</span>
          <span><i class="seg-wait" style="background:#d9a441"></i>Server ${wait} ms</span>
          <span><i class="seg-download" style="background:#d96363"></i>Download ${dl} ms</span>
          <span class="muted">total ${total} ms · ${real ? 'cURL phases' : 'synthetic phases'}</span>
        </div>`;
      body.appendChild(wrap); return;
    }
  }
}

function buildKvTable(keyLabel, rows) {
  const t = document.createElement('table'); t.className = 'kv-table';
  t.innerHTML = `<thead><tr><th>${keyLabel}</th><th>Value</th></tr></thead>`;
  const tb = document.createElement('tbody');
  rows.forEach(([k,v]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="kv-table-key">${escapeHtml(k)}</td><td class="kv-table-val">${escapeHtml(v)}</td>`;
    tb.appendChild(tr);
  });
  t.appendChild(tb); return t;
}

/* ---------------- JSON colorizer ---------------- */
function colorJson(src, searchTerm='') {
  const escaped = escapeHtml(src);
  let out = escaped
    .replace(/(&quot;[^&\\]*?(?:\\.[^&\\]*?)*&quot;)\s*:/g, '<span class="tok-key">$1</span>:')
    .replace(/:\s*(&quot;[^&\\]*?(?:\\.[^&\\]*?)*&quot;)/g, ': <span class="tok-str">$1</span>')
    .replace(/\b(true|false)\b/g, '<span class="tok-bool">$1</span>')
    .replace(/\bnull\b/g, '<span class="tok-null">null</span>')
    .replace(/(?<![&\w])(-?\d+\.?\d*(?:e[+-]?\d+)?)/gi, '<span class="tok-num">$1</span>')
    .replace(/([{}\[\],])/g, '<span class="tok-punct">$1</span>');
  if (searchTerm) {
    const re = new RegExp(escapeRegex(searchTerm), 'gi');
    out = out.replace(re, m => `<span class="search-hit">${m}</span>`);
  }
  return out;
}

/* ---------------- Sidebar ---------------- */
function renderSidebar() {
  // Pane switching
  const tabs = $$('.side-tab');
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.toggle('is-active', x===t));
    $$('.side-pane').forEach(p => p.classList.toggle('is-active', p.dataset.pane === t.dataset.pane));
  }));
  renderCollections(); renderHistory(); renderEnvs(); renderEnvSwitcher();
  $('#sideSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('.tree-leaf, .tree-group').forEach(el => {
      const txt = el.textContent.toLowerCase();
      el.style.display = txt.includes(q) ? '' : 'none';
    });
  });
}
function renderCollections() {
  const tree = $('#collectionsTree'); tree.innerHTML = '';
  for (const col of STATE.collections) {
    const g = document.createElement('div'); g.className = 'tree-group'; g.dataset.open = col.open;
    g.innerHTML = `
      <div class="tree-group-header">
        <span class="tree-caret">▾</span>
        <span class="tree-group-name">${escapeHtml(col.name)}</span>
        <span class="tree-group-meta">${col.requests.length}</span>
        <span class="tree-actions">
          <button class="icon-btn tree-act" data-act="rename"  title="Rename collection">✎</button>
          <button class="icon-btn tree-act" data-act="delete"  title="Delete collection">✕</button>
        </span>
      </div>
      <div class="tree-children"></div>`;
    const header = g.querySelector('.tree-group-header');
    header.addEventListener('click', e => {
      if (e.target.closest('.tree-act')) return;
      col.open = (g.dataset.open !== 'true'); g.dataset.open = col.open; persist();
    });
    header.querySelector('[data-act="rename"]').addEventListener('click', e => {
      e.stopPropagation();
      const name = prompt('Rename collection:', col.name);
      if (name && name.trim()) { col.name = name.trim(); persist(); renderCollections(); }
    });
    header.querySelector('[data-act="delete"]').addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Delete collection "${col.name}" and its ${col.requests.length} request(s)?`)) return;
      STATE.collections = STATE.collections.filter(c => c.id !== col.id);
      persist(); renderCollections();
    });
    const kids = g.querySelector('.tree-children');
    col.requests.forEach(req => {
      const leaf = document.createElement('div'); leaf.className = 'tree-leaf';
      leaf.innerHTML = `<span class="method-tag" data-m="${req.method}">${req.method}</span>
                       <span class="tree-leaf-name">${escapeHtml(req.name || nameFromUrl(req.url))}</span>
                       <span class="tree-actions">
                         <button class="icon-btn tree-act" data-act="rename"    title="Rename request">✎</button>
                         <button class="icon-btn tree-act" data-act="duplicate" title="Duplicate request">⎘</button>
                         <button class="icon-btn tree-act" data-act="delete"    title="Delete request">✕</button>
                       </span>`;
      leaf.addEventListener('click', e => {
        if (e.target.closest('.tree-act')) return;
        openRequestInTab(req);
      });
      leaf.querySelector('[data-act="rename"]').addEventListener('click', e => {
        e.stopPropagation();
        const name = prompt('Rename request:', req.name || '');
        if (name && name.trim()) { req.name = name.trim(); persist(); renderCollections(); }
      });
      leaf.querySelector('[data-act="duplicate"]').addEventListener('click', e => {
        e.stopPropagation();
        const copy = structuredClone(req);
        copy.id = uid();
        copy.name = (req.name || 'Untitled') + ' (copy)';
        col.requests.push(copy);
        persist(); renderCollections();
      });
      leaf.querySelector('[data-act="delete"]').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`Delete "${req.name || req.url}"?`)) return;
        col.requests = col.requests.filter(r => r.id !== req.id);
        persist(); renderCollections();
      });
      kids.appendChild(leaf);
    });
    tree.appendChild(g);
  }
  if (!STATE.collections.length) {
    tree.innerHTML = '<p class="muted" style="padding:14px;font:500 12px var(--mono)">No collections yet — click + to create one.</p>';
  }
}
function renderHistory() {
  const tree = $('#historyTree'); tree.innerHTML = '';
  if (!STATE.history.length) { tree.innerHTML = '<p class="muted" style="padding:14px;font:500 12px var(--mono)">No history yet.</p>'; return; }
  for (const h of STATE.history) {
    const leaf = document.createElement('div'); leaf.className = 'tree-leaf';
    const status = h.status ? `<span class="tree-leaf-time">${h.status}</span>` : '';
    leaf.innerHTML = `<span class="method-tag" data-m="${h.method}">${h.method}</span>
                     <span class="tree-leaf-name">${escapeHtml(h.url)}</span> ${status}
                     <span class="tree-leaf-time">${timeAgo(h.ts)}</span>`;
    leaf.addEventListener('click', () => openRequestInTab(h.snapshot));
    tree.appendChild(leaf);
  }
}
function renderEnvs() {
  const tree = $('#envTree'); tree.innerHTML = '';
  for (const env of STATE.envs) {
    const g = document.createElement('div'); g.className = 'tree-group'; g.dataset.open = false;
    const isActive = env.id === STATE.activeEnvId;
    g.innerHTML = `
      <div class="tree-group-header">
        <span class="tree-caret">▾</span>
        <span class="tree-group-name">${escapeHtml(env.name)} ${isActive?'<span class="muted">· active</span>':''}</span>
        <span class="tree-group-meta">${env.vars.length}</span>
        <span class="tree-actions">
          <button class="icon-btn tree-act" data-act="rename" title="Rename environment">✎</button>
          <button class="icon-btn tree-act" data-act="delete" title="Delete environment">✕</button>
        </span>
      </div>
      <div class="tree-children"></div>`;
    const header = g.querySelector('.tree-group-header');
    header.addEventListener('click', e => {
      if (e.target.closest('.tree-act')) return;
      g.dataset.open = (g.dataset.open !== 'true');
    });
    header.querySelector('[data-act="rename"]').addEventListener('click', e => {
      e.stopPropagation();
      const name = prompt('Rename environment:', env.name);
      if (name && name.trim()) { env.name = name.trim(); persist(); renderEnvs(); renderEnvSwitcher(); }
    });
    header.querySelector('[data-act="delete"]').addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Delete environment "${env.name}"?`)) return;
      STATE.envs = STATE.envs.filter(x => x.id !== env.id);
      if (STATE.activeEnvId === env.id) STATE.activeEnvId = STATE.envs[0]?.id || null;
      persist(); renderEnvs(); renderEnvSwitcher(); refreshAllOverlays();
    });
    const kids = g.querySelector('.tree-children');
    env.vars.forEach(v => {
      const row = document.createElement('div'); row.className = 'tree-leaf';
      row.innerHTML = `<span class="tree-leaf-name"><code>{{${escapeHtml(v.key)}}}</code></span>
                      <span class="tree-leaf-time">${escapeHtml(v.val||'').slice(0,20)}</span>`;
      kids.appendChild(row);
    });
    const setBtn = document.createElement('button'); setBtn.className = 'ghost-btn ghost-btn--row';
    setBtn.textContent = isActive ? 'editing…' : 'set active'; setBtn.style.margin = '4px 0 8px';
    setBtn.addEventListener('click', e => { e.stopPropagation(); STATE.activeEnvId = env.id; persist(); renderEnvs(); renderEnvSwitcher(); refreshAllOverlays(); });
    kids.appendChild(setBtn);
    const editBtn = document.createElement('button'); editBtn.className = 'ghost-btn ghost-btn--row';
    editBtn.textContent = 'edit vars'; editBtn.style.margin = '0 0 8px';
    editBtn.addEventListener('click', e => { e.stopPropagation(); openEnvEditor(env); });
    kids.appendChild(editBtn);
    tree.appendChild(g);
  }
  if (!STATE.envs.length) {
    tree.innerHTML = '<p class="muted" style="padding:14px;font:500 12px var(--mono)">No environments yet — click + to create one.</p>';
  }
}
function renderEnvSwitcher() {
  const env = activeEnv();
  $('#envCurrentName').textContent = env ? env.name : 'No environment';
  $('#envButton').dataset.active = !!env;
}
function refreshAllOverlays() {
  $$('[data-overlay]').forEach(over => {
    const inp = over.parentElement.querySelector('.url-input');
    if (inp) over.innerHTML = highlightVars(inp.value);
  });
}

/* ---------------- Modals ---------------- */
let _modalOverlayBound = false;
function openModal(html) {
  const root = $('#modalRoot');
  root.innerHTML = html; root.hidden = false;
  if (!_modalOverlayBound) {
    // One persistent listener: close only when the click was on the overlay itself.
    root.addEventListener('click', e => { if (e.target === root) closeModal(); });
    _modalOverlayBound = true;
  }
  return root.firstElementChild;
}
function closeModal() { const r = $('#modalRoot'); r.innerHTML = ''; r.hidden = true; }

function openSaveModal(tab) {
  const m = openModal(`
    <div class="modal">
      <div class="modal-head"><h2>Save request</h2><span class="modal-sub">⌘ S</span></div>
      <div class="modal-body">
        <label class="field"><span class="field-label">Name</span><input id="m-name" value="${escapeHtml(tab.name||'')}"></label>
        <label class="field"><span class="field-label">Collection</span>
          <select id="m-col">${STATE.collections.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
            <option value="__new">+ New collection…</option>
          </select>
        </label>
        <label class="field" id="m-newcol-wrap" hidden><span class="field-label">New collection name</span><input id="m-newcol"></label>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" data-cancel>Cancel</button>
        <button class="btn-primary" data-save>Save</button>
      </div>
    </div>`);
  m.querySelector('#m-col').addEventListener('change', e => {
    m.querySelector('#m-newcol-wrap').hidden = e.target.value !== '__new';
  });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('[data-save]').addEventListener('click', () => {
    const name = m.querySelector('#m-name').value || 'Untitled';
    let colId = m.querySelector('#m-col').value;
    if (colId === '__new') {
      const newName = m.querySelector('#m-newcol').value || 'New Collection';
      const c = { id: uid(), name: newName, open: true, requests: [] };
      STATE.collections.push(c); colId = c.id;
    }
    const col = STATE.collections.find(c => c.id === colId);
    const stored = structuredClone(simplify(tab.request));
    stored.name = name;
    // Update in place when an entry with the same id already exists in this
    // collection (re-saving from a tab opened off the sidebar). Otherwise
    // also coalesce by name to avoid silent duplicates on rename-and-save.
    const byId   = col.requests.findIndex(r => r.id && r.id === tab.request.id);
    const byName = byId < 0 ? col.requests.findIndex(r => (r.name || '') === name) : -1;
    let action = 'saved';
    if (byId >= 0) {
      stored.id = col.requests[byId].id;
      col.requests[byId] = stored;
      action = 'updated';
    } else if (byName >= 0) {
      if (confirm(`A request named "${name}" already exists in ${col.name}. Overwrite it?`)) {
        stored.id = col.requests[byName].id;
        col.requests[byName] = stored;
        action = 'updated';
      } else {
        col.requests.push(stored);
      }
    } else {
      col.requests.push(stored);
    }
    // Re-sync the open tab so subsequent saves keep the same id.
    tab.request.id = stored.id;
    tab.name = name; tab.dirty = false;
    closeModal(); renderTabs(); renderCollections(); persist();
    toast(action === 'updated' ? `Updated in ${col.name}` : `Saved to ${col.name}`, 'ok');
  });
}

function openEnvEditor(env) {
  const rows = env.vars.map((v,i) => `
    <tr data-i="${i}">
      <td><input class="kv-key" value="${escapeHtml(v.key)}" data-k="key"></td>
      <td><input class="kv-val" value="${escapeHtml(v.val||'')}" data-k="val"></td>
      <td><button class="kv-del" title="Remove">✕</button></td>
    </tr>`).join('');
  const m = openModal(`
    <div class="modal">
      <div class="modal-head"><h2>Variables · ${escapeHtml(env.name)}</h2><span class="modal-sub">use as <code>{{key}}</code></span></div>
      <div class="modal-body">
        <table class="kv-table vars-table">
          <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
          <tbody id="vars-rows">${rows}</tbody>
        </table>
        <button class="ghost-btn ghost-btn--row" id="vars-add">+ variable</button>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" data-cancel>Close</button>
      </div>
    </div>`);
  const tbody = m.querySelector('#vars-rows');
  function rebind() {
    tbody.querySelectorAll('input').forEach(inp => {
      inp.oninput = () => {
        const i = +inp.closest('tr').dataset.i;
        env.vars[i][inp.dataset.k] = inp.value;
        env.vars[i].enabled = true;
        persist(); renderEnvs(); refreshAllOverlays();
      };
    });
    tbody.querySelectorAll('.kv-del').forEach(btn => {
      btn.onclick = () => {
        const i = +btn.closest('tr').dataset.i;
        env.vars.splice(i,1); persist(); renderEnvs(); refreshAllOverlays(); openEnvEditor(env);
      };
    });
  }
  rebind();
  m.querySelector('#vars-add').addEventListener('click', () => {
    env.vars.push({ key:'', val:'', enabled:true });
    openEnvEditor(env);
  });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
}

function openCodegenModal(req) {
  const langs = [
    { id:'curl',    label:'cURL' },
    { id:'fetch',   label:'JS fetch' },
    { id:'axios',   label:'JS axios' },
    { id:'python',  label:'Python requests' },
    { id:'php',     label:'PHP cURL' },
    { id:'go',      label:'Go net/http' },
    { id:'http',    label:'HTTP' },
  ];
  const m = openModal(`
    <div class="modal">
      <div class="modal-head"><h2>Code snippet</h2><span class="modal-sub">copy-paste, ready to run</span></div>
      <div class="codegen-langs">${langs.map((l,i)=>`<button class="codegen-lang ${i===0?'is-active':''}" data-lang="${l.id}">${l.label}</button>`).join('')}</div>
      <div class="modal-body" style="padding:0">
        <pre class="codegen-pre" id="cg-pre"></pre>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" data-cancel>Close</button>
        <button class="btn-primary" id="cg-copy">Copy</button>
      </div>
    </div>`);
  const pre = m.querySelector('#cg-pre');
  let cur = 'curl';
  const draw = () => { pre.textContent = generateCode(cur, req); };
  m.querySelectorAll('.codegen-lang').forEach(b => b.addEventListener('click', () => {
    m.querySelectorAll('.codegen-lang').forEach(x => x.classList.toggle('is-active', x===b));
    cur = b.dataset.lang; draw();
  }));
  m.querySelector('#cg-copy').addEventListener('click', () => { navigator.clipboard.writeText(pre.textContent); toast('Copied','ok'); });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  draw();
}

function generateCode(lang, req) {
  const url = buildUrl(req); const headers = buildHeaders(req); const body = buildBody(req);
  if (lang === 'curl') {
    let s = `curl -X ${req.method} '${url}'`;
    headers.forEach(h => s += ` \\\n  -H '${h.name}: ${h.value}'`);
    if (body) s += ` \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
    return s;
  }
  if (lang === 'fetch') {
    return `fetch('${url}', {\n  method: '${req.method}',\n  headers: ${JSON.stringify(headers.reduce((a,h)=>(a[h.name]=h.value,a),{}), null, 2)},\n  ${body?`body: ${JSON.stringify(body)},\n`:''}})\n  .then(r => r.json())\n  .then(console.log);`;
  }
  if (lang === 'axios') {
    return `import axios from 'axios';\n\naxios({\n  method: '${req.method}',\n  url: '${url}',\n  headers: ${JSON.stringify(headers.reduce((a,h)=>(a[h.name]=h.value,a),{}), null, 2)},\n  ${body?`data: ${JSON.stringify(body)},\n`:''}}).then(r => console.log(r.data));`;
  }
  if (lang === 'python') {
    return `import requests\n\nresp = requests.request(\n    "${req.method}",\n    "${url}",\n    headers=${JSON.stringify(headers.reduce((a,h)=>(a[h.name]=h.value,a),{}))},\n    ${body?`data=${JSON.stringify(body)},\n`:''})\nprint(resp.status_code, resp.text)`;
  }
  if (lang === 'php') {
    let s = `$ch = curl_init('${url}');\ncurl_setopt($ch, CURLOPT_CUSTOMREQUEST, '${req.method}');\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n`;
    if (headers.length) s += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n${headers.map(h=>`    '${h.name}: ${h.value}'`).join(',\n')}\n]);\n`;
    if (body) s += `curl_setopt($ch, CURLOPT_POSTFIELDS, ${JSON.stringify(body)});\n`;
    s += `$response = curl_exec($ch);\ncurl_close($ch);\necho $response;`;
    return s;
  }
  if (lang === 'go') {
    return `req, _ := http.NewRequest("${req.method}", "${url}", ${body?`strings.NewReader(${JSON.stringify(body)})`:'nil'})\n${headers.map(h=>`req.Header.Set("${h.name}", "${h.value}")`).join('\n')}\n\nresp, _ := http.DefaultClient.Do(req)\ndefer resp.Body.Close()`;
  }
  if (lang === 'http') {
    let s = `${req.method} ${url} HTTP/1.1\n`;
    headers.forEach(h => s += `${h.name}: ${h.value}\n`);
    if (body) s += `\n${body}`;
    return s;
  }
  return '';
}

function openVarsInspector() {
  const env = activeEnv();
  const rows = env ? env.vars.map(v => `<tr><td class="kv-table-key"><code>{{${escapeHtml(v.key)}}}</code></td><td class="kv-table-val">${escapeHtml(v.val||'')}</td></tr>`).join('') : '';
  const m = openModal(`
    <div class="modal">
      <div class="modal-head"><h2>Active variables</h2><span class="modal-sub">${env?escapeHtml(env.name):'no env selected'}</span></div>
      <div class="modal-body">
        ${env?`<table class="kv-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`:`<p class="muted">Pick an environment from the sidebar.</p>`}
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-cancel>Close</button></div>
    </div>`);
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
}

function openImportModal() {
  const m = openModal(`
    <div class="modal">
      <div class="modal-head"><h2>Import</h2><span class="modal-sub">paste cURL or JSON</span></div>
      <div class="modal-body">
        <textarea id="imp" class="code-area" placeholder="curl 'https://api.example.com' -H 'Authorization: …'"></textarea>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" data-cancel>Cancel</button>
        <button class="btn-primary" id="imp-go">Import</button>
      </div>
    </div>`);
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#imp-go').addEventListener('click', () => {
    const txt = m.querySelector('#imp').value.trim();
    try {
      const req = txt.startsWith('curl') ? parseCurl(txt) : newRequest(JSON.parse(txt));
      openRequestInTab(req); closeModal(); toast('Imported','ok');
    } catch (e) { toast('Could not parse: '+e.message,'err'); }
  });
}
function parseCurl(s) {
  // Tokenize a curl command line. Handles single/double-quoted strings with
  // basic escapes, $'...' ANSI-C quoting (curl convert-to-code emits these),
  // line-continuation backslashes, and the common --opt=val form.
  const tokens = tokenizeShell(s.replace(/\\\r?\n/g, ' '));
  if (!tokens.length || !/^curl$/i.test(tokens[0])) {
    throw new Error('Not a curl command (expected to start with "curl")');
  }
  const args = tokens.slice(1);
  const r = newRequest();
  let methodSetExplicitly = false;

  const setMethod = m => { r.method = m.toUpperCase(); methodSetExplicitly = true; };
  const pushHeader = hv => {
    const idx = hv.indexOf(':');
    if (idx > 0) {
      r.headers.push({key: hv.slice(0,idx).trim(), val: hv.slice(idx+1).trim(), enabled:true});
    }
  };

  for (let i = 0; i < args.length; i++) {
    let t = args[i];
    // Split --opt=value into two args so the rest of the loop is uniform.
    let inlineVal = null;
    if (t.startsWith('--') && t.includes('=')) {
      const eq = t.indexOf('=');
      inlineVal = t.slice(eq + 1);
      t = t.slice(0, eq);
    }
    const take = () => {
      if (inlineVal !== null) { const v = inlineVal; inlineVal = null; return v; }
      return args[++i];
    };

    if (t === '-X' || t === '--request') {
      setMethod(take() || 'GET');
    } else if (t === '-H' || t === '--header') {
      pushHeader(take() || '');
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      r.body.mode = 'raw';
      r.body.raw = take() || '';
      r.body.rawType = looksJson(r.body.raw) ? 'json' : 'text';
      if (!methodSetExplicitly) r.method = 'POST';
    } else if (t === '--data-urlencode') {
      r.body.mode = 'urlencoded';
      const pair = take() || '';
      const eq = pair.indexOf('=');
      if (eq > 0) {
        r.urlencoded.push({key: pair.slice(0, eq), val: pair.slice(eq + 1), enabled: true});
      } else {
        r.urlencoded.push({key: pair, val: '', enabled: true});
      }
      if (!methodSetExplicitly) r.method = 'POST';
    } else if (t === '-u' || t === '--user') {
      const creds = take() || '';
      const i2 = creds.indexOf(':');
      r.auth.type = 'basic';
      r.auth.basic.user = i2 >= 0 ? creds.slice(0, i2) : creds;
      r.auth.basic.pass = i2 >= 0 ? creds.slice(i2 + 1) : '';
    } else if (t === '--url') {
      r.url = take() || '';
    } else if (t === '-A' || t === '--user-agent') {
      pushHeader('User-Agent: ' + (take() || ''));
    } else if (t === '-e' || t === '--referer') {
      pushHeader('Referer: ' + (take() || ''));
    } else if (t === '-b' || t === '--cookie') {
      pushHeader('Cookie: ' + (take() || ''));
    } else if (t === '-k' || t === '--insecure') {
      r.settings.verifySSL = false;
    } else if (t === '-L' || t === '--location') {
      r.settings.followRedirects = true;
    } else if (t === '--max-time') {
      const n = parseInt(take() || '', 10); if (!isNaN(n)) r.settings.timeout = Math.max(1, Math.min(600, n));
    } else if (t === '-G' || t === '--get') {
      if (!methodSetExplicitly) r.method = 'GET';
    } else if (t === '--compressed' || t === '-s' || t === '--silent' || t === '-v' || t === '--verbose'
            || t === '-i' || t === '--include' || t === '-#' || t === '--progress-bar') {
      /* flags we can safely ignore */
    } else if (!t.startsWith('-')) {
      if (!r.url) r.url = t;
    }
  }
  if (!r.url) throw new Error('No URL found in curl command');
  r.name = nameFromUrl(r.url) || 'Imported';
  return r;
}

// Minimal POSIX-style shell tokenizer: handles ' "..." escapes, and curl's
// $'...' ANSI-C quoting (with \n, \t, \r, \\, \', \").
function tokenizeShell(s) {
  const out = [];
  let cur = '';
  let inSingle = false, inDouble = false, inAnsiC = false;
  let any = false; // tracks whether we've started a token (so empty quoted strings still emit)
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inAnsiC) {
      if (c === '\'') { inAnsiC = false; continue; }
      if (c === '\\' && i + 1 < s.length) {
        const n = s[++i];
        cur += ({n:'\n', t:'\t', r:'\r', '\\':'\\', '\'':'\'', '"':'"'}[n] ?? n);
      } else cur += c;
      any = true;
      continue;
    }
    if (inSingle) {
      if (c === '\'') inSingle = false;
      else cur += c;
      any = true;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === '\\' && i + 1 < s.length && /["\\$`]/.test(s[i+1])) { cur += s[++i]; }
      else cur += c;
      any = true;
      continue;
    }
    if (c === '$' && s[i+1] === '\'') { inAnsiC = true; i++; any = true; continue; }
    if (c === '\'') { inSingle = true; any = true; continue; }
    if (c === '"')  { inDouble = true; any = true; continue; }
    if (/\s/.test(c)) { if (any) { out.push(cur); cur = ''; any = false; } continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; any = true; continue; }
    cur += c; any = true;
  }
  if (any) out.push(cur);
  return out;
}

function looksJson(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (t[0] !== '{' && t[0] !== '[') return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function openExportModal() {
  const data = JSON.stringify({ collections: STATE.collections, envs: STATE.envs }, null, 2);
  const m = openModal(`
    <div class="modal">
      <div class="modal-head"><h2>Export workspace</h2><span class="modal-sub">copy or download</span></div>
      <div class="modal-body" style="padding:0"><pre class="codegen-pre">${escapeHtml(data)}</pre></div>
      <div class="modal-foot">
        <button class="btn-ghost" data-cancel>Close</button>
        <button class="btn-primary" id="exp-dl">Download .json</button>
      </div>
    </div>`);
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#exp-dl').addEventListener('click', () => {
    const blob = new Blob([data], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'postpigeon-export.json'; a.click();
  });
}

function openShortcuts() {
  openModal(`
    <div class="modal">
      <div class="modal-head"><h2>Keyboard shortcuts</h2></div>
      <div class="modal-body">
        <table class="kv-table">
          <tr><td class="kv-table-key">⌘ ↵</td><td>Send request</td></tr>
          <tr><td class="kv-table-key">⌘ S</td><td>Save request to collection</td></tr>
          <tr><td class="kv-table-key">⌘ T</td><td>New tab</td></tr>
          <tr><td class="kv-table-key">⌘ W</td><td>Close tab</td></tr>
          <tr><td class="kv-table-key">/</td><td>Focus sidebar search</td></tr>
          <tr><td class="kv-table-key">Esc</td><td>Close modal</td></tr>
        </table>
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-cancel>Close</button></div>
    </div>
  `).querySelector('[data-cancel]').addEventListener('click', closeModal);
}

/* ---------------- Toasts ---------------- */
let toastWrap;
function toast(msg, kind='ok') {
  if (!toastWrap) { toastWrap = document.createElement('div'); toastWrap.className='toast-wrap'; document.body.appendChild(toastWrap); }
  const t = document.createElement('div'); t.className = 'toast'; t.dataset.kind = kind; t.textContent = msg;
  toastWrap.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

/* ---------------- Topbar wiring ---------------- */
function bindTopbar() {
  $('#envButton').addEventListener('click', () => {
    if (!STATE.envs.length) return;
    const idx = STATE.envs.findIndex(e => e.id === STATE.activeEnvId);
    const next = STATE.envs[(idx+1) % STATE.envs.length];
    STATE.activeEnvId = next.id; renderEnvSwitcher(); renderEnvs(); refreshAllOverlays(); persist();
    toast('Env: ' + next.name, 'ok');
  });
  document.querySelector('[data-action="open-vars"]').addEventListener('click', openVarsInspector);
  document.querySelector('[data-action="import"]').addEventListener('click', openImportModal);
  document.querySelector('[data-action="export"]').addEventListener('click', openExportModal);
  document.querySelector('[data-action="docs"]').addEventListener('click', openShortcuts);
  document.querySelector('[data-action="shortcuts"]').addEventListener('click', openShortcuts);
  document.querySelector('[data-action="new-collection"]').addEventListener('click', () => {
    const name = prompt('Collection name?'); if (!name) return;
    STATE.collections.push({ id: uid(), name, open: true, requests: [] });
    persist(); renderCollections();
  });
  document.querySelector('[data-action="clear-history"]').addEventListener('click', () => {
    if (!confirm('Clear all history?')) return;
    STATE.history = []; persist(); renderHistory();
  });
  document.querySelector('[data-action="new-env"]').addEventListener('click', () => {
    const name = prompt('Environment name?'); if (!name) return;
    STATE.envs.push({ id: uid(), name, vars: [] });
    persist(); renderEnvs();
  });

  // Global hotkeys
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault(); $('#sideSearch').focus();
    }
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 't') { e.preventDefault(); openRequestInTab(newRequest()); }
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'w') { e.preventDefault(); if (STATE.activeTabId) closeTab(STATE.activeTabId); }
  });
}

/* ---------------- Server probe ---------------- */
async function probeProxy() {
  const el = $('#serverStatus'); const txt = $('#serverStatusText');
  try {
    // Probe with an empty body. A live, authenticated proxy.php returns
    // 400 {error:"Missing url"} — that's a positive signal.
    const r = await ppFetch('proxy.php', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}',
    });
    let alive = false;
    try {
      const j = await r.json();
      alive = (r.status === 400 && j && j.error) || (r.ok && j && (j.status !== undefined || j.error !== undefined));
    } catch {}
    if (alive) {
      STATE.serverProxy = 'ok'; el.dataset.state = 'ok'; txt.textContent = 'proxy · ok'; return;
    }
    throw new Error('proxy did not respond as expected');
  } catch {
    STATE.serverProxy = 'fallback'; el.dataset.state = 'warn'; txt.textContent = 'proxy offline · direct fetch (CORS)';
  }
}

/* ---------------- Helpers ---------------- */
function escapeHtml(s) { return String(s ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function utf8Btoa(s) {
  // btoa() throws on multi-byte chars. Encode to UTF-8 first.
  try { return btoa(unescape(encodeURIComponent(String(s)))); }
  catch { return btoa(String(s).replace(/[^\x00-\xff]/g, '?')); }
}
function timeAgo(ts) {
  const d = (Date.now()-ts)/1000;
  if (d < 60) return Math.floor(d)+'s';
  if (d < 3600) return Math.floor(d/60)+'m';
  if (d < 86400) return Math.floor(d/3600)+'h';
  return Math.floor(d/86400)+'d';
}
function statusText(s) {
  return ({200:'OK',201:'Created',204:'No Content',301:'Moved',302:'Found',304:'Not Modified',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',409:'Conflict',422:'Unprocessable',429:'Too Many',500:'Server Error',502:'Bad Gateway',503:'Unavailable'})[s] || '';
}

/* ---------------- Account pill / sign out ---------------- */
function renderAccountPill() {
  const pill = $('#accountPill');
  const name = $('#accountName');
  const avatar = $('#accountAvatar');
  const meta = $('#accountMenuEmail');
  const adminBtn = $('#adminMenuBtn');
  const u = STATE.user;
  if (!u) { pill.hidden = true; return; }
  pill.hidden = false;
  name.textContent = u.username || u.email || 'account';
  avatar.textContent = (u.username || u.email || '?').slice(0,1);
  meta.textContent = u.email || u.username || '';
  pill.dataset.admin = u.is_admin ? 'true' : 'false';
  adminBtn.hidden = !u.is_admin;
}
function bindAccountPill() {
  const wrap = $('#accountWrap');
  const pill = $('#accountPill');
  const menu = $('#accountMenu');
  if (!wrap || !pill || !menu) return;
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    pill.setAttribute('aria-expanded', String(opening));
  });
  // Close on outside click (but never close while interacting with the menu itself).
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      menu.hidden = true;
      pill.setAttribute('aria-expanded', 'false');
    }
  });
  menu.querySelector('[data-action="logout"]').addEventListener('click', signOut);
  menu.querySelector('[data-action="change-password"]').addEventListener('click', () => {
    menu.hidden = true; openChangePasswordModal();
  });
  menu.querySelector('[data-action="open-admin"]').addEventListener('click', () => {
    menu.hidden = true; openAdminModal();
  });
}
async function signOut() {
  try {
    await ppFetch('auth.php?action=logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  } catch {}
  // Clear cached workspace + tabs so the next user on this machine doesn't see leftover data.
  try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_TABS_KEY); } catch {}
  location.replace('login.html?reason=logout');
}

function openChangePasswordModal(forced = false) {
  const m = openModal(`
    <div class="modal">
      <div class="modal-head">
        <h2>Change password</h2>
        <span class="modal-sub">${forced ? 'required by admin' : ''}</span>
      </div>
      <div class="modal-body">
        ${forced ? '<p class="muted" style="margin-top:0;font:500 12px var(--mono)">Your admin set a temporary password. Please pick a new one before continuing.</p>' : ''}
        <label class="field"><span class="field-label">Current password</span><input id="cp-cur" type="password" autocomplete="current-password"></label>
        <label class="field"><span class="field-label">New password</span><input id="cp-new" type="password" autocomplete="new-password"></label>
        <label class="field"><span class="field-label">Confirm new password</span><input id="cp-cnf" type="password" autocomplete="new-password"></label>
        <div class="auth-flash auth-flash--err" id="cp-err" hidden></div>
      </div>
      <div class="modal-foot">
        ${forced ? '' : '<button class="btn-ghost" data-cancel>Cancel</button>'}
        <button class="btn-primary" id="cp-go">Save</button>
      </div>
    </div>`);
  if (!forced) m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  const err = m.querySelector('#cp-err');
  m.querySelector('#cp-go').addEventListener('click', async () => {
    err.hidden = true;
    const cur = m.querySelector('#cp-cur').value;
    const next = m.querySelector('#cp-new').value;
    const cnf = m.querySelector('#cp-cnf').value;
    if (!cur || !next) { err.textContent = 'Please fill in every field.'; err.hidden = false; return; }
    if (next !== cnf)  { err.textContent = 'New passwords do not match.';  err.hidden = false; return; }
    try {
      const r = await ppFetch('auth.php?action=change_password', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ current: cur, password: next, confirm: cnf }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        err.textContent = j.error || 'Could not change password.';
        err.hidden = false;
        return;
      }
      if (STATE.user) STATE.user.must_change_password = false;
      closeModal();
      toast('Password changed', 'ok');
    } catch (e) {
      err.textContent = 'Network error.';
      err.hidden = false;
    }
  });
}

/* ---------------- Admin panel ---------------- */
let _adminLastTemp = null;
async function openAdminModal() {
  if (!STATE.user || !STATE.user.is_admin) return;
  const m = openModal(`
    <div class="modal admin-modal">
      <div class="modal-head"><h2>Users</h2><span class="modal-sub">admin · invite-only</span></div>
      <div class="modal-body">
        <div id="adm-banner"></div>
        <form class="admin-create-form" id="adm-create" autocomplete="off">
          <label class="field"><span class="field-label">Email</span><input name="email" type="email" required></label>
          <label class="field"><span class="field-label">Username</span><input name="username" type="text" required pattern="[A-Za-z0-9_.\\-]{3,64}"></label>
          <label class="field"><span class="field-label">Password (optional)</span><input name="password" type="text" placeholder="leave blank to auto-generate"></label>
          <label class="field-row"><input name="is_admin" type="checkbox"> grant admin</label>
          <button type="submit">Create user</button>
        </form>
        <table class="admin-table">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Created</th><th>Last login</th><th></th></tr></thead>
          <tbody id="adm-rows"><tr><td colspan="6" class="muted" style="padding:14px">Loading…</td></tr></tbody>
        </table>
      </div>
      <div class="modal-foot"><button class="btn-ghost" data-cancel>Close</button></div>
    </div>`);
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#adm-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const body = {
      email: f.email.value.trim(),
      username: f.username.value.trim(),
      password: f.password.value,
      is_admin: f.is_admin.checked,
    };
    if (!body.password) delete body.password;
    try {
      const r = await ppFetch('admin.php?action=create', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || 'Could not create user', 'err'); return; }
      f.reset();
      _adminLastTemp = j.temp_password ? { user: j.user, password: j.temp_password } : null;
      drawAdminBanner();
      drawAdminRows();
      toast('User created', 'ok');
    } catch (ex) {
      toast('Network error', 'err');
    }
  });
  drawAdminRows();
  drawAdminBanner();
}

function drawAdminBanner() {
  const banner = document.querySelector('#adm-banner');
  if (!banner) return;
  banner.innerHTML = '';
  if (_adminLastTemp) {
    const { user, password } = _adminLastTemp;
    const div = document.createElement('div');
    div.className = 'temp-password-banner';
    div.innerHTML = `Temporary password for <strong>${escapeHtml(user.username)}</strong>: <code id="adm-temp">${escapeHtml(password)}</code>
      <button type="button">Copy</button>`;
    div.querySelector('button').addEventListener('click', () => {
      navigator.clipboard.writeText(password);
      toast('Copied — share securely', 'ok');
    });
    banner.appendChild(div);
  }
}

async function drawAdminRows() {
  const tbody = document.querySelector('#adm-rows');
  if (!tbody) return;
  try {
    const r = await ppFetch('admin.php?action=list');
    const j = await r.json();
    if (!r.ok) { tbody.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(j.error || 'load failed')}</td></tr>`; return; }
    tbody.innerHTML = '';
    for (const u of j.users) {
      const tr = document.createElement('tr');
      const me = STATE.user && STATE.user.id === u.id;
      tr.innerHTML = `
        <td><strong>${escapeHtml(u.username)}</strong><br><span class="muted" style="font-size:11px">${escapeHtml(u.email)}</span></td>
        <td><span class="admin-pill" data-on="${u.is_admin?'true':'false'}">${u.is_admin?'admin':'user'}</span></td>
        <td><span class="admin-pill" data-on="${u.is_active?'true':'false'}">${u.is_active?'active':'disabled'}</span></td>
        <td>${escapeHtml((u.created_at||'').slice(0,10))}</td>
        <td>${escapeHtml((u.last_login_at||'').slice(0,16) || '—')}</td>
        <td class="admin-actions">
          <button class="ghost-btn" data-act="reset">reset pw</button>
          ${me ? '' : `<button class="ghost-btn" data-act="${u.is_admin?'demote':'promote'}">${u.is_admin?'demote':'promote'}</button>`}
          ${me ? '' : `<button class="ghost-btn" data-act="${u.is_active?'disable':'enable'}">${u.is_active?'disable':'enable'}</button>`}
          ${me ? '' : `<button class="ghost-btn" data-act="delete" data-danger="true">delete</button>`}
        </td>`;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => adminRowAction(u, b.dataset.act)));
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Network error.</td></tr>`;
  }
}

async function adminRowAction(u, act) {
  let url = '', body = {};
  if (act === 'reset') {
    if (!confirm(`Reset password for ${u.username}? They will be forced to change it on next login.`)) return;
    url = 'admin.php?action=reset_password'; body = { id: u.id };
  } else if (act === 'promote' || act === 'demote') {
    url = 'admin.php?action=set_admin'; body = { id: u.id, is_admin: act === 'promote' };
  } else if (act === 'enable' || act === 'disable') {
    url = 'admin.php?action=set_active'; body = { id: u.id, is_active: act === 'enable' };
  } else if (act === 'delete') {
    if (!confirm(`Permanently delete ${u.username} and all their data? This cannot be undone.`)) return;
    url = 'admin.php?action=delete'; body = { id: u.id };
  } else { return; }
  try {
    const r = await ppFetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || 'Action failed', 'err'); return; }
    if (act === 'reset' && j.temp_password) {
      _adminLastTemp = { user: u, password: j.temp_password };
      drawAdminBanner();
    }
    drawAdminRows();
    toast('Done', 'ok');
  } catch (e) {
    toast('Network error', 'err');
  }
}

/* ---------------- Boot ---------------- */
(async function init() {
  // Auth: get the current user. If we're somehow on this page without a
  // session, ppFetch will redirect to login.html, but server-side index.php
  // should have already done that.
  STATE.user = await fetchCurrentUser();
  if (!STATE.user) { location.replace('login.html'); return; }

  await hydrate();
  renderAccountPill();
  bindAccountPill();
  renderSidebar();
  bindTopbar();
  // Await the probe so the very first Send picks the right path
  // (proxy vs. direct fetch fallback) instead of racing the network.
  await probeProxy();

  // Force the password-change modal if the admin set a temp password.
  if (STATE.user.must_change_password) {
    openChangePasswordModal(/* forced */ true);
  }

  // Restore tabs from the previous session if we have any. Otherwise open a
  // seed request so the workspace doesn't boot blank.
  const restored = loadTabsLocal();
  if (restored) {
    STATE.tabs = restored.tabs.map(t => ({
      id: t.id, name: t.name, dirty: !!t.dirty,
      request: normalizeRequest(t.request),
    }));
    STATE.activeTabId = STATE.tabs.find(t => t.id === restored.activeTabId)?.id || STATE.tabs[0].id;
    renderTabs(); renderActivePanel();
  } else {
    const seedReq = STATE.collections[0]?.requests[0] || newRequest({ method:'GET', url:'https://httpbin.org/get?hello={{baseUrl}}' });
    openRequestInTab(seedReq);
  }
})();
