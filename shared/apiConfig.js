/* ═══════════════════════════════════════════════════════════════════════════
 *  Reg/shared/apiConfig.js
 *
 *  ONE shared file holding the Apps Script Web App URL.
 *  Every frontend file that talks to the backend includes this file
 *  instead of hardcoding the URL itself. When the script is redeployed,
 *  update the line below ONCE — every file that includes this picks up
 *  the change automatically.
 *
 *  HOW TO USE IN EACH OF YOUR FILES:
 *
 *    1) Add this line near the top of <head>, before any script that
 *       calls the backend:
 *
 *         <script src="Reg/shared/apiConfig.js"></script>
 *
 *    2) Anywhere in that file, just use the constant directly:
 *
 *         fetch(API_URL, { method: 'POST', ... })
 * ═══════════════════════════════════════════════════════════════════════════ */

const API_URL = 'https://script.google.com/macros/s/AKfycbyegEqS1voGx_ZSgg0P7etMgm4W0rhvBxWA-wHSjC7hjeSfbRVbwRI-wi30C-f47BTl/exec';
