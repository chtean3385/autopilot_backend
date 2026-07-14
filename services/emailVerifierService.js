const axios = require('axios');
const { getSetting } = require('./settingsService');

// mails.so — POST /v1/validate?email=... , auth via x-mails-api-key header.
// Response shape: { data: { result: 'deliverable'|'undeliverable'|'risky'|'unknown', ... }, error: string|null }
const MAILS_SO_BASE_URL = 'https://api.mails.so/v1';

// Only 'deliverable' is trusted to enter a sequence — keeps bounce rate under the <3% target.
function isValidResult(result) {
  return result === 'deliverable';
}

// Normalized shape so MillionVerifier/Hunter can be swapped in behind the same interface.
async function verifyEmail(email) {
  const apiKey = await getSetting('VERIFIER_API_KEY');
  if (!apiKey) {
    console.error('[EmailVerifier] verifyEmail error: VERIFIER_API_KEY not configured');
    return { valid: false, status: 'error' };
  }

  try {
    const response = await axios.post(`${MAILS_SO_BASE_URL}/validate`, null, {
      params: { email },
      headers: { 'x-mails-api-key': apiKey },
    });

    const result = response.data?.data?.result || 'unknown';
    return { valid: isValidResult(result), status: result };
  } catch (error) {
    console.error('[EmailVerifier] verifyEmail error:', error.response?.data || error.message);
    return { valid: false, status: 'error' };
  }
}

module.exports = { verifyEmail };
