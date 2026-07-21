const schedule = require('node-schedule');
const pool = require('../config/db');
const { verifyEmail } = require('../services/emailVerifierService');
const { getSetting } = require('../services/settingsService');

// Hourly catch-up pass for leads that never got a verification verdict — typically
// added before VERIFIER_API_KEY was configured, or when mails.so was unreachable.
// Capped per run and per lead (MAX_ATTEMPTS) so a bad key can't burn quota forever.
const BATCH_LIMIT = 30;
const MAX_ATTEMPTS = 3;
const DELAY_BETWEEN_CALLS_MS = 500;

let isRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runVerificationPass() {
  if (isRunning) {
    console.log('[VerifyWorker] Previous run still in progress — skipping this tick');
    return;
  }
  isRunning = true;

  try {
    // Gmail leads are auto-verified without an API key, so always include them.
    // For everything else, skip the pass entirely when no key is configured —
    // verifyEmail would just return 'error' and waste an attempt.
    const apiKey = await getSetting('VERIFIER_API_KEY');

    const result = await pool.query(
      `SELECT id, email FROM hotel_leads
       WHERE channel = 'email'
         AND email IS NOT NULL AND email <> ''
         AND email_status IN ('unknown', 'found')
         AND COALESCE(email_verify_attempts, 0) < $1
         AND (last_verify_attempt_at IS NULL OR last_verify_attempt_at < NOW() - INTERVAL '55 minutes')
         ${apiKey ? '' : `AND email ~* '@(gmail|googlemail)\\.com$'`}
       ORDER BY created_at ASC
       LIMIT $2`,
      [MAX_ATTEMPTS, BATCH_LIMIT]
    );

    if (result.rows.length === 0) return;
    console.log(`[VerifyWorker] Re-verifying ${result.rows.length} lead(s)...`);

    let verified = 0;
    let unverifiable = 0;
    for (const lead of result.rows) {
      const verification = await verifyEmail(lead.email);

      if (verification.status === 'error') {
        // Verifier unreachable/misconfigured — record the attempt so we don't hammer
        // the API, but keep status 'unknown' (an outage is not a verdict on the address).
        await pool.query(
          `UPDATE hotel_leads
           SET email_verify_attempts = COALESCE(email_verify_attempts, 0) + 1,
               last_verify_attempt_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [lead.id]
        );
        continue;
      }

      const newStatus = verification.valid ? 'verified' : 'unverifiable';
      if (verification.valid) verified++; else unverifiable++;
      await pool.query(
        `UPDATE hotel_leads
         SET email_status = $1,
             email_verify_attempts = COALESCE(email_verify_attempts, 0) + 1,
             last_verify_attempt_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [newStatus, lead.id]
      );

      await sleep(DELAY_BETWEEN_CALLS_MS);
    }

    console.log(`[VerifyWorker] Pass complete — ${verified} verified, ${unverifiable} unverifiable`);
  } catch (err) {
    console.error('[VerifyWorker] Error in verification pass:', err.message);
  } finally {
    isRunning = false;
  }
}

schedule.scheduleJob('5 * * * *', runVerificationPass);

console.log('✅ Email verification worker started - re-checks unverified leads hourly');

module.exports = { runVerificationPass };
