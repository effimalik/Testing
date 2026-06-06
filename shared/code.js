/* ═══ SHARED THEME SYNC ═══
   Include this in every child page (not index.html) */

const VALID_THEMES = ['dark', 'light', 'purple', 'ocean', 'slate'];

function applyTheme(mode) {
  if (!VALID_THEMES.includes(mode)) mode = 'dark';
  document.documentElement.setAttribute('data-theme', mode);
}

// Live theme changes — listen for postMessage from parent (index.html)
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'setTheme' && e.data.theme) {
    applyTheme(e.data.theme);
  }
});

// Initial load — read parent's theme directly (same-origin), fallback to localStorage
document.addEventListener('DOMContentLoaded', () => {
  try {
    const parentTheme = window.parent.document.documentElement.getAttribute('data-theme');
    if (parentTheme) { applyTheme(parentTheme); return; }
  } catch(e) { /* cross-origin — postMessage will handle it */ }
  applyTheme(localStorage.getItem('theme') || 'dark');
});


