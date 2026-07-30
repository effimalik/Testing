/* ════════════════════════════════════════════════════════════════
   row-actions.js
   ────────────────────────────────────────────────────────────────
   Everything needed for the row action buttons (View / Advance /
   History) lives in this ONE file:
     1. SidePanel   — the shared right-side sliding "window" engine
     2. "view"      — employee profile + inline edit
     3. "adv"       — advance salary request form
     4. "hist"      — company/bike/SIM check-out-in history

   HOW TO ADD A NEW ROW BUTTON:
     1. In allEmp.html's table row markup, add:
          <button data-action="myAction" data-emp-id="${emp.id}">…</button>
     2. Anywhere below in this file, call:
          SidePanel.register('myAction', {
            open(empId)  { // build header/body/footer, then show it
            },
            close()      { // optional cleanup when panel is closed
            }
          });
   Nothing in allEmp.html's click handler or panel shell needs to change.
   ════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────
   1. PANEL CORE — shared engine
   ───────────────────────────────────────────────────────────── */
(function () {
  const registry = {};

  const SidePanel = {
    currentAction: null,
    currentEmpId: null,

    /* Called once by each action file to plug itself into the panel. */
    register(action, handler) {
      registry[action] = handler;
    },

    /* Called by the row-button click handler (and anywhere else, e.g.
       a "History" shortcut button inside the View panel). */
    open(action, empId) {
      const handler = registry[action];
      if (!handler) {
        console.warn('[SidePanel] No handler registered for action "' + action + '".');
        return;
      }
      // Clean up whatever the previously-open action was doing.
      if (SidePanel.currentAction && registry[SidePanel.currentAction]) {
        registry[SidePanel.currentAction].close?.();
      }
      SidePanel.currentAction = action;
      SidePanel.currentEmpId  = empId;
      document.getElementById('side-panel').classList.add('open');
      handler.open(empId);
    },

    close() {
      if (SidePanel.currentAction && registry[SidePanel.currentAction]) {
        registry[SidePanel.currentAction].close?.();
      }
      document.getElementById('side-panel')?.classList.remove('open');
      SidePanel.currentAction = null;
      SidePanel.currentEmpId  = null;
    },

    /* ── Shared header helper — every action shows an avatar / name /
       sub-line / optional badge, so the window really is "shared"
       rather than three different-looking windows. ── */
    setHeader({ avatarText = '', avatarStyle = '', name = '—', sub = '—', badge = null } = {}) {
      const av = document.getElementById('sp-avatar');
      if (av) { av.style.cssText = avatarStyle; av.textContent = avatarText; }
      const nameEl = document.getElementById('sp-name'); if (nameEl) nameEl.textContent = name;
      const subEl  = document.getElementById('sp-sub');  if (subEl)  subEl.textContent  = sub;
      const badgeEl = document.getElementById('sp-badge');
      if (badgeEl) {
        if (badge) {
          badgeEl.style.display = '';
          badgeEl.className   = 'dp-status-badge ' + (badge.className || '');
          badgeEl.textContent = badge.text || '';
        } else {
          badgeEl.style.display = 'none';
        }
      }
    },

    body()   { return document.getElementById('sp-body'); },
    footer() { return document.getElementById('sp-footer'); },
    setBody(html)   { const el = SidePanel.body();   if (el) el.innerHTML = html; },
    setFooter(html) { const el = SidePanel.footer(); if (el) el.innerHTML = html; },
  };

  window.SidePanel = SidePanel;
  // Back-compat alias — some inline HTML (backdrop click, close icon) uses this name.
  window.closeSidePanel = SidePanel.close;
})();

/* ─────────────────────────────────────────────────────────────
   2. VIEW ACTION
   ───────────────────────────────────────────────────────────── */
const EMIRATE_OPTS = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ras Al Khaimah', 'Ajman', 'Fujairah', 'Umm Al Quwain'];

