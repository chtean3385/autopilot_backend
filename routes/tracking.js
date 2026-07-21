const express = require('express');
const pool = require('../config/db');
const { verifyClickTarget } = require('../utils/emailTracking');

const router = express.Router();

// Self-hosted open/click tracking endpoints — public, no auth (hit by recipients' mail
// clients). Tokens are 32-hex random values stored on email_logs.tracking_token at send time
// (utils/emailTracking.js); an unknown token simply stamps nothing. Stamps use COALESCE so
// the first signal wins whether it came from here or from the Brevo webhook.

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function stamp(token, columns) {
  try {
    await pool.query(
      `UPDATE email_logs SET ${columns.map((c) => `${c} = COALESCE(${c}, NOW())`).join(', ')}
       WHERE tracking_token = $1 AND direction = 'out'`,
      [token]
    );
  } catch (err) {
    console.error('[Tracking] stamp failed:', err.message);
  }
}

// Open pixel — always serve the image first; tracking must never delay or break rendering
router.get('/o/:token', async (req, res) => {
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.send(PIXEL);
  await stamp(req.params.token, ['opened_at']);
});

// Click redirect — the HMAC sig ties the destination to the token, so this can't be used as
// an open redirect; a tampered/forged destination 404s instead of redirecting. A click also
// implies an open (pixel images are often blocked while links still work).
router.get('/c/:token', async (req, res) => {
  const url = String(req.query.u || '');
  const sig = String(req.query.s || '');
  if (!url || !verifyClickTarget(req.params.token, url, sig)) {
    return res.status(404).send('Not found');
  }
  res.redirect(302, url);
  await stamp(req.params.token, ['clicked_at', 'opened_at']);
});

module.exports = router;
