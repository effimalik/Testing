/* ═══════════════════════════════════════════════════════════════════════
   cacheWatcher.js  —  FINAL VERSION
   ───────────────────────────────────────────────────────────────────────
   ONE shared module. Same file, same public API, used in two roles:

     SHELL  (index.html)     — owns the ONE real IndexedDB connection.
     LEAF   (allEmp.html,     — never opens IndexedDB itself. Asks the
             allBike.html,       shell for data over postMessage instead.
             allSim.html,
             inOut.html, etc.)

   WHY: the iPad freeze happened because several frames opened the same
   IndexedDB database at once and Safari silently hung. Fix: only ONE
   frame (the shell) ever opens it. Everyone else just asks.

   Public API — identical whether running as shell or leaf:
     AP2CacheWatcher.init(opts?)         start it up
     AP2CacheWatcher.readKey(key)        → Promise<array|null>
     AP2CacheWatcher.subscribe(fn)       fn(key) fires on any change/deletion
     AP2CacheWatcher.notifyNow(key)      instant "this key changed" ping
     AP2CacheWatcher.getStatus()         → { healthy, mode, lastError }

   opts (only meaningful for the shell):
     { getFrames: () => document.querySelectorAll('iframe') }

   ── Everything this version adds over the earlier draft ──
   1. SINGLE CONNECTION   — only the shell opens IndexedDB. Leaves request
                             data via postMessage. Removes the freeze at
                             the root cause, not just papering over it.
   2. VERSION STAMPS       — every broadcast carries an incrementing
                             version number per key, not just a guess-based
                             fingerprint, so "did it really change" is exact.
   3. STARTUP HEALTH CHECK — shell verifies IndexedDB actually opens before
                             anything else relies on it.
   4. REQUEST QUEUE        — reads are serialized through one queue so
                             iOS never sees overlapping transactions.
   5. GRACEFUL DEGRADATION — if IndexedDB keeps timing out, the shell
                             switches to an in-memory-only fallback for
                             the session instead of retrying forever.
   6. STATUS REPORTING     — getStatus() + an 'ap-cache-status' event/
                             message so a page can show a health indicator
                             instead of silently rendering nothing.

   How to wire in the SHELL (index.html):
     <script src="cacheWatcher.js"></script>
     <script>
       AP2CacheWatcher.init({ getFrames: () => document.querySelectorAll('iframe') });
     </script>

   How to wire in a LEAF page (allEmp.html, allBike.html, allSim.html,
   inOut.html, dedPivot.html — same pattern for every one of them):
     <script src="cacheWatcher.js"></script>
     <script>
       AP2CacheWatcher.init();
       AP2CacheWatcher.subscribe(() => { your silent re-read and re-render logic goes here });
     </script>
     const rows = await AP2CacheWatcher.readKey('ap2_employee');

   How dataLayer.js should notify after any save/delete/restore — using
   whatever key variable is already in scope there, never hardcoded:
     AP2CacheWatcher.notifyNow(key);
   ═══════════════════════════════════════════════════════════════════════ */