function _viewFooterHTML() {
  return `
    <button class="dp-btn dp-btn-secondary" onclick="SidePanel.close()"><i class="ti ti-x"></i> Close</button>
    <button class="dp-btn" style="background:var(--accent-dim);color:var(--accent);border-color:var(--accent);" id="dp-hist-btn" onclick="SidePanel.open('hist', SidePanel.currentEmpId)"><i class="ti ti-history"></i> History</button>
    <button class="dp-btn dp-btn-edit"   id="dp-edit-btn"   onclick="_dpEnterEdit()"><i class="ti ti-pencil"></i> Edit</button>
    <button class="dp-btn dp-btn-save"   id="dp-save-btn"   onclick="_dpSave()" style="display:none;"><i class="ti ti-device-floppy"></i> Save</button>
    <button class="dp-btn dp-btn-cancel" id="dp-cancel-btn" onclick="_dpCancelEdit()" style="display:none;"><i class="ti ti-arrow-back-up"></i> Cancel</button>`;
}

async function viewEmployee(empId) {
  const emp = employees.find(e => String(e.id) === String(empId));
  if (!emp) return;

  const idx      = employees.indexOf(emp);
  const avBg     = AV_BG2[idx % AV_BG2.length];
  const avFg     = AV_FG [idx % AV_FG.length];
  const initials = (emp.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const ex       = emp.expiry || {};
  const overall  = calcOverall(ex);
  const stBadge  = overall === 'expired' ? 'dp-badge-red' : overall === 'expiring_soon' ? 'dp-badge-amber' : 'dp-badge-green';
  const stLabels = { valid: 'Valid', expiring_soon: 'Expiring Soon', expired: 'Expired' };

  SidePanel.setHeader({
    avatarText: initials,
    avatarStyle: `background:${avBg};color:${avFg};`,
    name: emp.name || '—',
    sub: emp.eid ? 'EID: ' + emp.eid : 'No EID on record',
    badge: { text: stLabels[overall] || overall, className: stBadge },
  });

  SidePanel.setBody(`<div class="dp-loading"><div class="dp-spinner"></div><span>Loading details…</span></div>`);
  SidePanel.setFooter(_viewFooterHTML());
  _renderEmpDetail(emp, ex);
}

function _renderEmpDetail(emp, ex) {
  if (SidePanel.currentAction !== 'view') return;
  function fmtDate(d) {
    if (!d) return '<span style="color:var(--text3);">—</span>';
    try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d; }
  }
  function exCard(label, exObj) {
    const s    = exObj?.status || 'not_available';
    const d    = exObj?.date   || null;
    const cls  = s === 'valid' ? 'dp-ex-valid' : s === 'expired' ? 'dp-ex-expired' : s === 'expiring_soon' ? 'dp-ex-expiring' : 'dp-ex-na';
    const icon = s === 'valid' ? 'ti-circle-check' : s === 'expired' ? 'ti-alert-triangle' : s === 'expiring_soon' ? 'ti-clock' : 'ti-circle-off';
    const lbl  = s === 'valid' ? 'Valid' : s === 'expired' ? 'Expired' : s === 'expiring_soon' ? 'Expiring' : 'No Data';
    return `<div class="dp-ex-card ${cls}"><i class="ti ${icon} dp-ex-icon"></i><div class="dp-ex-label">${label}</div><div class="dp-ex-status">${lbl}</div><div class="dp-ex-date">${d ? fmtDate(d) : '—'}</div></div>`;
  }
  const html = `
    <div class="dp-section">
      <div class="dp-section-title"><i class="ti ti-user"></i> Personal Information</div>
      <div class="dp-fields" id="dp-emp-fields">
        <div class="dp-field"><span class="dp-fl">Emp ID</span><span class="dp-fv dp-mono">${emp.id || '—'}</span></div>
        <div class="dp-field"><span class="dp-fl">Full Name</span><span class="dp-fv" data-field="name" data-type="text">${emp.name || '—'}</span></div>
        <div class="dp-field"><span class="dp-fl">EID Number</span><span class="dp-fv dp-mono" data-field="eid" data-type="text">${emp.eid || '—'}</span></div>
        <div class="dp-field"><span class="dp-fl">Date of Birth</span><span class="dp-fv">${fmtDate(emp.dob)}</span></div>
        <div class="dp-field"><span class="dp-fl">UAE Mobile</span><span class="dp-fv dp-mono" data-field="mobile" data-type="tel">${emp.mobile || '—'}</span></div>
        <div class="dp-field"><span class="dp-fl">Emergency</span><span class="dp-fv dp-mono" data-field="mobilePak" data-type="tel">${emp.mobilePak || emp.emergency || '—'}</span></div>
        <div class="dp-field"><span class="dp-fl">Reference</span><span class="dp-fv" data-field="ref" data-type="text">${emp.ref || emp.reference || '—'}</span></div>
        <div class="dp-field"><span class="dp-fl">HR Status</span><span class="dp-fv">${emp.hrStatus ? `<span class="dp-badge-accent">${emp.hrStatus}</span>` : '—'}</span></div>
        <div class="dp-field"><span class="dp-fl">CO Exception</span><span class="dp-fv">${emp.checkoutException || '—'}</span></div>
      </div>
    </div>
    <div class="dp-section">
      <div class="dp-section-title"><i class="ti ti-calendar-stats"></i> Document Expiry</div>
      <div class="dp-ex-grid">
        ${exCard('EID', ex.eid)}
        ${exCard('Licence', ex.license)}
        ${exCard('Labour', ex.labour)}
        ${exCard('Insurance', ex.insurance)}
      </div>
      <div class="dp-fields" style="margin-top:6px;">
        <div class="dp-field" style="display:none;" data-edit-row="eidExp"><span class="dp-fl">EID Expiry</span><span class="dp-fv dp-mono" data-field="eidExp" data-type="date">${ex.eid?.date || '—'}</span></div>
        <div class="dp-field" style="display:none;" data-edit-row="licExpiry"><span class="dp-fl">Licence Expiry</span><span class="dp-fv dp-mono" data-field="licExpiry" data-type="date">${ex.license?.date || '—'}</span></div>
        <div class="dp-field" style="display:none;" data-edit-row="labourExpiry"><span class="dp-fl">Labour Expiry</span><span class="dp-fv dp-mono" data-field="labourExpiry" data-type="date">${ex.labour?.date || '—'}</span></div>
        <div class="dp-field" style="display:none;" data-edit-row="insExpiry"><span class="dp-fl">Insurance Expiry</span><span class="dp-fv dp-mono" data-field="insExpiry" data-type="date">${ex.insurance?.date || '—'}</span></div>
      </div>
    </div>`;
  SidePanel.setBody(html);
}

