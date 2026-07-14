/* ═══════════════════════════════════════════════════════════════════════
   cacheWatcher.js
   ───────────────────────────────────────────────────────────────────────
   ONE watchman for the whole app, instead of every page having its own.
   Usable in TWO places, with the exact same file:
     - The top shell (index.html) — watches + relays to all iframes.
     - A leaf module page (allEmp.html, allBike.html, etc.) — watches its
       own copy of the cache and reacts directly, no custom IDB code
       needed in that page anymore.

   TWO ways it detects changes — used together:

   1. INSTANT (preferred): whoever writes/deletes/restores cache data
      calls AP2CacheWatcher.notifyNow(key) right after doing it — using
      whatever key variable it just wrote (never typed by hand). Zero
      delay — pages update the same moment the write happens.

   2. FAST FALLBACK POLL: a safety net that checks every ~1.5s in case
      something changes the cache WITHOUT calling notifyNow (a raw IDB
      edit, another browser tab, a manual restore, etc). This also
      catches a key being DELETED, not just changed.

   Whatever detects a change, ALL of these fire, so it works the same
   everywhere:
     - Any local page.subscribe(callback) — called with the key that changed
     - Any child iframes (only if this page passed getFrames — i.e. it's
       the shell) — via postMessage: { type:'ap-cache-updated', key }
     - If THIS page received that same postMessage from ITS parent, it's
       forwarded to its own local subscribers too — so a leaf page reacts
       whether the change was detected by itself or by the shell above it.

   How to use it in index.html (the shell):
     <script src="cacheWatcher.js"></script>
     <script>
       AP2CacheWatcher.init({ getFrames: () => document.querySelectorAll('iframe') });
     </script>

   How to use it in a leaf page (e.g. allEmp.html):
     <script src="cacheWatcher.js"></script>
     <script>
       AP2CacheWatcher.init();                 // no getFrames needed — it's not relaying to anyone
       AP2CacheWatcher.subscribe(() => {
         // re-read + re-render silently, no spinner, no blink
       });
     </script>

   Reading data without writing your own IDB boilerplate:
     const rows = await AP2CacheWatcher.readKey('ap2_employee'); // array or null

   How to wire the instant path into dataLayer.js — call this right
   after any successful save/delete/restore of a dataset, using the
   key variable already in scope there (never hardcoded):
     AP2CacheWatcher.notifyNow(key);
   ═══════════════════════════════════════════════════════════════════════ */

(function (global) {
  const _IDB_NAME   = 'ap2_fleet_cache';
  const _IDB_STORE  = 'datasets';
  const POLL_MS     = 1500;   // fast fallback — instant path above should normally win

  let _idbConn      = null;
  let _getFrames    = () => [];   // function supplied by index.html to find child iframes
  let _fingerprints = {};         // key -> lightweight snapshot used to detect change
  let _knownKeys    = new Set();  // every key ever seen, so deletions can be detected
  let _pollTimer    = null;
  let _started      = false;
  let _subscribers  = [];         // local callbacks: fn(key)

  function _getDB() {
    if (_idbConn) return Promise.resolve(_idbConn);
    return new Promise((res, rej) => {
      const req = indexedDB.open(_IDB_NAME);
      req.onsuccess = e => { _idbConn = e.target.result; res(_idbConn); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  function _allKeys(db) {
    return new Promise((res, rej) => {
      const req = db.transaction(_IDB_STORE, 'readonly')
                    .objectStore(_IDB_STORE).getAllKeys();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  function _getRecord(db, key) {
    return new Promise((res, rej) => {
      const req = db.transaction(_IDB_STORE, 'readonly')
                    .objectStore(_IDB_STORE).get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  // Cheap "did this change?" signature — avoids re-hashing entire datasets.
  // Uses row count + a stringified sample of first/last row as a fingerprint.
  function _fingerprint(rec) {
    if (!rec || !Array.isArray(rec.data)) return '';
    const len = rec.data.length;
    const first = JSON.stringify(rec.data[0] || '');
    const last  = JSON.stringify(rec.data[len - 1] || '');
    return len + '|' + first + '|' + last;
  }

  // Public helper: read one dataset's array straight from IDB, no boilerplate needed in the page.
  async function readKey(key) {
    try {
      const db  = await _getDB();
      const rec = await _getRecord(db, key);
      if (!rec || !Array.isArray(rec.data) || !rec.data.length) return null;
      return rec.data;
    } catch (e) {
      console.warn('[cacheWatcher] readKey failed:', e.message);
      return null;
    }
  }

  function _broadcast(key) {
    // Tell any locally subscribed listeners on THIS page
    _subscribers.forEach(fn => { try { fn(key); } catch (e) {} });

    // Relay to child iframes, only relevant if this page passed getFrames (i.e. it's the shell)
    const frames = _getFrames() || [];
    frames.forEach(f => {
      try {
        f.contentWindow && f.contentWindow.postMessage({ type: 'ap-cache-updated', key }, '*');
      } catch (e) { /* ignore cross-origin / not-ready iframes */ }
    });
  }

  async function _checkAll() {
    try {
      const db          = await _getDB();
      const currentKeys = await _allKeys(db);
      const currentSet  = new Set(currentKeys);

      // ── Check every key that currently exists — new data or changed data ──
      for (const key of currentKeys) {
        const rec = await _getRecord(db, key);
        const fp  = _fingerprint(rec);
        if (_fingerprints[key] !== undefined && _fingerprints[key] !== fp) {
          _broadcast(key); // data changed (or just appeared for the first time after being empty)
        }
        _fingerprints[key] = fp;
        _knownKeys.add(key);
      }

      // ── Check for keys that existed before but are now GONE (cache deleted) ──
      for (const key of _knownKeys) {
        if (!currentSet.has(key) && _fingerprints[key] !== undefined) {
          delete _fingerprints[key];
          _broadcast(key); // tell pages so they can show "no data" state immediately
        }
      }
    } catch (e) {
      console.warn('[cacheWatcher] check failed:', e.message);
    }
  }

  function init(opts) {
    if (_started) return; // guard against double-init
    _started = true;
    if (opts && typeof opts.getFrames === 'function') _getFrames = opts.getFrames;

    // Prime fingerprints first so we don't fire false "changed" events on page load
    _checkAll().then(() => {
      _pollTimer = setInterval(_checkAll, POLL_MS);
    });

    // If THIS page is itself inside an iframe and its parent (the shell) broadcasts
    // a change, forward that to this page's own local subscribers too — so a leaf
    // page reacts the same way whether it detected the change itself or was told.
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'ap-cache-updated') {
        _subscribers.forEach(fn => { try { fn(e.data.key); } catch (err) {} });
      }
    });
  }

  // Register a callback to run whenever any dataset changes (change OR deletion).
  // Returns an unsubscribe function.
  function subscribe(fn) {
    _subscribers.push(fn);
    return () => { _subscribers = _subscribers.filter(f => f !== fn); };
  }

  // Manual trigger — call this right after a write so pages don't wait for the next poll
  function notifyNow(key) {
    _broadcast(key);
  }

  global.AP2CacheWatcher = { init, notifyNow, subscribe, readKey };
})(window);
