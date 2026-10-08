// Lost the phone with the authenticator? Run on the server:
//   cd /var/www/autoagent/backend && node scripts/auth_reset.js && pm2 restart autoagent-backend
// Turns the authenticator off (login goes back to admin@admin.com / 12345678) and logs every browser out.
// The restart matters: the running server keeps these values in memory.
require('dotenv').config();
const pool = require('../config/db');

(async () => {
  const keys = ['AUTH_TOTP_SECRET', 'AUTH_TOTP_PENDING', 'AUTH_SESSION_KEY'];
  await pool.query('DELETE FROM settings WHERE key = ANY($1)', [keys]);
  console.log('Authenticator turned off. Now run: pm2 restart autoagent-backend');
  console.log('Then log in with email + password and activate it again in Settings → Login & Security.');
  await pool.end();
})().catch((err) => { console.error(err.message); process.exit(1); });
