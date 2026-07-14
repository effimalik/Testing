/* ═══════════════════════════════════════════════════════════════════════
   cacheWatcher.js
   ───────────────────────────────────────────────────────────────────────
   ONE watchman for the whole app, instead of every page having its own.

   What it does:
   - Opens the shared IndexedDB (ap2_fleet_cache / datasets) ONCE.
   - Checks every dataset key on a single timer (every 30s).
   - Whenever a key's data actually changes, it tells every open child
     page (iframe) about it via postMessage — same message shape the
     pages already listen for: { type: 'ap-cache-updated', key: '...' }.
   - Pages no longer need their own setInterval polling loop — they just
     keep their existing `window.addEventListener('message', ...)` and
     react when told.

   How to use it in index.html:
     <script src="cacheWatcher.js"></script>
     <script>
       AP2CacheWatcher.init({
         getFrames: () => document.querySelectorAll('iframe')
       });
     </script>

   If dataLayer.js writes fresh data and wants to notify immediately
   (instead of waiting up to 30s for the next poll), it can call:
     AP2CacheWatcher.notifyNow('ap2_employee');
   ═══════════════════════════════════════════════════════════════════════ */

(function (global) {
  const _IDB_NAME   = 'ap2_fleet_cache';
  const _IDB_STORE  = 'datasets';
  const POLL_MS     = 30000;

  let _idbConn      = null;
  let _getFrames    = () => [];   // function supplied by index.html to find child iframes
  let _fingerprints = {};         // key -> lightweight snapshot used to detect change
  let _pollTimer    = null;
  let _started      = false;

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

  function _broadcast(key) {
    const frames = _getFrames() || [];
    frames.forEach(f => {
      try {
        f.contentWindow && f.contentWindow.postMessage({ type: 'ap-cache-updated', key }, '*');
      } catch (e) { /* ignore cross-origin / not-ready iframes */ }
    });
    // Also fire locally in case the parent page itself needs to react
    window.dispatchEvent(new CustomEvent('ap-cache-updated', { detail: { key } }));
  }

  async function _checkAll() {
    try {
      const db   = await _getDB();
      const keys = await _allKeys(db);
      for (const key of keys) {
        const rec = await _getRecord(db, key);
        const fp  = _fingerprint(rec);
        if (_fingerprints[key] !== undefined && _fingerprints[key] !== fp) {
          _broadcast(key);
        }
        _fingerprints[key] = fp;
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
  }

  // Manual trigger — call this right after a write so pages don't wait for the next poll
  function notifyNow(key) {
    _broadcast(key);
  }

  global.AP2CacheWatcher = { init, notifyNow };
})(window);