function _dpResetButtons() {
  const editBtn = document.getElementById('dp-edit-btn'), saveBtn = document.getElementById('dp-save-btn'), cancelBtn = document.getElementById('dp-cancel-btn');
  if (editBtn)   editBtn.style.display   = '';
  if (saveBtn)   saveBtn.style.display   = 'none';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

function _dpEnterEdit() {
  document.querySelectorAll('#sp-body [data-field]').forEach(span => {
    const field = span.dataset.field, type = span.dataset.type || 'text';
    const rawVal = span.textContent.trim() === '—' ? '' : span.textContent.trim();
    let inp;
    if (type === 'date') {
      inp = document.createElement('input'); inp.type = 'date';
      try { const d = new Date(rawVal); if (!isNaN(d)) inp.value = d.toISOString().split('T')[0]; } catch (e) {}
      if (!inp.value) inp.value = rawVal;
    } else if (type === 'select-emirate') {
      inp = document.createElement('select');
      EMIRATE_OPTS.forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; if (o === rawVal) opt.selected = true; inp.appendChild(opt); });
    } else {
      inp = document.createElement('input'); inp.type = type; inp.value = rawVal;
    }
    inp.dataset.field = field; inp.className = 'dp-edit-input';
    span.replaceWith(inp);
  });
  const editBtn = document.getElementById('dp-edit-btn'), saveBtn = document.getElementById('dp-save-btn'), cancelBtn = document.getElementById('dp-cancel-btn');
  if (editBtn)   editBtn.style.display   = 'none';
  if (saveBtn)   saveBtn.style.display   = '';
  if (cancelBtn) cancelBtn.style.display = '';
  document.querySelectorAll('[data-edit-row]').forEach(r => r.style.display = '');
}

function _dpCancelEdit() {
  const emp = employees.find(e => String(e.id) === String(SidePanel.currentEmpId));
  if (emp) _renderEmpDetail(emp, emp.expiry || {});
  _dpResetButtons();
}

