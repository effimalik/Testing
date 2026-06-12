/* ═══════════════════════════════════════════════════════════════════════
   dataLayer.js — AdminPro UAE  v3.1
   Cache-first data layer · IndexedDB · session-auth
   + Browser fingerprint guard  (new)
   + Server-side AuditLog on every fetch  (new)

   CHANGES FROM v3.0:
   ─ _verifyFingerprint()  — checked before EVERY network fetch and on
     every tab visibility restore. Mismatch → audit POST → wipe → redirect.
   ─ _auditLog()           — fire-and-forget POST to Apps Script type=auditLog
     after every successful fetch, denied access, fingerprint mismatch, signout.
   ─ Auto-init now runs fingerprint check BEFORE building DATASETS.
   ─ Visibility watcher now re-checks fingerprint on tab restore.

   LOAD ORDER (fingerprint.js is new — must be first):
     1. fingerprint.js   ← NEW: window.Fingerprint.get() / .matches()
     2. auth.js
     3. dataLayer.js     ← this file
     4. page JS

   SESSION STORAGE KEYS:
     ap_session  → { sessionId, token, email, sessionFingerprint, ... }
     ap_config   → { dataConfig: [...], permissions: { key: { granted, ttlMs } } }

   FINGERPRINT SIGNALS (userAgent + timezone + language):
     • Stable across: tab reload, window resize, zoom, dark mode
     • Changes on:    different browser, OS, machine, or user account
═══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {

  /* ─────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────── */
  // https://script.google.com/macros/s/AKfycbx9O_58jlTsohkp8bNYA1rO2EQm9M9FeXoe1FT3E0n8yJ91jseidhKiM0Ss7meNkl7Elg/exec
   const API_BASE     = 'https://script.google.com/macros/s/AKfycbzRCgS_JPir4uPmwW89vmYnG982G33u5CNWJZlVmghI31jhpLUECIYf9oVDaTQY8GtyQA/exec';
  const CACHE_PREFIX = 'ap2_';

  /* ─────────────────────────────────────────
     AUDIT LOG
     Fire-and-forget POST to Apps Script type=auditLog.
     Never blocks. Never throws to caller.
     Uses sendBeacon when available so it survives page unload (logout events).

     Events fired:
       fetch_success        — data fetched and cached successfully
       access_denied        — dataset requested but not in permitted list
       fingerprint_mismatch — live browser fp ≠ stored session fp
       signout              — user signed out (manual or forced)
  ───────────────────────────────────────── */
  async function _auditLog({ event, dataset = '', note = '', storedFp = null, liveFp = null }) {
    try {
      const raw     = sessionStorage.getItem('ap_session');
      const session = raw ? JSON.parse(raw) : {};
      const fp      = liveFp
        || (window.Fingerprint ? await window.Fingerprint.get().catch(() => '') : '');

      const payload = JSON.stringify({
        sessionId  : session.sessionId  || '',
        token      : session.token      || '',
        email      : session.email      || '',
        event,
        dataset,
        fingerprint: fp,
        storedFp   : storedFp || session.sessionFingerprint || '',
        userAgent  : navigator.userAgent || '',
        note,
      });

      const url = `${API_BASE}?type=auditLog`;

      // sendBeacon: guaranteed delivery even across page navigations
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(url, {
          method   : 'POST',
          headers  : { 'Content-Type': 'application/json' },
          body     : payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch (e) {
      // Audit failure must NEVER break the app
      console.warn('[DataLayer] _auditLog fire failed:', e.message);
    }
  }

  /* ─────────────────────────────────────────
     FINGERPRINT GUARD
     Reads sessionFingerprint from ap_session (set at login by auth.js).
     Compares against the live fingerprint from window.Fingerprint.
     On mismatch:
       1. Fire audit event (non-blocking, uses sendBeacon)
       2. Wipe all client-side storage
       3. Hard redirect to login.html
     Returns true (ok) or false (mismatch — redirect already fired).
  ───────────────────────────────────────── */
  async function _verifyFingerprint() {
    try {
      const raw = sessionStorage.getItem('ap_session');
      if (!raw) return true;   // no session yet — auth.js will handle
      const session = JSON.parse(raw);
      const stored  = session.sessionFingerprint || null;
      if (!stored)  return true;   // fingerprint not stored at login — skip

      if (!window.Fingerprint || typeof window.Fingerprint.matches !== 'function') {
        console.warn('[DataLayer] fingerprint.js not loaded — skipping check');
        return true;
      }

      const ok = await window.Fingerprint.matches(stored);
      if (ok) return true;

      // ── MISMATCH ─────────────────────────────────────────────────────
      console.error('[DataLayer] 🚨 Fingerprint mismatch — possible session replay. Forcing re-login.');

      // 1. Log to AuditLog sheet (sendBeacon — fires even during redirect)
      const liveFp = await window.Fingerprint.get().catch(() => 'error');
      _auditLog({
        event  : 'fingerprint_mismatch',
        dataset: '',
        note   : 'Browser fingerprint changed mid-session',
        storedFp: stored,
        liveFp,
      });

      // 2. Wipe all client storage
      await _clearAllStorageOnLogout();

      // 3. Redirect to login
      const base     = window.location.pathname.replace(/\/[^/]*$/, '/');
      const loginUrl = base + 'login.html';
      window.location.replace(loginUrl);
      return false;

    } catch (e) {
      console.warn('[DataLayer] _verifyFingerprint error:', e.message);
      return true;   // unexpected error — don't block; server will validate session
    }
  }

  /* ─────────────────────────────────────────
     CONFIG READER
  ───────────────────────────────────────── */
  function _readLoginConfig() {
    try {
      const raw = sessionStorage.getItem('ap_config');
      if (!raw) return null;
      const cfg = JSON.parse(raw);
      if (!cfg || !Array.isArray(cfg.dataConfig) || typeof cfg.permissions !== 'object') return null;
      return cfg;
    } catch (e) {
      console.warn('[DataLayer] _readLoginConfig error:', e.message);
      return null;
    }
  }

  /* ─────────────────────────────────────────
     BLOCKING CONFIG GATE
     Shows overlay until ap_config lands in sessionStorage.
  ───────────────────────────────────────── */
  function _waitForConfig(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const cfg = _readLoginConfig();
      if (cfg) { resolve(cfg); return; }

      _showConfigOverlay(true);
      const deadline = Date.now() + timeoutMs;

      const interval = setInterval(() => {
        const c = _readLoginConfig();
        if (c) { clearInterval(interval); _showConfigOverlay(false); resolve(c); return; }
        if (Date.now() > deadline) {
          clearInterval(interval);
          _showConfigOverlay(false);
          reject(new Error('[DataLayer] Timed out waiting for config.'));
        }
      }, 150);
    });
  }

  function _showConfigOverlay(show) {
    const ID = '_ap2_config_overlay';
    if (!show) { const el = document.getElementById(ID); if (el) el.remove(); return; }
    if (document.getElementById(ID)) return;

    const el = document.createElement('div');
    el.id = ID;
    Object.assign(el.style, {
      position: 'fixed', inset: '0', background: 'rgba(255,255,255,0.88)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '999999', fontFamily: 'sans-serif', fontSize: '15px', color: '#444',
    });
    el.innerHTML = `
      <div style="text-align:center">
        <div style="width:36px;height:36px;border:3px solid #ddd;border-top-color:#2d7aee;
          border-radius:50%;animation:_ap2spin .8s linear infinite;margin:0 auto 12px"></div>
        <div>Verifying session…</div>
      </div>
      <style>@keyframes _ap2spin{to{transform:rotate(360deg)}}</style>`;

    if (document.body) document.body.appendChild(el);
    else document.addEventListener('DOMContentLoaded',
      () => { if (!document.getElementById(ID)) document.body.appendChild(el); }, { once: true });
  }

  /* ─────────────────────────────────────────
     DATASET REGISTRY
     Zero hardcoding — built from login payload.
  ───────────────────────────────────────── */
  let DATASETS     = {};
  let _configReady = false;

  function _buildDatasets(cfg) {
    const loginCfg = cfg || _readLoginConfig();
    if (!loginCfg) {
      console.warn('[DataLayer] _buildDatasets: no config — fail-closed');
      DATASETS = {};
      return DATASETS;
    }

    const { dataConfig, permissions } = loginCfg;
    const result = {};

    for (const row of dataConfig) {
      const dsKey   = (row.dataset  || '').trim();
      const permKey = (row.permKey  || '').trim();
      if (!dsKey || !permKey) continue;

      const perm = permissions[dsKey];
      if (!perm || perm.granted !== true) continue;   // SECURITY gate

      result[dsKey] = {
        label   : (row.label     || dsKey).trim(),
        apiType : (row.apiKey    || dsKey).trim(),
        paramKey: (row.paramType || 'type').trim(),
        ttlMs   : (perm.ttlMs && perm.ttlMs > 0) ? perm.ttlMs : 5 * 60 * 1000,
        permKey,
      };
    }

    DATASETS     = result;
    _configReady = true;
    console.log('[DataLayer] DATASETS built:', Object.keys(DATASETS));
    return DATASETS;
  }

  /* ─────────────────────────────────────────
     LOGOUT CLEANUP
  ───────────────────────────────────────── */
  async function _clearAllStorageOnLogout() {
    try {
      const db = await _openDB();
      await new Promise((res, rej) => {
        const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
        req.onsuccess = () => res(); req.onerror = () => rej(req.error);
      });
      _shadow.clear();
    } catch (e) { console.warn('[DataLayer] IDB clear failed:', e.message); }

    try { sessionStorage.clear(); } catch (_) {}

    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(CACHE_PREFIX) || k.startsWith('ap_') || k.startsWith('ap2_'))
        .forEach(k => localStorage.removeItem(k));
    } catch (_) {}

    console.log('[DataLayer] All storage cleared');
  }

  window.addEventListener('ap:signout', async () => {
    _auditLog({ event: 'signout', note: 'User signed out' }).catch(() => {});
    DATASETS     = {};
    _configReady = false;
    Object.keys(_timers).forEach(k => { clearTimeout(_timers[k]); delete _timers[k]; });
    await _clearAllStorageOnLogout();
  });

  /* ─────────────────────────────────────────
     PERMISSION NOTIFICATION
  ───────────────────────────────────────── */
  function _notifyNotAuthorized(dsKey) {
    let label = dsKey;
    try {
      const cfg = _readLoginConfig();
      if (cfg) { const r = cfg.dataConfig.find(x => x.dataset === dsKey); if (r) label = r.label || dsKey; }
    } catch (_) {}

    const msg = `⛔ Not authorized to access: ${label}`;
    console.warn('[DataLayer]', msg);

    if (window.AdminPro?.showToast) window.AdminPro.showToast(msg, 'error');
    else if (typeof window.showNotification === 'function') window.showNotification(msg, 'error');
    else {
      const prev = document.getElementById('_ap2_auth_banner');
      if (prev) prev.remove();
      const b = document.createElement('div');
      b.id = '_ap2_auth_banner';
      Object.assign(b.style, {
        position:'fixed', top:'16px', left:'50%', transform:'translateX(-50%)',
        background:'#c0392b', color:'#fff', padding:'10px 22px', borderRadius:'6px',
        fontFamily:'sans-serif', fontSize:'14px', zIndex:'99999',
        boxShadow:'0 3px 10px rgba(0,0,0,.35)', whiteSpace:'nowrap',
      });
      b.textContent = msg;
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 4000);
    }
  }

  /* ─────────────────────────────────────────
     DATA NORMALISER
  ───────────────────────────────────────── */
  function _normaliseRows(raw) {
    const arr = Array.isArray(raw) ? raw
      : (raw && Array.isArray(raw.data)) ? raw.data : raw;
    if (!Array.isArray(arr)) return arr;
    return arr.map(r => Array.isArray(r) ? r : (r && typeof r === 'object') ? Object.values(r) : [r]);
  }

  /* ─────────────────────────────────────────
     INDEXEDDB ENGINE
  ───────────────────────────────────────── */
  const IDB_NAME  = 'ap2_fleet_cache';
  const IDB_VER   = 2;
  const IDB_STORE = 'datasets';
  let _dbPromise  = null;

  function _openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (db.objectStoreNames.contains(IDB_STORE)) db.deleteObjectStore(IDB_STORE);
        db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
    return _dbPromise;
  }

  async function _idbGet(fullKey) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(fullKey);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbSet(fullKey, value) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(
        { ts: value.ts, data: value.data, fingerprint: value.fingerprint || null }, fullKey);
      req.onsuccess = () => res(true);
      req.onerror   = () => rej(req.error);
      tx.onerror    = () => rej(tx.error);
    });
  }

  async function _idbDelete(fullKey) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(fullKey);
      req.onsuccess = () => res(true);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ─────────────────────────────────────────
     IN-MEMORY SHADOW
  ───────────────────────────────────────── */
  const _shadow = new Map();

  _openDB().then(async db => {
    const [keys, records] = await Promise.all([
      new Promise((res, rej) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
        r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
      }),
      new Promise((res, rej) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
        r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
      }),
    ]);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], rec = records[i];
      if (typeof k === 'string' && k.startsWith(CACHE_PREFIX) && rec)
        _shadow.set(k, { ts: rec.ts, data: rec.data, fingerprint: rec.fingerprint || null });
    }
    console.log('[DataLayer] IDB shadow loaded —', _shadow.size, 'entries');
  }).catch(e => console.warn('[DataLayer] IDB shadow load failed:', e.message));

  /* ─────────────────────────────────────────
     CACHE PURGE
  ───────────────────────────────────────── */
  function _purgeUnauthorisedCache() {
    try {
      let fp = null;
      try { const r = sessionStorage.getItem('ap_session'); if (r) fp = JSON.parse(r).sessionFingerprint || null; } catch {}

      const permitted = new Set(Object.keys(DATASETS).map(k => CACHE_PREFIX + k));
      const toDelete  = [];

      for (const [fullKey, entry] of _shadow.entries()) {
        if (!fullKey.startsWith(CACHE_PREFIX)) continue;
        if (!permitted.has(fullKey))           { toDelete.push(fullKey); continue; }
        if (fp && entry.fingerprint && entry.fingerprint !== fp) toDelete.push(fullKey);
      }

      if (toDelete.length) {
        toDelete.forEach(k => { _shadow.delete(k); _idbDelete(k).catch(() => {}); });
        console.log('[DataLayer] purged', toDelete.length, 'unauthorised entries');
      }
    } catch (e) { console.warn('[DataLayer] _purgeUnauthorisedCache error:', e.message); }
  }

  /* ─────────────────────────────────────────
     CACHE OBJECT
  ───────────────────────────────────────── */
  const _cache = {
    _key(n) { return CACHE_PREFIX + n; },
    get(n)  { return _shadow.get(this._key(n)) || null; },

    set(n, data) {
      let fp = null;
      try { const r = sessionStorage.getItem('ap_session'); if (r) fp = JSON.parse(r).sessionFingerprint || null; } catch {}
      const entry = { ts: Date.now(), data, fingerprint: fp };
      const k     = this._key(n);
      _shadow.set(k, entry);
      _idbSet(k, entry)
        .then(() => console.log('[DataLayer] IDB OK:', k, '| rows:', Array.isArray(data) ? data.length : typeof data))
        .catch(e  => console.error('[DataLayer] IDB FAIL:', k, e));
      return true;
    },

    clear(n) { const k = this._key(n); _shadow.delete(k); _idbDelete(k).catch(() => {}); },

    clearAll() {
      Array.from(_shadow.keys()).filter(k => k.startsWith(CACHE_PREFIX))
        .forEach(k => { _shadow.delete(k); _idbDelete(k).catch(() => {}); });
    },

    status(n) {
      const entry = this.get(n);
      if (!entry || entry.data == null) return null;
      const ds = DATASETS[n]; if (!ds) return null;
      return (Date.now() - entry.ts) < ds.ttlMs ? 'fresh' : 'stale';
    },

    age(n) { const e = this.get(n); return e ? Date.now() - e.ts : Infinity; },
  };

  /* ─────────────────────────────────────────
     IN-FLIGHT DEDUP
  ───────────────────────────────────────── */
  const _inflight = {};

  /* ─────────────────────────────────────────
     CORE FETCH
     Security sequence per call:
       1. Verify fingerprint  (mismatch → audit + wipe + redirect)
       2. Rebuild DATASETS    (catches permission revocations live)
       3. Gate on dataset     (not permitted → audit + notify + throw)
       4. Gate on credentials (no session → throw)
       5. HTTP fetch
       6. Audit log on success (fire-and-forget)
  ───────────────────────────────────────── */
  async function _fetchFromServer(dsKey) {
    if (_inflight[dsKey]) {
      console.log(`[DataLayer] ${dsKey}: joining in-flight request`);
      return _inflight[dsKey];
    }

    const promise = (async () => {

      // 1. Fingerprint
      const fpOk = await _verifyFingerprint();
      if (!fpOk) throw new Error('[DataLayer] Fingerprint mismatch — session invalidated');

      // 2. Permissions
      _buildDatasets();
      const ds = DATASETS[dsKey];
      if (!ds) {
        _auditLog({ event: 'access_denied', dataset: dsKey, note: 'Dataset not in permitted list' });
        _notifyNotAuthorized(dsKey);
        throw new Error(`[DataLayer] "${dsKey}" not permitted`);
      }

      // 3. Credentials
      const creds = window.Auth?.getCredentials?.() || null;
      if (!creds?.sessionId || !creds?.token)
        throw new Error(`[DataLayer] ${dsKey}: no valid session`);

      // 4. Fetch
      const url = `${API_BASE}?${ds.paramKey}=${encodeURIComponent(ds.apiType)}`
        + `&sessionId=${encodeURIComponent(creds.sessionId)}`
        + `&token=${encodeURIComponent(creds.token)}`
        + `&_t=${Date.now()}`;

      console.log(`[DataLayer] ${dsKey}: → ${ds.paramKey}=${ds.apiType}`);
      const t0 = performance.now();

      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 30000);
      let res;
      try {
        res = await fetch(url, { cache: 'no-store', redirect: 'follow', mode: 'cors', signal: ctrl.signal });
      } finally { clearTimeout(tid); }

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${dsKey}`);

      const json = await res.json();
      if (json && !Array.isArray(json) && json.success === false)
        throw new Error(`[DataLayer] ${dsKey} server error: ${json.error || json.message}`);

      const data = _normaliseRows(json);
      if (!Array.isArray(data) || !data.length)
        throw new Error(`[DataLayer] ${dsKey}: empty response — not caching`);

      _cache.set(dsKey, data);
      const ms = Math.round(performance.now() - t0);
      console.log(`[DataLayer] ${dsKey}: ${data.length} rows cached (${ms}ms)`);

      // 5. Audit (non-blocking)
      _auditLog({ event: 'fetch_success', dataset: dsKey, note: `${data.length} rows in ${ms}ms` });

      return data;
    })();

    _inflight[dsKey] = promise;
    try     { return await promise; }
    finally { delete _inflight[dsKey]; }
  }

  /* ─────────────────────────────────────────
     GET — cache-first
  ───────────────────────────────────────── */
  async function _get(dsKey, force) {
    _buildDatasets();
    const ds = DATASETS[dsKey];
    if (!ds) { _notifyNotAuthorized(dsKey); throw new Error(`[DataLayer] "${dsKey}" not permitted`); }

    if (!force) {
      const entry = _cache.get(dsKey);
      if (entry?.data != null) {
        const age = Date.now() - entry.ts;
        if (age < ds.ttlMs) { console.log(`[DataLayer] ${dsKey}: HIT (${Math.round(age/1000)}s)`); return entry.data; }
        console.log(`[DataLayer] ${dsKey}: STALE — refreshing`);
      } else { console.log(`[DataLayer] ${dsKey}: MISS — fetching`); }
    } else { console.log(`[DataLayer] ${dsKey}: force refresh`); _cache.clear(dsKey); }

    return _fetchFromServer(dsKey);
  }

  /* ─────────────────────────────────────────
     WARM-IF-EMPTY
  ───────────────────────────────────────── */
  async function warmIfEmpty() {
    _buildDatasets();
    _purgeUnauthorisedCache();
    const toFetch = Object.keys(DATASETS).filter(k => _cache.status(k) !== 'fresh');
    if (!toFetch.length) { console.log('[DataLayer] warmIfEmpty: all fresh'); _startAllTimers(); return; }
    console.log('[DataLayer] warmIfEmpty fetching:', toFetch);
    await Promise.allSettled(toFetch.map(k => _fetchFromServer(k)));
    _startAllTimers();
  }

  /* ─────────────────────────────────────────
     BACKGROUND REFRESH TIMERS
  ───────────────────────────────────────── */
  const _timers = {};

  function _scheduleRefresh(dsKey) {
    const ds = DATASETS[dsKey]; if (!ds) return;
    if (_timers[dsKey]) { clearTimeout(_timers[dsKey]); delete _timers[dsKey]; }
    const entry = _cache.get(dsKey); if (!entry) return;
    const delay = Math.max(0, ds.ttlMs - (Date.now() - entry.ts) - 30000);

    _timers[dsKey] = setTimeout(async () => {
      if (document.visibilityState === 'hidden') { _scheduleRefresh(dsKey); return; }
      try { await _fetchFromServer(dsKey); _scheduleRefresh(dsKey); }
      catch (e) {
        console.warn(`[DataLayer] bg refresh failed: ${dsKey}`, e.message);
        _timers[dsKey] = setTimeout(() => _scheduleRefresh(dsKey), 2 * 60 * 1000);
      }
    }, delay);

    console.log(`[DataLayer] ${dsKey}: next refresh in ${Math.round(delay/1000)}s (TTL ${Math.round(ds.ttlMs/60000)}min)`);
  }

  function _startAllTimers() { Object.keys(DATASETS).forEach(_scheduleRefresh); }

  /* ─────────────────────────────────────────
     PUBLIC API — window.AdminPro
  ───────────────────────────────────────── */
  window.AdminPro = {

    VERSION: '3.1',

    init(cfg) {
      _buildDatasets(cfg);
      _purgeUnauthorisedCache();
      _startAllTimers();
      console.log('[DataLayer] init:', Object.keys(DATASETS).length, 'datasets');
    },

    warmIfEmpty,

    async streamQuery(dsKey, predicateFn) {
      _buildDatasets();
      const ds = DATASETS[dsKey];
      if (!ds) { _notifyNotAuthorized(dsKey); throw new Error(`[DataLayer] "${dsKey}" not permitted`); }
      const fullKey = CACHE_PREFIX + dsKey;
      try {
        const db = await _openDB();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(fullKey);
          req.onsuccess = () => {
            const rec = req.result;
            if (!rec || !Array.isArray(rec.data)) { resolve([]); return; }
            const out = [];
            for (let i = 0; i < rec.data.length; i++)
              try { if (predicateFn(rec.data[i])) out.push(rec.data[i]); } catch (_) {}
            resolve(out);
          };
          req.onerror = () => reject(req.error);
        });
      } catch (e) {
        const entry = _cache.get(dsKey);
        if (!entry || !Array.isArray(entry.data)) return [];
        return entry.data.filter(r => { try { return predicateFn(r); } catch (_) { return false; } });
      }
    },

    // Named getters — backwards compat
    getEmployees     (f) { return _get('employee',      f); },
    getBikes         (f) { return _get('bike',          f); },
    getMasterSheet   (f) { return _get('master',        f); },
    getCioLog        (f) { return _get('cioLog',        f); },
    getApprovedSheet (f) { return _get('approvedSheet', f); },
    getRecovery      (f) { return _get('recovery',      f); },
    get(dsKey, force)    { return _get(dsKey, force); },

    async forceRefresh(dsKey) {
      if (dsKey) {
        if (!DATASETS[dsKey]) { console.warn(`[DataLayer] forceRefresh: "${dsKey}" not permitted`); return; }
        const d = await _get(dsKey, true); _scheduleRefresh(dsKey); return d;
      }
      await Promise.allSettled(Object.keys(DATASETS).map(k => _get(k, true)));
      _startAllTimers();
    },

    async warmCache() { await this.forceRefresh(); },

    cache: {
      get    : n    => _cache.get(n),
      set    : (n,d)=> _cache.set(n,d),
      clear  : n    => _cache.clear(n),
      clearAll: ()  => _cache.clearAll(),
      status : n    => _cache.status(n),
      age    : n    => _cache.age(n),
    },

    getCacheStatus() {
      return Object.entries(DATASETS).map(([key, ds]) => {
        const entry = _cache.get(key);
        const ageMs = entry ? Date.now() - entry.ts : Infinity;
        const hasData = entry?.data != null
          ? (Array.isArray(entry.data) ? entry.data.length > 0 : true) : false;
        const fresh = hasData && ageMs < ds.ttlMs;
        const ageLabel = ageMs === Infinity ? 'Not loaded'
          : ageMs < 60000   ? Math.floor(ageMs/1000)    + 's ago'
          : ageMs < 3600000 ? Math.floor(ageMs/60000)   + 'm ago'
          :                   Math.floor(ageMs/3600000) + 'h ago';
        let lastSync = null;
        if (ageMs !== Infinity) {
          const d = new Date(Date.now() - ageMs);
          lastSync = d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
            + ', ' + d.toLocaleDateString([],{day:'2-digit',month:'short'});
        }
        return { key, label:ds.label, ageMs, ageLabel, fresh, hasData, lastSync,
          ttl:ds.ttlMs, ttlMinutes:Math.round(ds.ttlMs/60000),
          rowCount: entry && Array.isArray(entry.data) ? entry.data.length : null,
          remaining: ageMs === Infinity ? 0 : Math.max(0, ds.ttlMs - ageMs),
          inFlight: !!_inflight[key] };
      });
    },

    getActiveDatasets() { return { ...DATASETS }; },
    getDatasetNames()   { return Object.keys(DATASETS); },
    getDatasetMeta()    {
      return Object.entries(DATASETS).map(([key, ds]) => ({
        key, label:ds.label, apiType:ds.apiType, paramKey:ds.paramKey,
        ttlMs:ds.ttlMs, ttlMinutes:Math.round(ds.ttlMs/60000), permKey:ds.permKey,
      }));
    },

    stopAllTimers() {
      Object.keys(_timers).forEach(k => { clearTimeout(_timers[k]); delete _timers[k]; });
    },

    async signOut() {
      _auditLog({ event: 'signout', note: 'Manual sign-out' });
      this.stopAllTimers();
      DATASETS = {}; _configReady = false;
      await _clearAllStorageOnLogout();
      console.log('[DataLayer] signed out — all storage cleared');
    },

    clearAllStorage: _clearAllStorageOnLogout,
    isConfigReady()  { return _configReady; },

    // Expose for auth.js to fire login/logout audit events directly
    auditLog: _auditLog,
  };

  window.DataLayer = window.AdminPro;

  /* ─────────────────────────────────────────
     AUTO-INIT — protected pages only
     Order: wait for config → verify fingerprint → build → purge → warm
  ───────────────────────────────────────── */
  (function _autoInit() {
    const isLogin = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');
    if (isLogin) return;

    async function _initAndWarm() {
      try {
        const cfg = await _waitForConfig(100000);

        // Fingerprint must pass BEFORE we build datasets or touch the network
        const fpOk = await _verifyFingerprint();
        if (!fpOk) return;   // redirect already fired inside _verifyFingerprint

        _buildDatasets(cfg);
        _purgeUnauthorisedCache();
        _startAllTimers();
        warmIfEmpty().catch(e => console.warn('[DataLayer] warmIfEmpty error:', e.message));
      } catch (err) {
        console.error('[DataLayer] autoInit failed:', err.message);
        window.dispatchEvent(new CustomEvent('ap:config_timeout'));
      }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _initAndWarm);
    else _initAndWarm();
  })();

  /* ─────────────────────────────────────────
     VISIBILITY WATCHER
     Re-checks fingerprint every time the tab becomes visible.
  ───────────────────────────────────────── */
  (function _visibilityWatcher() {
    const isLogin = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');
    if (isLogin) return;

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        // Re-verify fingerprint on every tab restore
        const fpOk = await _verifyFingerprint();
        if (!fpOk) return;
        _buildDatasets();
      } catch (e) { console.warn('[DataLayer] visibilityWatcher error:', e.message); return; }
      try {
        const stale = Object.keys(DATASETS).filter(k => _cache.status(k) !== 'fresh');
        if (stale.length) {
          console.log('[DataLayer] Tab restored — refreshing stale:', stale);
          Promise.allSettled(stale.map(k => _fetchFromServer(k))).then(() => _startAllTimers());
        }
      } catch (e) { console.warn('[DataLayer] visibilityWatcher refresh error:', e.message); }
    });
  })();

  console.log('[DataLayer] v3.1 loaded — fingerprint guard + audit log active');

})();
