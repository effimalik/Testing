/* ═══════════════════════════════════════════════════════════════
   dataLayer.js — AdminPro UAE  v1.0
   Cache-first data layer · localStorage persistence · session-auth

   ARCHITECTURE:
   ─ window.AdminPro  → public API (warmIfEmpty, get*, forceRefresh, etc.)
   ─ window.DataLayer → alias for window.AdminPro (backwards compat)
   ─ Cache layer      → sessionStorage with prefix 'ap2_' + key
   ─ Auth gate        → every fetch checks window.Auth.getCredentials()

   DATASETS (must match DS_META in index.html):
     bike          | Bikes list            | 15 min TTL
     employee      | Employees list        | 10 min TTL
     master        | Master Sheet          |  5 min TTL
     cioLog        | Check-In/Out Log      |  5 min TTL
     approvedSheet | Approved Sheet        |  3 min TTL
     recovery      | Recovery data         |  6 hr  TTL

   FLOW:
     login.html → Auth.createSession() ✓
               → AdminPro.warmIfEmpty()   ← background pre-fetch all datasets
               → handleLoginRedirect()    ← redirect to index / ?next=

     anyPage.js → AdminPro.getEmployees() / AdminPro.getBikes() / …
               → cache HIT  → returns instantly, zero network
               → cache MISS → fetch → store → return

   LOAD ORDER:
     1. auth.js      (session guard)
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

  /* Dataset registry — single source of truth inside dataLayer.
     TTLs mirror DS_META in index.html (keep in sync).        */
  const DATASETS = {
    bike: {
      label    : 'Bikes',
      apiType  : 'bikes',            // ?type=getBikes sent to Apps Script
      ttlMs    : 1 * 60 * 1000,        // 15 min
    },
    employee: {
      label    : 'Employees',
      apiType  : 'employees',
      ttlMs    : 1 * 60 * 1000,        // 10 min
    },
    master: {
      label    : 'Master Sheet',
      apiType  : 'getMasterSheet',
      ttlMs    :  5 * 60 * 1000,        //  5 min
    },
    cioLog: {
      label    : 'Check-In/Out Log',
      apiType  : 'getCioLog',
      ttlMs    :  5 * 60 * 1000,        //  5 min
    },
    approvedSheet: {
      label    : 'Approved Sheet',
      apiType  : 'getApprovedSheet',
      ttlMs    :  3 * 60 * 1000,        //  3 min
    },
    recovery: {
      label    : 'Recovery',
      apiType  : 'getRecovery',
      ttlMs    :  6 * 60 * 60 * 1000,   //  6 hr
    },
  };

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
  async function _fetchFromServer(dsKey, force) {
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
        res = await fetch(url, { cache: 'no-store', signal: controller.signal });
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
    if (!ds) throw new Error(`[DataLayer] Unknown dataset key: "${dsKey}"`);

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

    return _fetchFromServer(dsKey, force);
  }

  /* ─────────────────────────────────────────
     WARM-IF-EMPTY
     Called by login.html after Auth.createSession() succeeds.
     Pre-fetches every dataset that isn't already Fresh.
     Runs in parallel — does NOT block the redirect.
  ───────────────────────────────────────── */
  async function warmIfEmpty() {
    const perms = window.Auth && window.Auth.getPermissions
      ? window.Auth.getPermissions()
      : null;

    if (!perms) {
      console.warn('[DataLayer] warmIfEmpty: no permissions found — skipping warm');
      return;
    }

    const allowedKeys = Object.keys(perms).filter(k => perms[k] === true);
    console.log('[DataLayer] warmIfEmpty: parallel fetch for', allowedKeys.length, 'datasets:', allowedKeys);

    await Promise.allSettled(
      allowedKeys.map(permKey => {
        const dsKey = permKey.replace('ap2_', '');
        if (!DATASETS[dsKey]) return Promise.resolve();
        return _fetchFromServer(dsKey);
      })
    );

    console.log('[DataLayer] warmIfEmpty: all done');
  }

  /* ─────────────────────────────────────────
     BACKGROUND REFRESH TIMERS
     Each dataset auto-refreshes 30s before its TTL expires.
     Timers only run while the page is visible.
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
    Object.keys(DATASETS).forEach(_scheduleRefresh);
  }

  /* ─────────────────────────────────────────
     PUBLIC API  — window.AdminPro
  ───────────────────────────────────────── */
  window.AdminPro = {

    /* ── WARMUP (called from login.html before redirect) ── */
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
        const data = await _get(dsKey, true);
        _scheduleRefresh(dsKey);
        return data;
      }
      // No key = refresh ALL
      const keys = Object.keys(DATASETS);
      await Promise.allSettled(keys.map(k => _get(k, true)));
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
       Returns the array that index.html's renderCacheTable() expects:
       [{ key, label, ageMs, ageLabel, fresh, hasData, lastSync, ttl }]
    ── */
    getCacheStatus() {
      return Object.entries(DATASETS).map(([key, ds]) => {
        const entry  = _cache.get(key);
        const ageMs  = entry ? Date.now() - entry.ts : Infinity;
        const hasData = entry && entry.data != null
          ? (Array.isArray(entry.data) ? entry.data.length > 0 : true)
          : false;
        const fresh  = hasData && ageMs < ds.ttlMs;

        const ageLabel = ageMs === Infinity ? 'Not loaded'
          : ageMs < 60000      ? Math.floor(ageMs / 1000)       + 's ago'
          : ageMs < 3600000    ? Math.floor(ageMs / 60000)      + 'm ago'
          :                      Math.floor(ageMs / 3600000)    + 'h ago';

        let lastSync = null;
        if (ageMs !== Infinity) {
          const d = new Date(Date.now() - ageMs);
          lastSync = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
            + ', ' + d.toLocaleDateString([], { day:'2-digit', month:'short' });
        }

        /* Extra details for the expanded panel */
        const rowCount  = (entry && Array.isArray(entry.data)) ? entry.data.length : null;
        const remaining = ageMs === Infinity ? 0 : Math.max(0, ds.ttlMs - ageMs);
        const inFlight  = !!_inflight[key];

        return { key, label: ds.label, ageMs, ageLabel, fresh, hasData, lastSync,
                 ttl: ds.ttlMs, rowCount, remaining, inFlight };
      });
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
     On non-login pages: start background refresh timers
     so data auto-refreshes while the user works.
  ───────────────────────────────────────── */
  (function _autoInit() {
    const isLoginPage = window.location.pathname.endsWith('login.html')
      || window.location.href.includes('/login.html');

    if (isLoginPage) return;  // login.html calls warmIfEmpty() manually after createSession

    // Start timers after DOM ready so auth.js has already run its boot check
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _startAllTimers);
    } else {
      _startAllTimers();
    }
  })();

  console.log('[DataLayer] v1.0 loaded — window.AdminPro ready');

})();
