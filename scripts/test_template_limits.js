// Test for the WhatsApp template size limits in services/templatePoolService.js:
//   - default 2 ideas × 1 version per niche (two versions drafted, only the best kept)
//   - a niche over its limit is trimmed to its best ideas (approved first); extras retired
//   - a template sent WA_TEMPLATE_RETIRE_AFTER times is retired; its outreach_logs keep template_id
// Throwaway DB + OUTBOUND_DRY_RUN (Meta deletes/submits are simulated). GPT is stubbed.
// Run: node scripts/test_template_limits.js (needs scripts/setup_overnight_db.js's autoagent_overnight DB).
const path = require('path');
const B = path.join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = '';

// GPT stub: writes N ideas × V versions (version b scores higher), never calls anything a repeat.
const aiUsage = require(B + 'utils/aiUsage');
let draftCalls = 0;
aiUsage.isAiAvailable = () => true;
aiUsage.trackedCompletion = async (client, params, { purpose } = {}) => {
  const system = params.messages[0].content;
  if (purpose === 'wa_template_draft') {
    draftCalls++;
    const count = Number((system.match(/Write (\d+) DIFFERENT/) || [])[1] || 1);
    const variants = Number((system.match(/write (\d+) versions/) || [])[1] || 2);
    const ideas = Array.from({ length: count }, (_, i) => {
      const t = `z${draftCalls}k${i}`;
      return {
        idea: `limit_idea_${draftCalls}_${i}`,
        versions: Array.from({ length: variants }, (__, v) =>
          `Hi {{1}}, Chetan here from Dreams Technology, Gandhinagar. ${v === 1 ? 'BEST ' : ''}In your work ${t}a ${t}b ${t}c ${t}d ${t}e ${t}f happens often. Version ${v}. Does this happen with you too?`),
      };
    });
    return { choices: [{ message: { content: JSON.stringify({ ideas }) } }], usage: {} };
  }
  if (purpose === 'wa_template_dedupe') {
    const n = (params.messages[1].content.match(/^N\d+ \(/gm) || []).length;
    return { choices: [{ message: { content: JSON.stringify({ ideas: Array.from({ length: n }, (_, i) => ({ id: `N${i + 1}`, same_as: null, off_topic: [] })) }) } }], usage: {} };
  }
  if (purpose === 'wa_template_score') {
    const best = /BEST/.test(params.messages[1].content);
    return { choices: [{ message: { content: JSON.stringify({ score: best ? 4.9 : 4.6, note: 'ok' }) } }], usage: {} };
  }
  return { choices: [{ message: { content: '{}' } }], usage: {} };
};

const pool = require(B + 'config/db');
const TP = require(B + 'services/templatePoolService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const run = Date.now().toString(36);

async function addTemplate(niche, group, variant, status, score) {
  const r = await pool.query(
    `INSERT INTO waba_templates (template_name, template_category, body_text, status, industry, auto_generated, created_by, template_group, variant, quality_score)
     VALUES ($1, 'MARKETING', $2, $3, $4, TRUE, 'auto', $5, $6, $7) RETURNING *`,
    [`${group}_v${variant}`, `Hi {{1}}, test body for ${group} version ${variant}, long enough to be a realistic WhatsApp template text.`, status, niche, group, variant, score]
  );
  return r.rows[0];
}
const statusOf = async (id) => (await pool.query('SELECT status FROM waba_templates WHERE id = $1', [id])).rows[0].status;

(async () => {
  await pool.query(`DELETE FROM settings WHERE key LIKE 'WA_TEMPLATE_%'`);
  const cfgDefault = { groups: 2, variants: 1, minScore: 4.5, retireAfter: 50, hindiIdeas: 0, hinglishIdeas: 0, maxSubmitPerDay: 15 };

  // 1. Default: 2 different ideas, 1 version each — the higher-scoring of the 2 drafted versions.
  const fresh = `limits_${run}_a`;
  const r1 = await TP.ensureNiche(fresh, cfgDefault);
  const rows1 = (await pool.query(`SELECT * FROM waba_templates WHERE LOWER(industry) = $1 ORDER BY id`, [fresh])).rows;
  check(rows1.length === 2 && new Set(rows1.map((t) => t.template_group)).size === 2, 'a new trade gets 2 templates, each a different idea', `got ${rows1.length}`);
  check(rows1.every((t) => /BEST/.test(t.body_text) && Number(t.quality_score) === 4.9), 'only the best-scoring version of each idea is kept', rows1.map((t) => t.quality_score).join(','));
  const r1b = await TP.ensureNiche(fresh, cfgDefault);
  check(r1.wrote.length === 2 && r1b.wrote.length === 0, 'a trade at its limit gets nothing new');

  // 2. Over the limit (4 ideas × 2 versions, mixed statuses) → trimmed to the best 2, approved first.
  const niche = `limits_${run}_b`;
  const tpl = {};
  for (const [g, st, sc] of [['g1', 'draft', 4.9], ['g2', 'approved', 4.5], ['g3', 'pending_approval', 4.8], ['g4', 'approved', 4.7]]) {
    tpl[`${g}a`] = await addTemplate(niche, `${niche}_${g}`, 1, st, sc);
    tpl[`${g}b`] = await addTemplate(niche, `${niche}_${g}`, 2, st, sc - 0.1);
  }
  const trimmed = await TP.trimNiche(niche, cfgDefault);
  const live = (await pool.query(`SELECT template_group, variant FROM waba_templates WHERE LOWER(industry) = $1 AND status <> 'retired' ORDER BY template_group`, [niche])).rows;
  check(trimmed.length === 6 && trimmed.every((x) => x.retired), '8 live → 6 retired', `retired ${trimmed.length}`);
  check(live.length === 2 && live.map((x) => x.template_group).join(',') === `${niche}_g2,${niche}_g4` && live.every((x) => x.variant === 1),
    'kept: the 2 approved ideas, best version of each', JSON.stringify(live));
  check(await statusOf(tpl.g1a.id) === 'retired' && await statusOf(tpl.g3a.id) === 'retired', 'drafts and pending extras retired too');

  // 3. Retire after N sends; message history keeps the template link.
  const lead = (await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, whatsapp_number, city, source) VALUES ($1, '', '', 'Test', 'manual') RETURNING id`,
    [`Limits Lead ${run}`]
  )).rows[0];
  const t = tpl.g2a;
  for (let i = 0; i < 49; i++) await pool.query(`INSERT INTO outreach_logs (lead_id, template_id, message_type, sent_at) VALUES ($1, $2, 'template', NOW())`, [lead.id, t.id]);
  let rr = await TP.retireUsedUp({ templateId: t.id, c: cfgDefault });
  check(rr.length === 0 && await statusOf(t.id) === 'approved', '49 sends → still approved');
  await pool.query(`INSERT INTO outreach_logs (lead_id, template_id, message_type, sent_at) VALUES ($1, $2, 'template', NOW())`, [lead.id, t.id]);
  rr = await TP.retireUsedUp({ templateId: t.id, c: cfgDefault });
  check(rr.length === 1 && rr[0].retired && await statusOf(t.id) === 'retired', '50 sends → retired (deleted on Meta, dry-run)');
  const kept = await pool.query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE template_id = $1`, [t.id]);
  check(kept.rows[0].n === 50, 'all 50 sent messages still point at the template (Inbox keeps the text)', String(kept.rows[0].n));

  // 4. The picker never sends a retired template.
  const picked = await pool.query(`SELECT COUNT(*)::int AS n FROM waba_templates WHERE id = $1 AND status = 'approved'`, [t.id]);
  check(picked.rows[0].n === 0, 'retired template is not approved, so it is never picked for sending');

  // 5. The pool tops the trade back up to 2.
  const r5 = await TP.ensureNiche(niche, cfgDefault);
  check(r5.wrote.length === 1, 'next run writes 1 fresh idea to replace the retired one', `wrote ${r5.wrote.length}`);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