async function _dpSave() {
  const saveBtn = document.getElementById('dp-save-btn');
  saveBtn.disabled = true; saveBtn.innerHTML = '<i class="ti ti-loader-2"></i> Saving…';
  const vals = {};
  document.querySelectorAll('#sp-body [data-field]').forEach(inp => { vals[inp.dataset.field] = inp.value; });

  const emp = employees.find(e => String(e.id) === String(SidePanel.currentEmpId));
  if (!emp) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="ti ti-device-floppy"></i> Save'; return; }

  if (vals.name         !== undefined) emp.name      = vals.name;
  if (vals.eid          !== undefined) emp.eid       = vals.eid;
  if (vals.mobile       !== undefined) emp.mobile    = vals.mobile;
  if (vals.mobilePak    !== undefined) emp.mobilePak = vals.mobilePak;
  if (vals.ref          !== undefined) emp.ref       = vals.ref;
  if (vals.eidExp       !== undefined) { emp.eidExp = vals.eidExp; emp.expiry.eid = computeExpiry(vals.eidExp); }
  if (vals.licExpiry    !== undefined) emp.expiry.license  = computeExpiry(vals.licExpiry);
  if (vals.labourExpiry !== undefined) emp.expiry.labour   = computeExpiry(vals.labourExpiry);
  if (vals.insExpiry    !== undefined) emp.expiry.insurance = computeExpiry(vals.insExpiry);

  renderEmpTable(employees);
  _dpResetButtons(); _renderEmpDetail(emp, emp.expiry || {});

  toast('Employee saved.');
  saveBtn.disabled = false; saveBtn.innerHTML = '<i class="ti ti-device-floppy"></i> Save';
}

SidePanel.register('view', {
  open(empId) { viewEmployee(empId); },
  close() { /* nothing to persist — next open re-renders from scratch */ },
});

/* ─────────────────────────────────────────────────────────────
   3. ADVANCE ACTION
   ───────────────────────────────────────────────────────────── */
const ADV_REF_KEY = 'advPortalRefSeq';
let _advState = { empId: null, isException: false };

function advGenRef() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const dd  = String(now.getDate()).padStart(2, '0');
  const hh  = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss  = String(now.getSeconds()).padStart(2, '0');
  const ms  = String(now.getMilliseconds()).padStart(3, '0');
  return `ADV-${yyyy}${mm}${dd}-${hh}${min}${ss}${ms}`;
}

function advFmt(n) { return Number(n).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function advSubmitToGoogleForm(ref, empId, amount, installments, returnMonthsList, forMonth, reason, eidNo, empName) {
  const FORM_ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSdk9P7t7zXGmAppTB0BhL5TvisDCHtsmXhv9jq6QOh0Qz6HAQ/formResponse';
  const body = new FormData();
  const fields = { 'entry.1370945224': ref, 'entry.1724987333': String(empId), 'entry.1726107212': String(amount), 'entry.2138931162': String(installments), 'entry.2022826562': returnMonthsList, 'entry.877659064': forMonth, 'entry.1496219485': reason, 'entry.1046987198': String(eidNo), 'entry.1315477278': String(empName) };
  Object.entries(fields).forEach(([k, v]) => body.append(k, v));
  fetch(FORM_ACTION, { method: 'POST', mode: 'no-cors', body });
}

/* ── Visa validity helpers ── */
function _visaMonthsRemaining(emp) {
  const ex = emp.expiry || {};
  const dates = [ex.eid, ex.license, ex.labour, ex.insurance]
    .filter(d => d && d.date && d.status !== 'not_available')
    .map(d => new Date(d.date))
    .filter(d => !isNaN(d));
  if (!dates.length) return 0;
  const earliest = new Date(Math.min(...dates));
  const now = new Date();
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  if (earliest < startOfNextMonth) return 0;
  const diffMs = earliest - startOfNextMonth;
  const diffMonths = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.4375)) + 1;
  return Math.max(0, diffMonths);
}

function _advFooterHTML() {
  return `
    <button class="dp-btn dp-btn-secondary" onclick="SidePanel.close()"><i class="ti ti-x"></i> Cancel</button>
    <button class="dp-btn dp-btn-edit" style="background:var(--accent);color:#fff;border-color:var(--accent);" onclick="advSubmitRequest()"><i class="ti ti-send"></i> Submit Request</button>`;
}

