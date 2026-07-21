const axios = require('axios');
const { getSetting } = require('./settingsService');

// Google PageSpeed Insights v5 — a real Lighthouse performance run on Google's own infrastructure,
// so leadResearchService.js gets a real speed score without this codebase running a headless
// browser itself. Advisory-only: any failure (missing key, timeout, malformed response) returns
// null and must never block or fail the rest of research.
const PAGESPEED_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const REQUEST_TIMEOUT_MS = 15000;

async function getSpeedScore(url) {
  const apiKey = await getSetting('PAGESPEED_API_KEY');
  if (!apiKey) return null;

  try {
    const response = await axios.get(PAGESPEED_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      params: { url, key: apiKey, strategy: 'mobile', category: 'performance' },
    });

    const score = response.data?.lighthouseResult?.categories?.performance?.score;
    return typeof score === 'number' ? Math.round(score * 100) : null;
  } catch (error) {
    console.error('[PageSpeed] getSpeedScore error:', error.response?.data?.error?.message || error.message);
    return null;
  }
}

module.exports = { getSpeedScore };
