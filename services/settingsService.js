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
  { key: 'OPENAI_MONTHLY_BUDGET_USD', category: 'AI',              description: 'Hard monthly cap on OpenAI spend in USD (default 10). Once reached, all AI calls pause until the 1st of next month.' },
  { key: 'EMAIL_SIGNATURE',         category: 'Email',           description: 'Fallback email sign-off, used only for a sender with no own Signature (Settings → Email Senders); use \\n for line breaks. Empty = "<sender From name>\\nDreams Technology, Gandhinagar · +91 84607 65785\\nhttps://dreamstechnology.in/"' },
  { key: 'OWN_EMAIL_DOMAINS',        category: 'Email',           description: 'Comma-separated domains that are ours — leads on these are never cold-emailed (default dreamstechnology.in,dreams-technology.com)' },
  { key: 'EMAIL_ROTATION_BATCH',     category: 'Email',           description: 'New leads sent from one sender before rotating to the next active sender (default 10). Follow-ups always stay on the mailbox that sent the first email, and wait if it is full' },
  { key: 'SEND_WINDOW_START_HOUR',   category: 'Email',           description: 'Cold/follow-up sequence sends start hour, 24h IST (default 9). All leads are India-based, so IST is the one recipient timezone in this system.' },
  { key: 'SEND_WINDOW_END_HOUR',     category: 'Email',           description: 'Cold/follow-up sequence sends end hour, 24h IST (default 18)' },
  { key: 'SEND_WINDOW_DAYS',         category: 'Email',           description: 'Days sequence sends are allowed, comma-separated 0-6 (0=Sun..6=Sat), default 1,2,3,4,5 (Mon-Fri)' },
  { key: 'DIRECTORY_CRAWL_DELAY_MS', category: 'Directory Outreach', description: 'Pause between page fetches when crawling a directory, in ms (default 3000) — keep it polite' },
  { key: 'DIRECTORY_MAX_PAGES',      category: 'Directory Outreach', description: 'Max pages queued per directory source (default 500)' },
  { key: 'DIRECTORY_PAGES_PER_TICK', category: 'Directory Outreach', description: 'Pages crawled per 10-minute worker tick (default 30)' },
  { key: 'DIRECTORY_SOURCE_REST_MIN', category: 'Directory Outreach', description: 'Minutes each directory rests between crawl turns (default 20) — stops one site from being read non-stop' },
  { key: 'DIRECTORY_BLOCK_FAILS',    category: 'Directory Outreach', description: 'Failed pages in a row that mean "this site is blocking us" — crawling of that site stops (default 5)' },
  { key: 'DIRECTORY_BLOCK_COOLDOWN_HOURS', category: 'Directory Outreach', description: 'Hours a site is left alone after it blocks us (default 6, doubles each time it happens again, max 48). Its pages go back in the queue' },
  { key: 'DIRECTORY_MAX_DEPTH',     category: 'Directory Outreach', description: 'For directories without a sitemap: how many link levels to follow from the page you added (default 1 = listing pages + the member pages they link to; max 3). Next-page links are always followed' },
  { key: 'CADENCE_AUTO_SEND_REPLIES', category: 'Directory Outreach', description: 'true = a reply to a directory lead that self-scores at least AUTO_SEND_MIN_SCORE is sent automatically. Default false: every reply waits for your approval in Pending Actions' },
  { key: 'AUTO_SEND_MIN_SCORE',      category: 'Directory Outreach', description: 'Minimum self-check score (1-5, decimals allowed) for an auto-sent reply to a directory lead (default 4.5)' },
  { key: 'CADENCE_ENABLED', category: 'Directory Outreach', description: 'Master switch for directory-lead outreach (email ⇄ WhatsApp cadence). Default false = nothing is sent' },
  { key: 'CADENCE_NEW_EMAIL_PER_DAY', category: 'Directory Outreach', description: 'New directory leads started on email per day (default 50). Follow-ups are extra, still within sender caps' },
  { key: 'CADENCE_NEW_WA_PER_DAY', category: 'Directory Outreach', description: 'New directory leads started on WhatsApp per day (default 20 — raise slowly to protect the WhatsApp number quality rating)' },
  { key: 'CADENCE_WA_MAX_PER_DAY', category: 'Directory Outreach', description: 'Hard cap on cadence WhatsApp template sends per day, new + follow-ups (default 100)' },
  { key: 'CADENCE_EMAIL_TOUCHES', category: 'Directory Outreach', description: 'Emails per email block before switching to WhatsApp (default 2)' },
  { key: 'CADENCE_WA_TOUCHES', category: 'Directory Outreach', description: 'WhatsApp messages per WhatsApp block before switching to email (default 3)' },
  { key: 'CADENCE_EMAIL_GAP_DAYS', category: 'Directory Outreach', description: 'Days between email touches (default 4)' },
  { key: 'CADENCE_WA_GAP_DAYS', category: 'Directory Outreach', description: 'Days between WhatsApp touches (default 3)' },
  { key: 'CADENCE_REST_DAYS', category: 'Directory Outreach', description: 'Rest before each new cycle, comma-separated days per cycle (default 30,60,90; the last value repeats)' },
  { key: 'CADENCE_MAX_CYCLES', category: 'Directory Outreach', description: 'Full email+WhatsApp cycles before a lead is marked no_response (default 3; 0 = never stop)' },
  { key: 'CADENCE_EMAIL_MIN_SCORE',  category: 'Directory Outreach', description: 'Minimum 0-5 "personal, human, not AI-sounding" score for a directory cold email to be sent (default 4.5). Below it the draft is rewritten up to 3 times, then held until the next day' },
  { key: 'WA_TEMPLATE_MIN_POOL',     category: 'Directory Outreach', description: 'Different WhatsApp message ideas kept live per trade (default 2). Live templates per trade = this × WA_TEMPLATE_VARIANTS; extras are retired (deleted on Meta). Missing ones are written, scored and submitted automatically' },
  { key: 'WA_TEMPLATE_VARIANTS',     category: 'Directory Outreach', description: 'Versions kept per message idea, 1-3 (default 1: two versions are drafted, only the best is kept, so no near-duplicate templates)' },
  { key: 'WA_TEMPLATE_RETIRE_AFTER', category: 'Directory Outreach', description: 'A WhatsApp template sent this many times is retired (deleted on Meta, kept here for message history) and replaced by a fresh one on the next daily run (default 50)' },
  { key: 'WA_TEMPLATE_MIN_SCORE',    category: 'Directory Outreach', description: 'Minimum 0-5 "personal, human, not AI-sounding" score for a template to be submitted to Meta (default 4.5)' },
  { key: 'WA_TEMPLATE_AUTO_SUBMIT',  category: 'Directory Outreach', description: 'Submit passing templates to Meta automatically (default true). false = they wait as drafts on the Templates page' },
  { key: 'WA_TEMPLATE_MAX_SUBMIT_PER_DAY', category: 'Directory Outreach', description: 'Max templates submitted to Meta per day (default 15) — stays well inside Meta template creation limits' },
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