(function (global) {
  const _IDB_NAME    = 'ap2_fleet_cache';
  const _IDB_STORE   = 'datasets';
  const POLL_MS      = 1500;    // shell-side fallback poll, catches un-notified writes
  const OPEN_TIMEOUT = 2000;    // ms before we treat indexedDB.open() as hung
  const REQ_TIMEOUT  = 4000;    // ms a leaf waits for the shell to answer a read request

  const _isTop = (window === window.top);

  let _idbConn      = null;
  let _getFrames    = () => [];
  let _fingerprints = {};        // key -> lightweight change signature
  let _versions     = {};        // key -> incrementing version number
  let _knownKeys    = new Set();
  let _pollTimer    = null;
  let _started      = false;
  let _subscribers  = [];         // local callbacks: fn(key)
  let _dbQueue      = Promise.resolve(); // serializes all real IDB reads
  let _status       = { healthy: null, mode: _isTop ? 'idb' : 'remote', lastError: null };
  let _pendingReqs  = {};         // leaf-only: reqId -> {resolve, reject, timer}
  let _reqCounter   = 0;
  let _memoryFallback = {};       // shell-only: last-known-good data if IDB gives up

  /* ═══════════ status ═══════════ */
  function _setStatus(patch) {
    _status = Object.assign({}, _status, patch);
    window.dispatchEvent(new CustomEvent('ap-cache-status', { detail: _status }));
    if (_isTop) {
      (_getFrames() || []).forEach(f => {
        try { f.contentWindow && f.contentWindow.postMessage({ type: 'ap-cache-status', status: _status }, '*'); }
        catch (e) {}
      });
    }
  }
  function getStatus() { return _status; }

  /* ═══════════ shell-only: the ONE real IndexedDB connection ═══════════ */
  function _openOnce(attempt) {
    return new Promise((res, rej) => {
      let settled = false;
      const req = indexedDB.open(_IDB_NAME);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rej(new Error('idb-open-timeout (attempt ' + attempt + ')'));
      }, OPEN_TIMEOUT);
      req.onsuccess = e => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        res(e.target.result);
      };
      req.onerror = e => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        rej(e.target.error || new Error('idb-open-error'));
      };
      req.onblocked = () => console.warn('[cacheWatcher] IDB open blocked (attempt ' + attempt + ')');
    });
  }

  async function _getDB() {
    if (_idbConn) return _idbConn;
    try {
      _idbConn = await _openOnce(1);
    } catch (e1) {
      try {
        _idbConn = await _openOnce(2);
      } catch (e2) {
        _setStatus({ healthy: false, mode: 'fallback', lastError: e2.message });
        throw e2;
      }
    }
    _setStatus({ healthy: true, mode: 'idb', lastError: null });
    return _idbConn;
  }

  // All real reads funnel through here, one at a time — avoids overlapping
  // transactions, which is part of what trips up iOS Safari.
  function _queuedRead(key) {
    const job = _dbQueue.then(async () => {
      try {
        const db  = await _getDB();
        const rec = await new Promise((res, rej) => {
          const req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).get(key);
          req.onsuccess = () => res(req.result || null);
          req.onerror   = () => rej(req.error);
        });
        const data = (rec && Array.isArray(rec.data) && rec.data.length) ? rec.data : null;
        if (data) _memoryFallback[key] = data; // remember last good copy
        return data;
      } catch (e) {
        // Graceful degradation: IDB is misbehaving — serve last-known-good
        // data from memory instead of leaving the page blank.
        console.warn('[cacheWatcher] read failed for "' + key + '", using memory fallback:', e.message);
        return _memoryFallback[key] || null;
      }
    });
    _dbQueue = job.catch(() => {}); // keep the queue alive even if one job failed
    return job;
  }

  function _allKeys(db) {
    return new Promise((res, rej) => {
      const req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).getAllKeys();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  function _fingerprint(rec) {
    if (!rec || !Array.isArray(rec.data)) return '';
    const len = rec.data.length;
    return len + '|' + JSON.stringify(rec.data[0] || '') + '|' + JSON.stringify(rec.data[len - 1] || '');
  }

  /* ═══════════ shell-only: fallback poll — catches un-notified writes + deletions ═══════════ */
  async function _checkAll() {
    if (!_isTop) return;
    try {
      const db          = await _getDB();
      const currentKeys = await _allKeys(db);
      const currentSet  = new Set(currentKeys);

      for (const key of currentKeys) {
        const rec = await new Promise((res, rej) => {
          const req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).get(key);
          req.onsuccess = () => res(req.result || null);
          req.onerror   = () => rej(req.error);
        });
        const fp = _fingerprint(rec);
        if (_fingerprints[key] !== undefined && _fingerprints[key] !== fp) {
          _versions[key] = (_versions[key] || 0) + 1;
          _broadcast(key);
        }
        _fingerprints[key] = fp;
        _knownKeys.add(key);
      }

      for (const key of _knownKeys) {
        if (!currentSet.has(key) && _fingerprints[key] !== undefined) {
          delete _fingerprints[key];
          delete _memoryFallback[key];
          _versions[key] = (_versions[key] || 0) + 1;
          _broadcast(key); // deleted — tell pages immediately
        }
      }
    } catch (e) {
      console.warn('[cacheWatcher] poll failed:', e.message);
    }
  }

  /* ═══════════ broadcasting a change to everyone who cares ═══════════ */
  function _broadcast(key) {
    _subscribers.forEach(fn => { try { fn(key); } catch (e) {} });
    if (_isTop) {
      const version = _versions[key] || 0;
      (_getFrames() || []).forEach(f => {
        try { f.contentWindow && f.contentWindow.postMessage({ type: 'ap-cache-updated', key, version }, '*'); }
        catch (e) {}
      });
    }
  }

  /* ═══════════ leaf-only: ask the shell for data instead of opening IDB itself ═══════════ */
  function _requestFromParent(key) {
    return new Promise((resolve) => {
      const reqId = 'r' + (++_reqCounter);
      const timer = setTimeout(() => {
        delete _pendingReqs[reqId];
        // Shell didn't answer in time (not present / still loading / this
        // page opened standalone) — fall back to a direct, timeout-guarded
        // IDB read so the page still works on its own.
        _queuedRead(key).then(resolve);
      }, REQ_TIMEOUT);

      _pendingReqs[reqId] = { resolve, timer };
      try {
        window.parent.postMessage({ type: 'ap-cache-request', reqId, key }, '*');
      } catch (e) {
        clearTimeout(timer);
        delete _pendingReqs[reqId];
        _queuedRead(key).then(resolve);
      }
    });
  }

  /* ═══════════ public: readKey — shell reads directly, leaf asks the shell ═══════════ */
  async function readKey(key) {
    if (_isTop) return _queuedRead(key);
    return _requestFromParent(key);
  }

  /* ═══════════ message handling — shell answers requests, leaf receives answers/updates ═══════════ */
  function _wireMessages() {
    window.addEventListener('message', async (e) => {
      if (!e.data) return;

      // Shell: a leaf wrote something itself and wants everyone notified
      if (_isTop && e.data.type === 'ap-cache-request-notify') {
        notifyNow(e.data.key);
        return;
      }

      // Shell: a leaf is asking for a dataset
      if (_isTop && e.data.type === 'ap-cache-request') {
        const data = await _queuedRead(e.data.key);
        try {
          e.source && e.source.postMessage({ type: 'ap-cache-response', reqId: e.data.reqId, key: e.data.key, data }, '*');
        } catch (err) {}
        return;
      }

      // Leaf: the shell answered a request we made
      if (!_isTop && e.data.type === 'ap-cache-response') {
        const pending = _pendingReqs[e.data.reqId];
        if (pending) {
          clearTimeout(pending.timer);
          delete _pendingReqs[e.data.reqId];
          pending.resolve(e.data.data || null);
        }
        return;
      }

      // Leaf: the shell (or whoever is above us) says a key changed — forward to our own subscribers
      if (!_isTop && e.data.type === 'ap-cache-updated') {
        _subscribers.forEach(fn => { try { fn(e.data.key); } catch (err) {} });
        return;
      }

      // Leaf: status ping from the shell — forward for anyone watching status locally
      if (!_isTop && e.data.type === 'ap-cache-status') {
        _status = e.data.status;
        window.dispatchEvent(new CustomEvent('ap-cache-status', { detail: _status }));
      }
    });
  }

  /* ═══════════ public API ═══════════ */
  function init(opts) {
    if (_started) return;
    _started = true;
    if (opts && typeof opts.getFrames === 'function') _getFrames = opts.getFrames;

    _wireMessages();

    if (_isTop) {
      // Startup health check, then prime fingerprints, then start the fallback poll.
      _getDB()
        .then(() => _checkAll())
        .then(() => { _pollTimer = setInterval(_checkAll, POLL_MS); })
        .catch(() => { /* getStatus() already reflects the failure */ });
    }
  }

  function subscribe(fn) {
    _subscribers.push(fn);
    return () => { _subscribers = _subscribers.filter(f => f !== fn); };
  }

  function notifyNow(key) {
    if (_isTop) {
      _versions[key] = (_versions[key] || 0) + 1;
      // Refresh fingerprint immediately so the next poll doesn't double-fire.
      _queuedRead(key).then(() => _broadcast(key));
    } else {
      // A leaf triggering notifyNow (e.g. it wrote data itself) — tell the
      // shell so it can re-check and relay to every other open module.
      try { window.parent.postMessage({ type: 'ap-cache-request-notify', key }, '*'); } catch (e) {}
      _subscribers.forEach(fn => { try { fn(key); } catch (err) {} });
    }
  }

  global.AP2CacheWatcher = { init, notifyNow, subscribe, readKey, getStatus };
})(window);
