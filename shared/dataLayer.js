   
/* ═══════════════════════════════════════════════════════════════
   dataLayer.js — AdminPro UAE  v2.1
   Cache-first data layer · IndexedDB persistence · session-auth
   Permission-driven: only permitted datasets are fetched or cached.

   ARCHITECTURE:
   ─ window.AdminPro  → public API (warmIfEmpty, get*, forceRefresh, etc.)
   ─ window.DataLayer → alias for window.AdminPro (backwards compat)
   ─ Cache layer      → IndexedDB with prefix 'ap2_' + key (same names as before)
   ─ Auth gate        → every fetch checks window.Auth.getCredentials()
   ─ Permission gate  → DATASETS built from Auth.getPermissions() at runtime

   DATASETS_ALL (full registry — permission-filtered at runtime):
     bike          | Bikes list            | 15 min TTL | permKey: ap2_bike
     employee      | Employees list        | 10 min TTL | permKey: ap2_employee
     master        | Master Sheet          |  5 min TTL | permKey: ap2_master
     cioLog        | Check-In/Out Log      |  5 min TTL | permKey: ap2_bike
     approvedSheet | Approved Sheet        |  3 min TTL | permKey: ap2_master
     recovery      | Recovery data         |  6 hr  TTL | permKey: ap2_master

   FLOW:
     login.html → Auth.createSession({ permissions }) ✓
               → AdminPro.init()      ← builds DATASETS from permissions
               → AdminPro.warmIfEmpty() ← parallel fetch permitted datasets only
               → redirect to index

     anyPage.js → AdminPro.getEmployees() / AdminPro.getBikes() / …
               → cache HIT  → returns instantly, zero network
               → cache MISS → fetch → store → return

   LOAD ORDER:
     1. auth.js      (session guard + permissions)
     2. dataLayer.js (this file)
     3. page JS
═══════════════════════════════════════════════════════════════ */
'use strict';

