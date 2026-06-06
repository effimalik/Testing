/* ═══════════════════════════════════════════════════════════════
   dataLayer.js — AdminPro UAE  v2.0
   Cache-first data layer · sessionStorage persistence · session-auth
   Permission-driven: only permitted datasets are fetched or cached.

   ARCHITECTURE:
   ─ window.AdminPro  → public API (warmIfEmpty, get*, forceRefresh, etc.)
   ─ window.DataLayer → alias for window.AdminPro (backwards compat)
   ─ Cache layer      → sessionStorage with prefix 'ap2_' + key
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
  const API_BASE = 'https://script.google.com/macros/s/AKfycbx9O_58jlTsohkp8bNYA1rO2EQm9M9FeXoe1FT3E0n8yJ91jseidhKiM0Ss7meNkl7Elg/exec';

  const CACHE_PREFIX = 'ap2_';

  /* ── Full registry — all possible datasets.
     permKey: must match the column name in the Permissions sheet.
     No dataset is fetched, cached, timed, or shown in the cache panel
     unless the user's session permissions include its permKey === true. */
  const DATASETS_ALL = {
    bike:          { label:'Bikes',            apiType:'bikes',            ttlMs: 15*60*1000,    permKey:'ap2_bike'     },
    employee:      { label:'Employees',        apiType:'employees',        ttlMs: 10*60*1000,    permKey:'ap2_employee' },
    master:        { label:'Master Sheet',     apiType:'getMasterSheet',   ttlMs:  5*60*1000,    permKey:'ap2_master'   },
    cioLog:        { label:'Check-In/Out Log', apiType:'getCioLog',        ttlMs:  5*60*1000,    permKey:'ap2_bike'     },
    approvedSheet: { label:'Approved Sheet',   apiType:'getApprovedSheet', ttlMs:  3*60*1000,    permKey:'ap2_master'   },
    recovery:      { label:'Recovery',         apiType:'getRecovery',      ttlMs:  6*60*60*1000, permKey:'ap2_master'   },
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
      if (!ds.permKey || (perms && perms[ds.permKey] === true)) {
        result[key] = ds;
      }
    }
    DATASETS = result;
    console.log('[DataLayer] active datasets:', Object.keys(DATASETS));
    return DATASETS;
  }

  /* Build immediately — permissions may already be in session (post-login). */
  _buildDatasets();

  /* ─────────────────────────────────────────
     CACHE  — sessionStorage wrappers
     Format: { ts: <epoch ms>, data: <value> }
  ───────────────────────────────────────── */
  const _cache = {
    _key(name) { return CACHE_PREFIX + name; },

    get(name) {
      try {
        const raw = sessionStorage.getItem(this._key(name));
        if (!raw) return null;
        return JSON.parse(raw);        // { ts, data }
      } catch { return null; }
    },

    set(name, data) {
      try {
        sessionStorage.setItem(this._key(name), JSON.stringify({ ts: Date.now(), data }));
        return true;
      } catch (e) {
        // sessionStorage full — try evicting the oldest entry and retry once
        console.warn('[DataLayer] sessionStorage full — evicting oldest cache entry');
        try { _evictOldest(); } catch {}
        try {
          sessionStorage.setItem(this._key(name), JSON.stringify({ ts: Date.now(), data }));
          return true;
        } catch { return false; }
      }
    },

    clear(name) {
      try { sessionStorage.removeItem(this._key(name)); } catch {}
    },

    clearAll() {
      try {
        const keys = Object.keys(sessionStorage).filter(k => k.startsWith(CACHE_PREFIX));
        keys.forEach(k => sessionStorage.removeItem(k));
      } catch {}
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
    for (const k of Object.keys(sessionStorage)) {
      if (!k.startsWith(CACHE_PREFIX)) continue;
      try {
        const { ts } = JSON.parse(sessionStorage.getItem(k));
        if (!oldest || ts < oldest) { oldest = ts; oldestKey = k; }
      } catch {}
    }
    if (oldestKey) sessionStorage.removeItem(oldestKey);
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
      // Get credentials — abort if session invalid
      const creds = window.Auth && window.Auth.getCredentials
        ? window.Auth.getCredentials()
        : null;

      if (!creds || !creds.sessionId || !creds.token) {
        throw new Error(`[DataLayer] ${dsKey}: no valid session — aborting fetch`);
      }

      const ds  = DATASETS[dsKey];
      if (!ds) throw new Error(`[DataLayer] ${dsKey}: not in active datasets — permission denied`);

      const url = `${API_BASE}?type=${encodeURIComponent(ds.apiType)}`
        + `&sessionId=${encodeURIComponent(creds.sessionId)}`
        + `&token=${encodeURIComponent(creds.token)}`
        + `&_t=${Date.now()}`;

      console.log(`[DataLayer] ${dsKey}: fetching from server…`);
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

      // Accept { data: [...] } envelope OR bare array
      const data = Array.isArray(json) ? json
        : (json && json.data != null)  ? json.data
        : json;

      _cache.set(dsKey, data);
      const elapsed = Math.round(performance.now() - t0);
      console.log(`[DataLayer] ${dsKey}: stored ${Array.isArray(data) ? data.length + ' rows' : typeof data} in cache (${elapsed} ms)`);
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
    const ds = DATASETS[dsKey];
    if (!ds) throw new Error(`[DataLayer] "${dsKey}" not permitted or unknown`);

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
    // Always rebuild from permissions before warming
    _buildDatasets();

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

    /* ── INIT — rebuild permitted DATASETS + start timers.
       Call this once after Auth.createSession() on login.   */
    init() {
      _buildDatasets();
      _startAllTimers();
      console.log('[DataLayer] init: ready with', Object.keys(DATASETS).length, 'datasets');
    },

    /* ── WARMUP — rebuild permissions then parallel-fetch all permitted ── */
    warmIfEmpty,

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
    // where sessionStorage cache may have been partially or fully cleared.
    function _initAndWarm() {
      _buildDatasets();
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

  console.log('[DataLayer] v2.0 loaded — window.AdminPro ready');

})();

  /* ─────────────────────────────────────────
     VISIBILITY CHANGE WATCHER
     When user returns to this tab (from another portal or browser tab),
     re-warm any datasets that went stale while the tab was hidden.
     This is the fix for "cache miss on returning to portal".
  ───────────────────────────────────────── */
  (function _visibilityWatcher() {
    const isLoginPage = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');
    if (isLoginPage) return;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // Tab is now visible — check for stale/empty entries and warm them
      _buildDatasets(); // re-read permissions (session might have been refreshed)
      const staleKeys = Object.keys(DATASETS).filter(key => {
        const status = _cache.status(key);
        return status !== 'fresh'; // 'stale', null (empty), or missing
      });
      if (staleKeys.length) {
        console.log('[DataLayer] Tab visible — refreshing stale datasets:', staleKeys);
        Promise.allSettled(staleKeys.map(key => _fetchFromServer(key))).then(() => {
          _startAllTimers();
        });
      }
    });
  })();
