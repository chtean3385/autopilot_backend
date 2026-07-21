const pool = require('../config/db');

const SETTINGS_DEFS = [
  { key: 'WABA_PHONE_ID',            category: 'WhatsApp (WABA)', description: 'WhatsApp Business Phone Number ID' },
  { key: 'WABA_BUSINESS_ACCOUNT_ID', category: 'WhatsApp (WABA)', description: 'WhatsApp Business Account ID (WABA ID)' },
  { key: 'WABA_API_TOKEN',           category: 'WhatsApp (WABA)', description: 'Meta System User Access Token', sensitive: true },
  { key: 'WABA_API_VERSION',         category: 'WhatsApp (WABA)', description: 'Meta Graph API version (e.g. v18.0)' },
  { key: 'WEBHOOK_VERIFY_TOKEN',     category: 'WhatsApp (WABA)', description: 'Meta Webhook verification token' },
  { key: 'GOOGLE_PLACES_API_KEY',    category: 'Google',          description: 'Google Places API Key', sensitive: true },
  { key: 'PAGESPEED_API_KEY',        category: 'Google',          description: 'Google PageSpeed Insights API key (website speed score in lead research)', sensitive: true },
  { key: 'OPENAI_API_KEY',           category: 'OpenAI',          description: 'OpenAI API Key (agent brain)', sensitive: true },
  { key: 'DEMO_LINK',                category: 'App',             description: 'Demo booking link (used as {{4}} in templates)' },
  { key: 'OWNER_WHATSAPP',           category: 'App',             description: 'Your WhatsApp number in E.164 format (no +)' },
  { key: 'HUNTER_API_KEY',           category: 'Email',           description: 'Hunter.io API key (email discovery fallback)', sensitive: true },
  { key: 'VERIFIER_API_KEY',         category: 'Email',           description: 'mails.so / verifier API key (mandatory pre-send email verification)', sensitive: true },
  { key: 'OWNER_NOTIFY_EMAIL',       category: 'Email',           description: 'Email address notified on pending approvals (estimates, low-score replies)' },
  { key: 'UNSUBSCRIBE_SECRET',       category: 'Email',           description: 'Secret used to sign unsubscribe link tokens', sensitive: true },
  { key: 'OWNER_WEBSITE_URL',        category: 'Portfolio',       description: 'Your business website — scraped and cached for context in portfolio auto-replies' },
  { key: 'SEND_WINDOW_START_HOUR',   category: 'Email',           description: 'Cold/follow-up sequence sends start hour, 24h IST (default 9). All leads are India-based, so IST is the one recipient timezone in this system.' },
  { key: 'SEND_WINDOW_END_HOUR',     category: 'Email',           description: 'Cold/follow-up sequence sends end hour, 24h IST (default 18)' },
  { key: 'SEND_WINDOW_DAYS',         category: 'Email',           description: 'Days sequence sends are allowed, comma-separated 0-6 (0=Sun..6=Sat), default 1,2,3,4,5 (Mon-Fri)' },
];

async function getSetting(key) {
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (result.rows.length > 0 && result.rows[0].value !== null && result.rows[0].value !== '') {
      return result.rows[0].value;
    }
  } catch { /* table may not exist yet */ }
  return process.env[key] || null;
}

async function getAllSettings() {
  let dbMap = {};
  try {
    const rows = await pool.query('SELECT key, value, updated_at FROM settings ORDER BY key');
    for (const row of rows.rows) dbMap[row.key] = row;
  } catch { /* table may not exist yet */ }

  return SETTINGS_DEFS.map(def => ({
    key: def.key,
    category: def.category,
    description: def.description,
    sensitive: def.sensitive || false,
    value: dbMap[def.key]?.value ?? process.env[def.key] ?? '',
    updated_at: dbMap[def.key]?.updated_at || null,
    source: dbMap[def.key] ? 'db' : 'env',
  }));
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
  process.env[key] = value;
}

module.exports = { getSetting, getAllSettings, setSetting, SETTINGS_DEFS };
