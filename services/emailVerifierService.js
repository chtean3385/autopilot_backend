const axios = require('axios');
const { getSetting } = require('./settingsService');

// mails.so — POST /v1/validate?email=... , auth via x-mails-api-key header.
// Response shape: { data: { result: 'deliverable'|'undeliverable'|'risky'|'unknown', ... }, error: string|null }
const MAILS_SO_BASE_URL = 'https://api.mails.so/v1';

// Only 'deliverable' is trusted to enter a sequence — keeps bounce rate under the <3% target.
function isValidResult(result) {
  return result === 'deliverable';
}

// Free-mail providers reject non-existent recipients at SMTP time, so an address that
// exists on these domains is near-always deliverable. Auto-verifying them saves API
// quota and avoids the catch-all 'unverifiable' trap that blocks real addresses.
const FREE_MAIL_AUTO_VERIFY = /@(gmail\.com|googlemail\.com)$/i;

// Normalized shape so MillionVerifier/Hunter can be swapped in behind the same interface.
async function verifyEmail(email) {
  if (FREE_MAIL_AUTO_VERIFY.test(String(email).trim())) {
    return { valid: true, status: 'deliverable', source: 'freemail_auto' };
  }

  const apiKey = await getSetting('VERIFIER_API_KEY');
  if (!apiKey) {
    console.error('[EmailVerifier] verifyEmail error: VERIFIER_API_KEY not configured');
    return { valid: false, status: 'error' };
  }

  try {
    // Without a timeout, a stalled mails.so response hangs this call forever — and since
    // LeadService.addLeads awaits verifyEmail() one lead at a time in a loop, one stuck call
    // blocks every remaining lead behind it, which blocks the whole agent task (it never
    // resolves OR throws, so the task sits in 'running' status indefinitely).
    const response = await axios.post(`${MAILS_SO_BASE_URL}/validate`, null, {
      params: { email },
      headers: { 'x-mails-api-key': apiKey },
      timeout: 15000,
    });

    const result = response.data?.data?.result || 'unknown';
    return { valid: isValidResult(result), status: result };
  } catch (error) {
    console.error('[EmailVerifier] verifyEmail error:', error.response?.data || error.message);
    return { valid: false, status: 'error' };
  }
}

module.exports = { verifyEmail };