function openAdvModal(empId) {
  const emp = employees.find(e => String(e.id) === String(empId));
  if (!emp) return;
  const overall = calcOverall(emp.expiry || {});
  const hasHROverride = !!(emp.hrStatus && emp.hrStatus.trim());
  const hasCOOverride = !!(emp.checkoutException && emp.checkoutException.trim());
  const isException   = overall === 'expired' && (hasHROverride || hasCOOverride);

  if (overall === 'expired' && !hasHROverride && !hasCOOverride) {
    toast('Advance unavailable — employee documents are expired.', 'error');
    SidePanel.close();
    return;
  }

  let availableMonths;
  if (isException) {
    availableMonths = 1;
  } else {
    const visaMonths = _visaMonthsRemaining(emp);
    availableMonths = Math.min(visaMonths, 5);
    if (availableMonths < 1) availableMonths = 1;
  }
  _advState = { empId: emp.id, isException };

  const idx      = employees.indexOf(emp);
  const avBg     = AV_BG2[idx % AV_BG2.length];
  const avFg     = AV_FG [idx % AV_FG.length];
  const initials = (emp.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  SidePanel.setHeader({
    avatarText: initials,
    avatarStyle: `background:${avBg};color:${avFg};`,
    name: emp.name || '—',
    sub: emp.eid ? 'EID: ' + emp.eid : 'No EID on record',
    badge: { text: 'Advance Request', className: 'dp-badge-purple' },
  });

  const now = new Date();
  let monthOptions = '';
  for (let i = 0; i < availableMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    monthOptions += `<option value="${d.toISOString().slice(0, 7)}"${i === 0 ? ' selected' : ''}>${d.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</option>`;
  }

  let repayOptions = '';
  if (isException) {
    repayOptions = '<option value="1">1 Month — Next Month Deduction (Exception)</option>';
  } else {
    repayOptions = '<option value="0">No Installments (Full Lump-Sum Deduction)</option>';
    for (let m = 1; m <= availableMonths; m++) {
      const lbl = m === 1 ? '1 Month — Next Salary Deduction' : `${m} Monthly Installments`;
      repayOptions += `<option value="${m}">${lbl}</option>`;
    }
  }

  const visaInfoHTML = isException
    ? `<div id="m-visa-info" style="margin:-8px 0 14px;padding:7px 12px;border-radius:8px;font-size:11.5px;font-weight:600;display:flex;align-items:center;gap:7px;background:var(--amber-dim);color:var(--amber);border:1px solid var(--amber);"><i class="ti ti-alert-triangle" style="font-size:15px;flex-shrink:0;"></i> Exception override active — 1 month only, next month deduction enforced.</div>`
    : `<div id="m-visa-info" style="margin:-8px 0 14px;padding:7px 12px;border-radius:8px;font-size:11.5px;font-weight:600;display:flex;align-items:center;gap:7px;background:var(--teal-dim);color:var(--teal);border:1px solid var(--teal);"><i class="ti ti-shield-check" style="font-size:15px;flex-shrink:0;"></i> Visa valid for ~${availableMonths} month${availableMonths !== 1 ? 's' : ''} — advance months and repayment limited accordingly.</div>`;

  SidePanel.setBody(`
    <div class="dp-section">
      <input type="hidden" id="m-eid-hidden" value="${emp.eid || ''}" />
      <input type="hidden" id="m-empname-hidden" value="${emp.name || ''}" />
      <div class="field">
        <label>Advance Month <span style="color:var(--red);">*</span></label>
        <select id="m-month">${monthOptions}</select>
      </div>
      ${visaInfoHTML}
      <div class="field">
        <label>Advance Amount (AED) <span style="color:var(--red);">*</span></label>
        <input type="number" id="m-amount" placeholder="e.g. 2500" min="1" step="0.01" oninput="advUpdateRepayPreview()" />
      </div>
      <div class="field">
        <label>Repayment Plan</label>
        <select id="m-repay" onchange="advUpdateRepayPreview()" ${isException ? 'disabled' : ''}>${repayOptions}</select>
      </div>
      <div id="adv-repay-preview" style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:12px 14px;font-size:12.5px;color:var(--text2);margin-bottom:14px;display:none;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--text3);margin-bottom:8px;">Installment Breakdown</div>
        <div id="adv-repay-lump-msg" style="display:none;color:var(--amber);font-weight:600;"><i class="ti ti-cash" style="font-size:14px;vertical-align:middle;"></i> Full amount deducted in one lump sum from next salary</div>
        <div id="adv-repay-split-wrap">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px;">
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;text-align:center;">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:3px;">Monthly</div>
              <div style="font-size:15px;font-weight:700;font-family:var(--mono);color:var(--teal);" id="adv-repay-monthly">AED 0.00</div>
            </div>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;text-align:center;">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:3px;">Months</div>
              <div style="font-size:15px;font-weight:700;font-family:var(--mono);color:var(--purple);" id="adv-repay-months">0</div>
            </div>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;text-align:center;">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:3px;">Total</div>
              <div style="font-size:15px;font-weight:700;font-family:var(--mono);color:var(--accent);" id="adv-repay-total">AED 0.00</div>
            </div>
          </div>
          <div id="adv-repay-inst-pills" style="display:flex;flex-wrap:wrap;gap:5px;"></div>
        </div>
      </div>
      <div class="field">
        <label>Reason for Advance <span style="color:var(--red);">*</span></label>
        <textarea id="m-reason" rows="3" placeholder="State the reason for this advance salary request..." style="resize:vertical;"></textarea>
      </div>
    </div>`);
  SidePanel.setFooter(_advFooterHTML());
  advUpdateRepayPreview();
}

function advUpdateRepayPreview() {
  const amt    = parseFloat(document.getElementById('m-amount').value) || 0;
  const months = parseInt(document.getElementById('m-repay').value) || 0;
  const prev   = document.getElementById('adv-repay-preview');
  const lump   = document.getElementById('adv-repay-lump-msg');
  const split  = document.getElementById('adv-repay-split-wrap');
  if (amt > 0) {
    prev.style.display = 'block';
    if (months === 0) { lump.style.display = 'block'; split.style.display = 'none'; }
    else {
      lump.style.display = 'none'; split.style.display = 'block';
      const monthly = amt / months;
      document.getElementById('adv-repay-monthly').textContent = 'AED ' + advFmt(monthly);
      document.getElementById('adv-repay-months').textContent  = months;
      document.getElementById('adv-repay-total').textContent   = 'AED ' + advFmt(amt);
      const pills = document.getElementById('adv-repay-inst-pills');
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      pills.innerHTML = Array.from({ length: months }, (_, i) => {
        const last = i === months - 1;
        const installAmt = last ? amt - (Math.round(monthly * 100) / 100) * (months - 1) : Math.round(monthly * 100) / 100;
        const due = new Date(start.getFullYear(), start.getMonth() + i, 1);
        return `<span style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-size:11px;font-family:var(--mono);color:var(--accent);display:inline-flex;gap:5px;align-items:center;"><span style="color:var(--text3);font-size:10px;">#${i + 1}</span> AED ${advFmt(installAmt)}<span style="color:var(--text2);font-size:10px;">→ ${due.toLocaleString('en-GB', { month: 'short', year: 'numeric' })}</span></span>`;
      }).join('');
    }
  } else { prev.style.display = 'none'; }
}

function advSubmitRequest() {
  const empId    = _advState.empId;
  const amount   = document.getElementById('m-amount').value.trim();
  const reason   = document.getElementById('m-reason').value.trim();
  const forMonth = document.getElementById('m-month').value;
  const months   = parseInt(document.getElementById('m-repay').value);
  if (!forMonth) { toast('Please select the advance month.', 'error'); return; }
  if (!amount || isNaN(amount) || Number(amount) <= 0) { toast('Please enter a valid advance amount.', 'error'); return; }
  if (!reason) { toast('Please provide a reason for the request.', 'error'); return; }
  const ref = advGenRef();
  const eidNo   = document.getElementById('m-eid-hidden').value || '';
  const empName = document.getElementById('m-empname-hidden').value || '';
  const isException = _advState.isException;
  const effectiveMonths = isException ? 1 : (months === 0 ? 1 : months);
  const base = new Date(); base.setDate(1);
  const returnMonthsList = Array.from({ length: effectiveMonths }, (_, i) => { const d = new Date(base); d.setMonth(d.getMonth() + i + 1); return d.toLocaleString('en-GB', { month: 'short', year: 'numeric' }); }).join(', ');
  advSubmitToGoogleForm(ref, empId, Number(amount), months, returnMonthsList, forMonth, reason, eidNo, empName);
  const repayLabel = months === 0 ? 'No Installments (Lump-Sum)' : months === 1 ? 'Next Month Deduction' : months + ' Monthly Installments';
  SidePanel.close();
  toast(`Advance request ${ref} submitted — ${repayLabel} — AED ${Number(amount).toLocaleString()}`);
}

SidePanel.register('adv', {
  open(empId) { openAdvModal(empId); },
  close() { _advState = { empId: null, isException: false }; },
});

/* ─────────────────────────────────────────────────────────────
   4. HISTORY ACTION
   ───────────────────────────────────────────────────────────── */
let _histEmpId    = null;
let _histTab      = 'RiderHistory';
let _histTabCache = {};

const HIST_TAB_META = {
  RiderHistory: { id: 'htab-rider', cls: 'active-rider', label: 'Company / Route History', icon: 'ti-building',  col2: 'Company / Route', itemKey: 'company' },
  BikeHistory:  { id: 'htab-bike',  cls: 'active-bike',  label: 'Bike History',            icon: 'ti-motorbike', col2: 'Bike No',         itemKey: 'bike' },
  SimHistory:   { id: 'htab-sim',   cls: 'active-sim',   label: 'SIM History',             icon: 'ti-sim-card',  col2: 'SIM Number',      itemKey: 'sim' },
};

function _fmtCioDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const pad = n => String(n).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _histFooterHTML() {
  return `<button class="dp-btn dp-btn-secondary" onclick="SidePanel.close()"><i class="ti ti-x"></i> Close</button>`;
}

function openHistoryModal(empId) {
  const emp = employees.find(e => String(e.id) === String(empId));
  if (!emp) return;
  _histEmpId    = empId;
  _histTab      = 'RiderHistory';
  _histTabCache = {};

  const idx      = employees.indexOf(emp);
  const avBg     = AV_BG2[idx % AV_BG2.length];
  const avFg     = AV_FG [idx % AV_FG.length];
  const initials = (emp.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  SidePanel.setHeader({
    avatarText: initials,
    avatarStyle: `background:${avBg};color:${avFg};`,
    name: emp.name || '—',
    sub: `EMP #${emp.id}`,
    badge: { text: 'Work History', className: 'dp-badge-blue' },
  });

  SidePanel.setBody(`
    <div class="dp-section" style="padding-bottom:0;">
      <div class="hist-tabs">
        <button class="hist-tab active-rider" id="htab-rider" onclick="switchHistTab('RiderHistory')"><i class="ti ti-building"></i> Company / Route</button>
        <button class="hist-tab" id="htab-bike" onclick="switchHistTab('BikeHistory')"><i class="ti ti-motorbike"></i> Bike History</button>
        <button class="hist-tab" id="htab-sim"  onclick="switchHistTab('SimHistory')"><i class="ti ti-sim-card"></i> SIM History</button>
      </div>
      <div id="hist-content">
        <div class="hist-loading"><i class="ti ti-loader" style="font-size:24px;animation:spin 1s linear infinite;display:inline-flex;"></i><span>Loading history…</span></div>
      </div>
    </div>`);
  SidePanel.setFooter(_histFooterHTML());

  _loadHistoryTab('RiderHistory', empId);
}

function switchHistTab(type) {
  if (_histTab === type) return;
  _histTab = type;
  Object.values(HIST_TAB_META).forEach(m => {
    const el = document.getElementById(m.id);
    if (el) el.className = 'hist-tab';
  });
  const meta = HIST_TAB_META[type];
  if (meta) document.getElementById(meta.id).className = 'hist-tab ' + meta.cls;
  _loadHistoryTab(type, _histEmpId);
}

async function _loadHistoryTab(type, empId) {
  const cacheKey = type + '_' + empId;
  const content  = document.getElementById('hist-content');
  const meta     = HIST_TAB_META[type];

  if (_histTabCache[cacheKey]) {
    _renderHistoryTable(meta, _histTabCache[cacheKey]);
    return;
  }

  content.innerHTML = `<div class="hist-loading"><i class="ti ti-loader" style="font-size:24px;animation:spin 1s linear infinite;display:inline-flex;"></i><span>Reading history…</span></div>`;

  try {
    const all    = await AP2CioView.buildIfStale();
    const empStr = String(empId);
    const pairs  = all.filter(r => String(r.empId) === empStr && r.itemType === meta.itemKey);
    _histTabCache[cacheKey] = pairs;
    _renderHistoryTable(meta, pairs);
  } catch (err) {
    content.innerHTML = `<div class="hist-loading" style="color:var(--red);"><i class="ti ti-database-off" style="font-size:24px;display:inline-flex;"></i><span>Failed to read history — ${err.message}</span></div>`;
  }
}

function _renderHistoryTable(meta, pairs) {
  const content = document.getElementById('hist-content');
  if (!content) return;

  if (!pairs.length) {
    content.innerHTML = `<div class="hist-loading"><i class="ti ti-inbox" style="font-size:26px;"></i><span>No ${meta.label.toLowerCase()} records found.</span></div>`;
    return;
  }

  const bandColors = ['transparent', 'var(--bg3)'];
  let lastItem = null, bandIdx = -1;

  const tableRows = pairs.map((p, i) => {
    if (p.item !== lastItem) { lastItem = p.item; bandIdx++; }
    const band = bandColors[bandIdx % 2];

    const showItem = (i === 0 || pairs[i - 1].item !== p.item);
    const rowsInGroup = pairs.filter(x => x.item === p.item).length;

    const itemCell = showItem
      ? `<td rowspan="${rowsInGroup}" style="font-weight:700;font-size:12px;color:var(--text);background:${band};vertical-align:top;padding-top:11px;border-right:1px solid var(--border);">${p.item}</td>`
      : '';

    const seqBadge = `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--accent-dim);color:var(--accent);font-size:10px;font-weight:700;flex-shrink:0;">${p.seq}</span>`;

    const coStr = p.checkOutDate ? _fmtCioDate(p.checkOutDate) : null;
    const coCell = coStr
      ? `<div style="font-family:var(--mono);font-size:11.5px;color:var(--amber);">${coStr.split('  ')[0]}</div><div style="font-family:var(--mono);font-size:10.5px;color:var(--text3);">${coStr.split('  ')[1] || ''}</div>`
      : `<span style="color:var(--text3);font-size:11px;">—</span>`;

    const ciStr  = p.checkInDate ? _fmtCioDate(p.checkInDate) : null;
    const ciCell = ciStr
      ? `<div style="font-family:var(--mono);font-size:11.5px;color:var(--teal);">${ciStr.split('  ')[0]}</div><div style="font-family:var(--mono);font-size:10.5px;color:var(--text3);">${ciStr.split('  ')[1] || ''}</div>`
      : `<span class="badge" style="background:rgba(227,179,65,.18);color:var(--amber);border:1px solid rgba(227,179,65,.3);font-size:10px;padding:2px 8px;">Active</span>`;

    if (!showItem) {
      return `<tr style="background:${band};">
        <td style="padding:9px 12px;">${seqBadge}</td>
        <td style="padding:9px 12px;">${coCell}</td>
        <td style="padding:9px 12px;">${ciCell}</td>
      </tr>`;
    }
    return `<tr style="background:${band};">
      ${itemCell}
      <td style="padding:9px 12px;">${seqBadge}</td>
      <td style="padding:9px 12px;">${coCell}</td>
      <td style="padding:9px 12px;">${ciCell}</td>
    </tr>`;
  }).join('');

  const total   = pairs.length;
  const active  = pairs.filter(p => !p.checkInDate).length;
  const itemCnt = new Set(pairs.map(p => p.item)).size;

  content.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font-size:11.5px;color:var(--text2);">
        <span style="font-weight:700;color:var(--text);font-family:var(--mono);">${itemCnt}</span> unique item${itemCnt !== 1 ? 's' : ''}
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font-size:11.5px;color:var(--text2);">
        <span style="font-weight:700;color:var(--text);font-family:var(--mono);">${total}</span> assignment${total !== 1 ? 's' : ''}
      </div>
      ${active ? `<div style="background:rgba(227,179,65,.12);border:1px solid rgba(227,179,65,.3);border-radius:8px;padding:7px 14px;font-size:11.5px;color:var(--amber);">
        <span style="font-weight:700;font-family:var(--mono);">${active}</span> currently active
      </div>` : ''}
    </div>
    <div class="hist-table-wrap">
      <table class="hist-table" style="table-layout:fixed;">
        <colgroup>
          <col style="width:24%;">
          <col style="width:8%;">
          <col style="width:34%;">
          <col style="width:34%;">
        </colgroup>
        <thead>
          <tr>
            <th>${meta.col2}</th>
            <th>#</th>
            <th style="color:var(--amber);">⬆ Check-Out</th>
            <th style="color:var(--teal);">⬇ Check-In</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}

SidePanel.register('hist', {
  open(empId) { openHistoryModal(empId); },
  close() { _histEmpId = null; _histTabCache = {}; },
});