(function () {

  /* ─────────────────────────────────────────
     CONFIG — must match auth.js API_BASE
  ───────────────────────────────────────── */
const API_BASE = 'https://script.google.com/macros/s/AKfycbwnPUkpqvUdNey7SoEzd2JN1yfG_TJ6cneI_hZ0n-uZDN6Wk2jgYKkmoDxtdUWuvbOP6g/exec';

  const CACHE_PREFIX = 'ap2_';

  /* ─────────────────────────────────────────
     LOGOUT CLEANUP
     Wipes every trace of user data on sign-out:
       • IndexedDB store (all ap2_ entries)
       • sessionStorage (entire namespace)
       • localStorage   (ap2_ prefixed keys only — leave 3rd-party keys intact)
     Called automatically when Auth fires a 'ap:signout' event, and exposed
     as AdminPro.clearAllStorage() for manual call from logout buttons.
  ───────────────────────────────────────── */
  async function _clearAllStorageOnLogout() {
    // 1. Clear entire IDB store
    try {
      const db = await _openDB();
      await new Promise((res, rej) => {
        const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
      });
      _shadow.clear();
      console.log('[DataLayer] logout: IndexedDB store cleared');
    } catch (e) {
      console.warn('[DataLayer] logout: IDB clear failed —', e.message);
    }

    // 2. Clear sessionStorage entirely (it's scoped to this origin/tab)
    try {
      sessionStorage.clear();
      console.log('[DataLayer] logout: sessionStorage cleared');
    } catch (e) {
      console.warn('[DataLayer] logout: sessionStorage clear failed —', e.message);
    }

    // 3. Clear only ap2_ keys from localStorage (leave unrelated keys intact)
    try {
      const lsKeys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX) || k.startsWith('ap_') || k.startsWith('ap2_'));
      lsKeys.forEach(k => localStorage.removeItem(k));
      if (lsKeys.length) console.log('[DataLayer] logout: localStorage keys removed:', lsKeys);
    } catch (e) {
      console.warn('[DataLayer] logout: localStorage clear failed —', e.message);
    }
  }

  // Listen for Auth sign-out event — triggered by auth.js
  window.addEventListener('ap:signout', () => {
    DATASETS = {};
    Object.keys(_timers).forEach(k => { clearTimeout(_timers[k]); delete _timers[k]; });
    _clearAllStorageOnLogout();
  });

  /* ─────────────────────────────────────────
     PERMISSION NOTIFICATION HELPER
     Shows a toast/alert when a dataset access is denied.
  ───────────────────────────────────────── */
  function _notifyNotAuthorized(dsKey) {
    const label = (DATASETS_ALL[dsKey] && DATASETS_ALL[dsKey].label) || dsKey;
    const msg   = `⛔ Not authorized to access: ${label}`;
    console.warn('[DataLayer]', msg);

    // Use a toast if the app has one (AdminPro.showToast), else fall back to a brief banner
    if (window.AdminPro && typeof window.AdminPro.showToast === 'function') {
      window.AdminPro.showToast(msg, 'error');
    } else if (typeof window.showNotification === 'function') {
      window.showNotification(msg, 'error');
    } else {
      // Lightweight fallback banner — auto-removes after 4 s
      const existing = document.getElementById('_ap2_auth_banner');
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.id = '_ap2_auth_banner';
      Object.assign(banner.style, {
        position:'fixed', top:'16px', left:'50%', transform:'translateX(-50%)',
        background:'#c0392b', color:'#fff', padding:'10px 22px', borderRadius:'6px',
        fontFamily:'sans-serif', fontSize:'14px', zIndex:'99999',
        boxShadow:'0 3px 10px rgba(0,0,0,.35)', whiteSpace:'nowrap'
      });
      banner.textContent = msg;
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 4000);
    }
  }

  /* ─────────────────────────────────────────
     DATA NORMALISER
     Converts any server response into Array<Array<string>>
     (all cell values stringified for speed & consistency).
     • Bare Array<Array>  → stringify each cell
     • { data: [...] }   → unwrap then stringify
     • Bare Array<Object>→ values() of each object row
  ───────────────────────────────────────── */
  function _normaliseRows(raw) {
    // Unwrap { data: [...] } envelope if present
    const arr = Array.isArray(raw) ? raw
      : (raw && Array.isArray(raw.data)) ? raw.data
      : raw;

    if (!Array.isArray(arr)) return arr; // non-array payload — return as-is

    return arr.map(row => {
      if (Array.isArray(row)) {
        // Already Array row — keep values exactly as-is (numbers stay numbers)
        return row;
      }
      if (row && typeof row === 'object') {
        // Object row → values array, types preserved
        return Object.values(row);
      }
      return [row];
    });
  }

  /* ── Full registry — all possible datasets.
     permKey: must match the column name in the Permissions sheet.
     No dataset is fetched, cached, timed, or shown in the cache panel
     unless the user's session permissions include its permKey === true. */
  const DATASETS_ALL = {
    bike:          { label:'Bikes',            apiType:'bike',                ttlMs: 1*60*1000,    permKey:'ap2_bike'     },
    employee:      { label:'Employees',        apiType:'employee',            ttlMs: 1*60*1000,    permKey:'ap2_employee' },
    master:        { label:'Master Sheet',     apiType:'master',              ttlMs:  1*60*1000,    permKey:'ap2_master'   },
    cioLog:        { label:'Check-In/Out Log', apiType:'cioLog',              ttlMs:  1*60*1000,    permKey:'ap2_bike'     },
    // approvedSheet: { label:'Approved Sheet',   apiType:'getApprovedRequests', ttlMs:  3*60*1000,    permKey:'ap2_master',  paramKey:'action' },
    recovery:      { label:'Recovery',         apiType:'recovery',            ttlMs:  6*60*60*1000, permKey:'ap2_master'   },
  };

  /* ── Active datasets — permission-filtered at runtime.
     All internal functions use DATASETS (this), never DATASETS_ALL.
     Rebuilt by _buildDatasets() after permissions are available.    */
  let DATASETS = {};

  function _buildDatasets() {
    const perms = window.Auth && window.Auth.getPermissions
      ? window.Auth.getPermissions()
      : null;

    const result = {};
    for (const [key, ds] of Object.entries(DATASETS_ALL)) {
      // SECURITY: every dataset MUST have a permKey — no permKey = no access.
      // Only include if the session permissions explicitly grant it (=== true).
      // This ensures denied portals are never fetched, cached, or visible.
      if (ds.permKey && perms && perms[ds.permKey] === true) {
        result[key] = ds;
      }
    }
    DATASETS = result;
    console.log('[DataLayer] permitted datasets:', Object.keys(DATASETS));
    return DATASETS;
  }

  /* ─────────────────────────────────────────
     INDEXEDDB ENGINE
     Same key names as before: 'ap2_' + datasetName
     Same entry shape: { ts, data, fingerprint }
     DB: 'ap2_fleet_cache'  Store: 'datasets'  keyPath: 'key'
  ───────────────────────────────────────── */
  const IDB_NAME  = 'ap2_fleet_cache';
  const IDB_VER   = 2;
  const IDB_STORE = 'datasets';

  let _dbPromise = null;
  function _openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        // v1 used keyPath:'key' which conflicts with out-of-line key reads in child pages.
        // v2: delete old store and recreate without keyPath (out-of-line keys).
        if (db.objectStoreNames.contains(IDB_STORE)) {
          db.deleteObjectStore(IDB_STORE);
        }
        db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
    return _dbPromise;
  }

  /* Low-level IDB helpers — all async */
  async function _idbGet(fullKey) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly')
                    .objectStore(IDB_STORE).get(fullKey);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbSet(fullKey, value) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      // Out-of-line key: .put(record, key) — store has no keyPath
      const record = {
        ts:          value.ts,
        data:        value.data,
        fingerprint: value.fingerprint || null,
      };
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(record, fullKey);
      req.onsuccess = () => res(true);
      req.onerror   = () => {
        console.error('[DataLayer] IDB put error for', fullKey, req.error);
        rej(req.error);
      };
      tx.onerror = () => {
        console.error('[DataLayer] IDB tx error for', fullKey, tx.error);
        rej(tx.error);
      };
    });
  }

  async function _idbDelete(fullKey) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readwrite')
                    .objectStore(IDB_STORE).delete(fullKey);
      req.onsuccess = () => res(true);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbAllKeys() {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly')
                    .objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbGetAll() {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly')
                    .objectStore(IDB_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ─────────────────────────────────────────
     IN-MEMORY SHADOW  (sync reads for timers / status checks)
     Mirrors IDB so _cache.get() / .status() / .age() stay synchronous.
     Populated eagerly on load, kept live by _cache.set/clear/clearAll.
  ───────────────────────────────────────── */
  const _shadow = new Map();   // fullKey → { ts, data, fingerprint }

  // Eager load from IDB into shadow on startup.
  // Records use out-of-line keys so we pair getAllKeys() + getAll() to get key+value together.
  _openDB().then(async db => {
    const [keys, records] = await Promise.all([
      new Promise((res, rej) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
        r.onsuccess = () => res(r.result || []);
        r.onerror   = () => rej(r.error);
      }),
      new Promise((res, rej) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror   = () => rej(r.error);
      }),
    ]);
    for (let i = 0; i < keys.length; i++) {
      const k   = keys[i];
      const rec = records[i];
      if (typeof k === 'string' && k.startsWith(CACHE_PREFIX) && rec) {
        _shadow.set(k, { ts: rec.ts, data: rec.data, fingerprint: rec.fingerprint || null });
      }
    }
    console.log('[DataLayer] IDB shadow loaded —', _shadow.size, 'entries');
  }).catch(e => console.warn('[DataLayer] IDB shadow load failed:', e.message));

  /* ─────────────────────────────────────────
     CACHE PURGE ON LOGIN
     Same logic as before — now reads from IDB shadow instead of IDB directly.
  ───────────────────────────────────────── */
  function _purgeUnauthorisedCache() {
    try {
      let currentFingerprint = null;
      try {
        const raw = sessionStorage.getItem('ap_session');
        if (raw) currentFingerprint = JSON.parse(raw).sessionFingerprint || null;
      } catch {}

      const permittedFullKeys = new Set(
        Object.keys(DATASETS).map(k => CACHE_PREFIX + k)
      );

      const keysToDelete = [];

      for (const [fullKey, entry] of _shadow.entries()) {
        if (!fullKey.startsWith(CACHE_PREFIX)) continue;

        if (!permittedFullKeys.has(fullKey)) {
          keysToDelete.push(fullKey);
          continue;
        }

        if (currentFingerprint && entry.fingerprint && entry.fingerprint !== currentFingerprint) {
          keysToDelete.push(fullKey);
        }
      }

      if (keysToDelete.length) {
        keysToDelete.forEach(k => {
          _shadow.delete(k);
          _idbDelete(k).catch(() => {});
        });
        console.log('[DataLayer] purged', keysToDelete.length, 'unauthorised/stale cache entries:', keysToDelete);
      } else {
        console.log('[DataLayer] cache purge: nothing to remove — all entries authorised');
      }

    } catch (e) {
      console.warn('[DataLayer] _purgeUnauthorisedCache error:', e.message);
    }
  }

  /* Build immediately — permissions may already be in session (post-login). */
  _buildDatasets();

  /* ─────────────────────────────────────────
     CACHE  — IndexedDB wrappers
     Entry shape (same as before): { ts, data, fingerprint }
     Keys (same as before): 'ap2_' + datasetName
     Reads are sync via _shadow; writes are async to IDB.
  ───────────────────────────────────────── */
  const _cache = {
    _key(name) { return CACHE_PREFIX + name; },

    /** Sync read from shadow map — same shape as before: { ts, data, fingerprint } */
    get(name) {
      return _shadow.get(this._key(name)) || null;
    },

    /** Async write to IDB + instant shadow update */
    set(name, data) {
      let fingerprint = null;
      try {
        const raw = sessionStorage.getItem('ap_session');
        if (raw) fingerprint = JSON.parse(raw).sessionFingerprint || null;
      } catch {}

      const entry = { ts: Date.now(), data, fingerprint };
      const fullKey = this._key(name);

      // Update shadow immediately so sync callers see fresh data right away
      _shadow.set(fullKey, entry);

      // Persist to IDB asynchronously — log errors loudly so they are visible
      _idbSet(fullKey, entry).then(() => {
        console.log('[DataLayer] IDB write OK:', fullKey, '| rows:', Array.isArray(entry.data) ? entry.data.length : typeof entry.data);
      }).catch(e => {
        console.error('[DataLayer] IDB write FAILED for', fullKey, e);
      });
      return true;
    },

    clear(name) {
      const fullKey = this._key(name);
      _shadow.delete(fullKey);
      _idbDelete(fullKey).catch(() => {});
    },

    clearAll() {
      const keys = Array.from(_shadow.keys()).filter(k => k.startsWith(CACHE_PREFIX));
      keys.forEach(k => {
        _shadow.delete(k);
        _idbDelete(k).catch(() => {});
      });
    },

    /** Returns null (no cache), 'fresh', or 'stale' */
    status(name) {
      const entry = this.get(name);
      if (!entry || entry.data == null) return null;
      const ds = DATASETS[name];
      if (!ds) return null;
      return (Date.now() - entry.ts) < ds.ttlMs ? 'fresh' : 'stale';
    },

    age(name) {
      const entry = this.get(name);
      if (!entry) return Infinity;
      return Date.now() - entry.ts;
    },
  };

  function _evictOldest() {
    let oldest = null, oldestKey = null;
    for (const [k, entry] of _shadow.entries()) {
      if (!k.startsWith(CACHE_PREFIX)) continue;
      if (!oldest || entry.ts < oldest) { oldest = entry.ts; oldestKey = k; }
    }
    if (oldestKey) {
      _shadow.delete(oldestKey);
      _idbDelete(oldestKey).catch(() => {});
    }
  }

  /* ─────────────────────────────────────────
     IN-FLIGHT DEDUP
     Prevents concurrent fetches for the same key
  ───────────────────────────────────────── */
  const _inflight = {};   // key → Promise<data>

  /* ─────────────────────────────────────────
     CORE FETCH
     Attaches session credentials to every request.
     Returns parsed data array/object, or throws.
  ───────────────────────────────────────── */
  async function _fetchFromServer(dsKey) {
    // Dedup: if a fetch for this key is already in flight, piggyback on it
    if (_inflight[dsKey]) {
      console.log(`[DataLayer] ${dsKey}: piggyback on in-flight fetch`);
      return _inflight[dsKey];
    }

    const promise = (async () => {
      // ── PRE-REQUEST PERMISSION GATE (re-verified fresh every time) ──────────
      // Rebuild permitted dataset map from the live session before every fetch.
      // This catches: permission changes, session expiry, cross-user cache re-use.
      _buildDatasets();

      const ds = DATASETS[dsKey];
      if (!ds) {
        // Dataset not in the allowed list — notify user and abort cleanly
        _notifyNotAuthorized(dsKey);
        throw new Error(`[DataLayer] "${dsKey}" not permitted — access denied`);
      }
      // ────────────────────────────────────────────────────────────────────────

      // Get credentials — abort if session invalid
      const creds = window.Auth && window.Auth.getCredentials
        ? window.Auth.getCredentials()
        : null;

      if (!creds || !creds.sessionId || !creds.token) {
        throw new Error(`[DataLayer] ${dsKey}: no valid session — aborting fetch`);
      }

      // // Some endpoints use ?action= instead of ?type= (e.g. approvedSheet)
      const paramKey = ds.paramKey || 'type';
      const url = `${API_BASE}?${paramKey}=${encodeURIComponent(ds.apiType)}`
        + `&sessionId=${encodeURIComponent(creds.sessionId)}`
        + `&token=${encodeURIComponent(creds.token)}`
        + `&_t=${Date.now()}`;

      console.log(`[DataLayer] ${dsKey}: fetching → ${paramKey}=${ds.apiType}`);
      const t0  = performance.now();

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 30000); // 30 s timeout

      let res;
      try {
        res = await fetch(url, { cache: 'no-store', redirect: 'follow', mode: 'cors', signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${dsKey}`);

      const json = await res.json();

      // GUARD: never cache an API error — throw so IDB stays clean
      if (json && typeof json === 'object' && !Array.isArray(json) && json.success === false) {
        const msg = json.error || json.message || 'Unknown server error';
        console.error(`[DataLayer] ${dsKey}: API rejected — "${msg}" | ${url}`);
        throw new Error(`[DataLayer] ${dsKey} API error: ${msg}`);
      }

      // Normalise to Array<Array> — consistent format for all consumers
      const data = _normaliseRows(json);

      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`[DataLayer] ${dsKey}: empty response — not caching`);
        throw new Error(`[DataLayer] ${dsKey}: empty or invalid data received`);
      }

      _cache.set(dsKey, data);
      const elapsed = Math.round(performance.now() - t0);
      console.log(`[DataLayer] ${dsKey}: cached ${data.length} rows (${elapsed} ms)`);
      return data;
    })();

    _inflight[dsKey] = promise;
    try {
      const result = await promise;
      return result;
    } finally {
      delete _inflight[dsKey];
    }
  }

  /* ─────────────────────────────────────────
     GET — cache-first, fetch-on-miss/stale
  ───────────────────────────────────────── */
  async function _get(dsKey, force) {
    // Re-verify permission on every call (not just fetch — blocks stale cache returns too)
    _buildDatasets();
    const ds = DATASETS[dsKey];
    if (!ds) {
      _notifyNotAuthorized(dsKey);
      throw new Error(`[DataLayer] "${dsKey}" not permitted or unknown`);
    }

    if (!force) {
      const entry = _cache.get(dsKey);
      if (entry && entry.data != null) {
        const age = Date.now() - entry.ts;
        if (age < ds.ttlMs) {
          console.log(`[DataLayer] ${dsKey}: cache HIT (age ${Math.round(age/1000)}s)`);
          return entry.data;
        }
        console.log(`[DataLayer] ${dsKey}: cache STALE (age ${Math.round(age/1000)}s) — refreshing`);
      } else {
        console.log(`[DataLayer] ${dsKey}: cache MISS — fetching`);
      }
    } else {
      console.log(`[DataLayer] ${dsKey}: force refresh — skipping cache`);
      _cache.clear(dsKey);
    }

    return _fetchFromServer(dsKey);
  }

  /* ─────────────────────────────────────────
     WARM-IF-EMPTY
     Called after login. Rebuilds DATASETS from permissions first,
     then fires all permitted fetches in parallel.
  ───────────────────────────────────────── */
  async function warmIfEmpty() {
    // Always rebuild from permissions before warming, then purge any denied/stale cache
    _buildDatasets();
    _purgeUnauthorisedCache();

    const allowedKeys = Object.keys(DATASETS);
    if (!allowedKeys.length) {
      console.warn('[DataLayer] warmIfEmpty: no permitted datasets — nothing to fetch');
      return;
    }

    // Only fetch datasets that are missing or stale — skip fresh ones
    // This is the correct behaviour for "warm if empty": don't re-fetch what we already have
    const toFetch = allowedKeys.filter(key => {
      const status = _cache.status(key);
      return status !== 'fresh'; // null (missing) or 'stale' → fetch; 'fresh' → skip
    });

    if (!toFetch.length) {
      console.log('[DataLayer] warmIfEmpty: all datasets are fresh — skipping fetch');
      _startAllTimers();
      return;
    }

    console.log('[DataLayer] warmIfEmpty: fetching', toFetch.length, 'missing/stale datasets:', toFetch);

    await Promise.allSettled(
      toFetch.map(key => _fetchFromServer(key))
    );

    // Schedule refresh timers for all permitted datasets
    _startAllTimers();

    console.log('[DataLayer] warmIfEmpty: all done');
  }

  /* ─────────────────────────────────────────
     BACKGROUND REFRESH TIMERS
     Each permitted dataset auto-refreshes 30s before its TTL expires.
  ───────────────────────────────────────── */
  const _timers = {};

  function _scheduleRefresh(dsKey) {
    const ds = DATASETS[dsKey];
    if (!ds) return;

    if (_timers[dsKey]) { clearTimeout(_timers[dsKey]); delete _timers[dsKey]; }

    const entry = _cache.get(dsKey);
    if (!entry) return;   // nothing cached yet — no timer needed

    const age       = Date.now() - entry.ts;
    const remaining = ds.ttlMs - age;
    const delay     = Math.max(0, remaining - 30000);  // 30 s before expiry

    _timers[dsKey] = setTimeout(async () => {
      if (document.visibilityState === 'hidden') {
        _scheduleRefresh(dsKey);   // check again when visible
        return;
      }
      console.log(`[DataLayer] background refresh: ${dsKey}`);
      try {
        await _fetchFromServer(dsKey);
        _scheduleRefresh(dsKey);   // reschedule after refresh
      } catch (e) {
        console.warn(`[DataLayer] background refresh failed: ${dsKey}`, e.message);
        // Retry in 2 min on failure
        _timers[dsKey] = setTimeout(() => _scheduleRefresh(dsKey), 2 * 60 * 1000);
      }
    }, delay);

    console.log(`[DataLayer] ${dsKey}: next refresh in ${Math.round(delay/1000)}s`);
  }

  function _startAllTimers() {
    // Only start timers for permitted datasets
    Object.keys(DATASETS).forEach(_scheduleRefresh);
  }

  /* ─────────────────────────────────────────
     PUBLIC API  — window.AdminPro
  ───────────────────────────────────────── */
  window.AdminPro = {

    VERSION: '2.1',  // bump when deploying — use ?v=2.1 on the <script> tag to bust GitHub Pages cache

    /* ── INIT — rebuild permitted DATASETS + purge stale cache + start timers.
       Call this once after Auth.createSession() on login.
       Security guarantee:
         1. DATASETS is rebuilt strictly from server-granted permissions.
         2. Any IndexedDB cache for non-permitted datasets is deleted immediately.
         3. Any cache entries written by a different user are deleted immediately.
       Only then are timers started so background refresh never touches denied data. */
    init() {
      _buildDatasets();            // step 1: filter to permitted datasets only
      _purgeUnauthorisedCache();   // step 2: evict stale/denied/cross-user cache
      _startAllTimers();           // step 3: schedule refresh for permitted sets only
      console.log('[DataLayer] init: ready with', Object.keys(DATASETS).length, 'permitted datasets');
    },

    /* ── WARMUP — rebuild permissions then parallel-fetch all permitted ── */
    warmIfEmpty,

    /* ── STREAM-QUERY
       Fetches filtered index arrays directly from IDB via cursor —
       never loads the whole table into JS RAM at once.
       predicateFn(row) → true/false  (row = raw Array or Object from IDB)
       Returns Promise<Array> of matching rows only.
       Falls back to shadow-map read if IDB is unavailable.               */
    async streamQuery(dsKey, predicateFn) {
      _buildDatasets();
      const ds = DATASETS[dsKey];
      if (!ds) { _notifyNotAuthorized(dsKey); throw new Error(`[DataLayer] "${dsKey}" not permitted`); }

      const fullKey = CACHE_PREFIX + dsKey;

      try {
        const db = await _openDB();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(IDB_STORE, 'readonly')
                        .objectStore(IDB_STORE).get(fullKey);
          req.onsuccess = () => {
            const rec = req.result;
            if (!rec || !Array.isArray(rec.data)) { resolve([]); return; }
            // Stream iterate: never clone the whole array — filter row by row
            const results = [];
            for (let i = 0, len = rec.data.length; i < len; i++) {
              try { if (predicateFn(rec.data[i])) results.push(rec.data[i]); } catch (_) {}
            }
            resolve(results);
          };
          req.onerror = () => reject(req.error);
        });
      } catch (e) {
        console.warn('[DataLayer] streamQuery IDB fallback:', e.message);
        const entry = _cache.get(dsKey);
        if (!entry || !Array.isArray(entry.data)) return [];
        return entry.data.filter(row => { try { return predicateFn(row); } catch (_) { return false; } });
      }
    },

    /* ── GETTERS  — cache-first, auto-fetch on miss/stale ── */
    getEmployees      (force) { return _get('employee',      force); },
    getBikes          (force) { return _get('bike',          force); },
    getMasterSheet    (force) { return _get('master',        force); },
    getCioLog         (force) { return _get('cioLog',        force); },
    getApprovedSheet  (force) { return _get('approvedSheet', force); },
    getRecovery       (force) { return _get('recovery',      force); },

    /** Generic getter by dataset key */
    get(dsKey, force) { return _get(dsKey, force); },

    /* ── FORCE REFRESH  — clears cache + re-fetches immediately ── */
    async forceRefresh(dsKey) {
      if (dsKey) {
        if (!DATASETS[dsKey]) {
          console.warn(`[DataLayer] forceRefresh: "${dsKey}" not permitted — skipping`);
          return;
        }
        const data = await _get(dsKey, true);
        _scheduleRefresh(dsKey);
        return data;
      }
      // No key = refresh ALL permitted
      await Promise.allSettled(Object.keys(DATASETS).map(k => _get(k, true)));
      _startAllTimers();
    },

    /* ── WARM CACHE (alias for refresh all — used by index.html) ── */
    async warmCache() {
      await this.forceRefresh();
    },

    /* ── CACHE UTILITIES ── */
    cache: {
      get      : (name)        => _cache.get(name),
      set      : (name, data)  => _cache.set(name, data),
      clear    : (name)        => _cache.clear(name),
      clearAll : ()            => _cache.clearAll(),
      status   : (name)        => _cache.status(name),
      age      : (name)        => _cache.age(name),
    },

    /* ── getCacheStatus()
       Returns ONLY permitted datasets — what the cache panel shows.
       [{ key, label, ageMs, ageLabel, fresh, hasData, lastSync, ttl }]
    ── */
    getCacheStatus() {
      return Object.entries(DATASETS).map(([key, ds]) => {
        const entry   = _cache.get(key);
        const ageMs   = entry ? Date.now() - entry.ts : Infinity;
        const hasData = entry && entry.data != null
          ? (Array.isArray(entry.data) ? entry.data.length > 0 : true)
          : false;
        const fresh   = hasData && ageMs < ds.ttlMs;

        const ageLabel = ageMs === Infinity ? 'Not loaded'
          : ageMs < 60000      ? Math.floor(ageMs / 1000)    + 's ago'
          : ageMs < 3600000    ? Math.floor(ageMs / 60000)   + 'm ago'
          :                      Math.floor(ageMs / 3600000) + 'h ago';

        let lastSync = null;
        if (ageMs !== Infinity) {
          const d = new Date(Date.now() - ageMs);
          lastSync = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
            + ', ' + d.toLocaleDateString([], { day:'2-digit', month:'short' });
        }

        const rowCount  = (entry && Array.isArray(entry.data)) ? entry.data.length : null;
        const remaining = ageMs === Infinity ? 0 : Math.max(0, ds.ttlMs - ageMs);
        const inFlight  = !!_inflight[key];

        return { key, label: ds.label, ageMs, ageLabel, fresh, hasData, lastSync,
                 ttl: ds.ttlMs, rowCount, remaining, inFlight };
      });
    },

    /* ── getActiveDatasets — exposes permitted keys to index.html ── */
    getActiveDatasets() {
      return { ...DATASETS };
    },

    /* ── stopAllTimers  — called by Auth.signOut() ── */
    stopAllTimers() {
      Object.keys(_timers).forEach(k => { clearTimeout(_timers[k]); delete _timers[k]; });
    },

    /* ── signOut  — full cleanup: timers + all storage + reset DATASETS ──
       Call this from your logout button / auth.js signOut flow.
       Also fires automatically when the 'ap:signout' window event is dispatched. */
    async signOut() {
      this.stopAllTimers();
      DATASETS = {};
      await _clearAllStorageOnLogout();
      console.log('[DataLayer] signOut: all storage cleared, DATASETS reset');
    },

    /* ── clearAllStorage — alias for manual calls ── */
    clearAllStorage: _clearAllStorageOnLogout,

    /* ── getDatasetNames — returns the names of ALL permitted datasets dynamically.
       Never hardcode table names — always use this to know what's available. ── */
    getDatasetNames() {
      return Object.keys(DATASETS);
    },

    /* ── getDatasetMeta — full permitted dataset config (keys, labels, ttl, apiType) ── */
    getDatasetMeta() {
      return Object.entries(DATASETS).map(([key, ds]) => ({
        key,
        label:   ds.label,
        apiType: ds.apiType,
        ttlMs:   ds.ttlMs,
        permKey: ds.permKey,
      }));
    },

  };

  /* Backwards-compat alias */
  window.DataLayer = window.AdminPro;

  /* ─────────────────────────────────────────
     AUTO-INIT
     On non-login pages: build permitted datasets + start timers.
  ───────────────────────────────────────── */
  (function _autoInit() {
    const isLoginPage = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');

    if (isLoginPage) return;

    // On index.html (and any protected page): rebuild permitted datasets from session,
    // then warm any missing/stale entries. This handles returning from another portal tab
    // where IndexedDB cache may have been partially or fully cleared.
    function _initAndWarm() {
      _buildDatasets();
      _purgeUnauthorisedCache(); // evict any non-permitted or cross-user cache on every page load
      _startAllTimers();
      // Non-blocking background warm — fills in any missing/stale cache entries
      warmIfEmpty().catch(e => console.warn('[DataLayer] autoInit warmIfEmpty error:', e.message));
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initAndWarm);
    } else {
      _initAndWarm();
    }
  })();

  /* ─────────────────────────────────────────
     VISIBILITY CHANGE WATCHER
     When user returns to this tab (from another portal or browser tab),
     re-warm any datasets that went stale while the tab was hidden.
     NOTE: must stay INSIDE the main IIFE so private functions are in scope.
  ───────────────────────────────────────── */
  (function _visibilityWatcher() {
    const isLoginPage = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');
    if (isLoginPage) return;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;

      // Guard: _buildDatasets, _cache, _fetchFromServer and _startAllTimers are
      // private to this IIFE. If this handler somehow fires in a context where they
      // are out of scope (stale cached script / cross-frame race), bail cleanly
      // instead of throwing a ReferenceError that breaks the page.
      try {
        _buildDatasets(); // re-read permissions (session might have been refreshed)
      } catch (e) {
        console.warn('[DataLayer] visibilityWatcher: _buildDatasets unavailable —', e.message);
        return;
      }

      try {
        const staleKeys = Object.keys(DATASETS).filter(key => {
          const status = _cache.status(key);
          return status !== 'fresh';
        });
        if (staleKeys.length) {
          console.log('[DataLayer] Tab visible — refreshing stale datasets:', staleKeys);
          Promise.allSettled(staleKeys.map(key => _fetchFromServer(key))).then(() => {
            _startAllTimers();
          });
        }
      } catch (e) {
        console.warn('[DataLayer] visibilityWatcher error:', e.message);
      }
    });
  })();

  console.log('[DataLayer] v2.1 loaded — IndexedDB cache — window.AdminPro ready');

})();
