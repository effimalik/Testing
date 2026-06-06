// ══ API HELPER — paste <script src="api.js"> in every Reg/ page ══
const API_URL = 'YOUR_APPS_SCRIPT_URL';

function apiGet(action, params = {}) {
  const user = JSON.parse(sessionStorage.getItem('adminpro_session') || '{}');
  const query = new URLSearchParams({ email: user.email, action, ...params });
  return fetch(API_URL + '?' + query).then(r => r.json());
}

function apiPost(action, body = {}) {
  const user = JSON.parse(sessionStorage.getItem('adminpro_session') || '{}');
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ email: user.email, action, ...body })
  }).then(r => r.json());
}