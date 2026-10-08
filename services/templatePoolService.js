const OpenAI = require('openai');
const pool = require('../config/db');
const WABAService = require('./wabaService');
const settingsService = require('./settingsService');
const { trackedCompletion, isAiAvailable } = require('../utils/aiUsage');
const { SCORING_RUBRIC } = require('../utils/humanTone');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Directory outreach — fully automatic WhatsApp templates (owner's brief: no manual review; per niche;
// 2-3 versions of each message so no single template carries all the volume; only the best go out).
//
// For every niche in use (directory_sources.niche, plus 'directory' as the generic fallback):
//   1. keep WA_TEMPLATE_MIN_POOL message ideas ("groups") alive — approved, waiting for Meta, or drafted
//   2. a missing idea is written by GPT as WA_TEMPLATE_VARIANTS (default 2) versions, in that trade's words;
//      WA_TEMPLATE_HINDI_IDEAS (1) ideas in Hindi, WA_TEMPLATE_HINGLISH_IDEAS (2) in Hinglish, the rest simple English.
//      Every message says who we are and why we are writing. An idea that repeats a live idea's meaning
//      (any language) is dropped before scoring (dropDuplicates)
//   3. every version is scored 0-5 for "personal, human, specific, not AI" (utils/humanTone.js);
//      only versions >= WA_TEMPLATE_MIN_SCORE (4.5) are kept, and an idea needs >= 2 kept versions
//      (one rewrite with the reviewer's feedback, else dropped)
//   4. kept versions are submitted to Meta automatically (WA_TEMPLATE_AUTO_SUBMIT, default true),
//      at most WA_TEMPLATE_MAX_SUBMIT_PER_DAY per day; approvals arrive via the webhook and a sync
//      safety net; an idea whose versions all get rejected is replaced next run, with Meta's reasons
//      fed back into the writer.
// Meta, not this code, decides approval. No AI available → nothing is written or submitted.
//
// Size limits (owner, 2026-10-08 — near-identical versions were heading for Meta's 250-template cap):
//   - per niche at most WA_TEMPLATE_MIN_POOL ideas × WA_TEMPLATE_VARIANTS versions are live (default
//     2 × 1 = 2 different messages). The writer still drafts 2 versions per idea; only the best is kept.
//   - a template sent WA_TEMPLATE_RETIRE_AFTER (50) times is retired: deleted on Meta, kept here with
//     status 'retired' (old messages still show its text), and the next run writes a fresh idea.
//   - a niche over its limit (e.g. from before these rules) is trimmed to its best ideas the same way.

const GENERIC_NICHE = 'directory';
const FOOTER = 'Reply STOP to opt out';
const DEFAULTS = { groups: 2, variants: 1, minScore: 4.5, maxSubmitPerDay: 15, hindiIdeas: 1, hinglishIdeas: 2, retireAfter: 50 };
const LIVE_STATUSES = ['approved', 'pending_approval', 'draft'];

// Owner's brief (2026-10-08): Indian owners, so plain words anyone understands, say who we are and why
// we are writing, and mix in Hinglish and Hindi. The language lives in the group name (_en_/_hing_/_hi_);
// Meta gets 'hi' for Devanagari text, 'en_US' for everything else (Hinglish is written in English letters).
const LANGS = {
  en: 'very simple Indian English. Short, everyday words a shop or factory owner uses. No formal phrases like "would you be open to", "how do you manage", "keep track of", "streamline".',
  hing: 'Hinglish: Hindi written in English letters, mixed with common English words, the way people type on WhatsApp (e.g. "aapke paas customer ka enquiry WhatsApp pe aata hai?"). Simple and friendly.',
  hi: 'simple spoken Hindi in Devanagari script (common English words like website, email, WhatsApp, order may stay in English). Not formal or bookish Hindi.',
};
// Groups are named <niche>_<lang>_<idea>_<stamp>; older groups have no language part and count as English.
function langOfGroup(group, niche) {
  const prefix = `${slug(niche, 20)}_`;
  const rest = String(group || '').startsWith(prefix) ? String(group).slice(prefix.length) : '';
  return rest.startsWith('hing_') ? 'hing' : rest.startsWith('hi_') ? 'hi' : 'en';
}
const metaLanguage = (body) => (/[ऀ-ॿ]/.test(String(body || '')) ? 'hi' : 'en_US');

async function cfg() {
  const n = async (k, d) => { const v = Number.parseFloat(await settingsService.getSetting(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  // Like n(), but 0 is allowed ("no Hindi ideas").
  const count0 = async (k, d) => { const v = Number.parseInt(await settingsService.getSetting(k), 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  const autoRaw = await settingsService.getSetting('WA_TEMPLATE_AUTO_SUBMIT');
  return {
    groups: Math.min(Math.round(await n('WA_TEMPLATE_MIN_POOL', DEFAULTS.groups)), 12),
    variants: Math.min(Math.max(Math.round(await n('WA_TEMPLATE_VARIANTS', DEFAULTS.variants)), 1), 3), // owner: 1 per idea, 2 per niche
    retireAfter: Math.round(await n('WA_TEMPLATE_RETIRE_AFTER', DEFAULTS.retireAfter)),
    minScore: Math.min(await n('WA_TEMPLATE_MIN_SCORE', DEFAULTS.minScore), 5),
    maxSubmitPerDay: Math.round(await n('WA_TEMPLATE_MAX_SUBMIT_PER_DAY', DEFAULTS.maxSubmitPerDay)),
    hindiIdeas: await count0('WA_TEMPLATE_HINDI_IDEAS', DEFAULTS.hindiIdeas),
    hinglishIdeas: await count0('WA_TEMPLATE_HINGLISH_IDEAS', DEFAULTS.hinglishIdeas),
    autoSubmit: autoRaw === null || autoRaw === undefined || autoRaw === '' ? true : String(autoRaw).toLowerCase() === 'true',
  };
}

const slug = (s, max = 24) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, max) || 'x';
const normNiche = (n) => String(n || '').trim().toLowerCase().slice(0, 100);

// Meta-friendly checks: exactly one {{1}}, not at the very start/end, sensible length, no links.
function validateBody(body) {
  const text = String(body || '').trim();
  const vars = text.match(/\{\{\d+\}\}/g) || [];
  if (vars.length !== 1 || vars[0] !== '{{1}}') return 'must contain {{1}} exactly once and no other variables';
  if (/^\{\{1\}\}/.test(text) || /\{\{1\}\}[.!?]?$/.test(text)) return '{{1}} cannot be at the start or end';
  if (text.length < 80 || text.length > 550) return `length ${text.length} outside 80-550`;
  if (/https?:\/\/|www\./i.test(text)) return 'no links';
  return null;
}

async function activeNiches() {
  const r = await pool.query(
    `SELECT DISTINCT LOWER(TRIM(niche)) AS niche FROM directory_sources WHERE status <> 'rejected' AND COALESCE(TRIM(niche), '') <> ''`
  );
  return [...new Set([GENERIC_NICHE, ...r.rows.map((x) => normNiche(x.niche))])];
}

async function poolStatus(niche = null) {
  const { rows } = await pool.query(
    `SELECT id, template_name, status, body_text, industry, template_group, variant, quality_score, quality_note,
            rejection_reason, submitted_at, updated_at
     FROM waba_templates WHERE template_group IS NOT NULL AND ($1::text IS NULL OR LOWER(industry) = $1)
     ORDER BY LOWER(industry), template_group, variant`,
    [niche ? normNiche(niche) : null]
  );
  const count = (s) => rows.filter((r) => r.status === s).length;
  const live = new Set(rows.filter((r) => ['approved', 'pending_approval', 'draft'].includes(r.status)).map((r) => `${r.industry}|${r.template_group}`));
  return { approved: count('approved'), pending: count('pending_approval'), draft: count('draft'), rejected: count('rejected'), liveGroups: live.size, templates: rows };
}

// Template-only writing rules (the shared WRITING_RULES are English email/reply rules).
const TEMPLATE_RULES = `Write like Chetan, founder of Dreams Technology, a small web team in Gandhinagar, typing a short WhatsApp message himself.
- The FIRST sentence after the greeting says who he is and why he is writing, in plain words, e.g. "Chetan here from Dreams Technology, Gandhinagar. We make websites and business email for <trade> businesses." The reader must never wonder "who is this, why is he messaging me".
- Then ONE real, everyday situation from their trade, said simply. Then ONE easy question they can answer in a word or two.
- Simple words only. Short sentences. If a 10th-pass shop owner would need to read it twice, it is too hard.
- No sales words or jargon: "solution", "leverage", "streamline", "boost", "CRM", "digital transformation", "next level", "seamless".
- No AI tells: no "I hope this message finds you well", "I wanted to reach out", "I came across", no em dashes (—), no exclamation marks, no emojis, no lists, no flattery.
- Never invent facts about them. Never criticise their business.`;

async function writeIdeas(niche, count, variants, avoidBodies, rejectionNotes, feedback = null, lang = 'en') {
  const trade = niche === GENERIC_NICHE ? 'small and new businesses of any kind (mostly manufacturers and traders in GIDC estates)' : niche;
  const greeting = lang === 'en' ? '"Hi {{1}}," or "Hello {{1}},"' : '"Namaste {{1}} ji," or "Hi {{1}} ji,"';
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 2200,
    temperature: 0.9,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `You write WhatsApp opening messages from Dreams Technology (Gandhinagar) to owners of ${trade} businesses in Gujarat, ` +
          'found in industry association directories. What we can help with: a proper website, a business email (name@company.com), ' +
          'and a simple way to track every enquiry/customer. Do not list all three — pick what fits the idea.\n\n' +
          `${TEMPLATE_RULES}\n\nLanguage: ${LANGS[lang]}\n\n` +
          'Format rules (Meta template):\n' +
          `- 35-70 words. Start with ${greeting} ({{1}} = first name). {{1}} appears exactly once; no other variables.\n` +
          '- No links, prices, discounts, "free", or ALL CAPS.\n\n' +
          'This is a template: the same text goes to every owner in the trade, only {{1}} changes. So be specific to the TRADE, ' +
          'not to one company: first list 4-6 concrete everyday situations owners in this trade really deal with (who asks them ' +
          'for what, where enquiries come from, what gets lost or delayed), then build each idea on one of them, in the words they use.\n' +
          'Each idea must make a DIFFERENT point from every other idea and from the ones already in use (not the same problem in new words; ' +
          '"messages get lost in WhatsApp" counts as one idea, however it is phrased).\n\n' +
          `Write ${count} DIFFERENT message ideas. For each idea write ${variants} versions that say the same thing in genuinely different words ` +
          '(different opening line and question wording), each one strong on its own and about exactly that idea.\n' +
          'Reply JSON only: {"situations":["..."],"ideas":[{"idea":"2-4 word snake_case name","versions":["...","..."]}]}',
      },
      {
        role: 'user',
        content:
          `Trade: ${trade}\n` +
          `Ideas already in use — do not repeat their angle:\n${avoidBodies.map((b) => `- ${b}`).join('\n') || '(none)'}\n` +
          (rejectionNotes.length ? `Meta rejected earlier templates for: ${rejectionNotes.join('; ')}. Avoid that.\n` : '') +
          (feedback ? `A reviewer said about the last attempt: ${feedback}\n` : ''),
      },
    ],
  }, { purpose: 'wa_template_draft' });
  const parsed = JSON.parse(response.choices[0].message.content || '{}');
  return (Array.isArray(parsed.ideas) ? parsed.ideas : []).slice(0, count);
}

// The reviewer must know this is a Meta template: the same text goes to every owner in the trade and
// only {{1}} (first name) changes, so it can never name their company or a detail about them. Without
// this context the rubric's "generic copy" deduction fired on every version (scores stuck at 2-2.5,
// nothing ever passed the 4.5 gate). It now judges trade specificity, human tone and Meta-approvability.
const TEMPLATE_REVIEW_CONTEXT =
  'IMPORTANT CONTEXT: this is a pre-approved WhatsApp message TEMPLATE. The same text is sent to many owners in this trade and ' +
  'only {{1}} (their first name) is filled in. It therefore CANNOT mention their company name, products, city or anything about ' +
  'one specific business, and it must end with a simple question. Do NOT deduct for that. "Specific" here means: does it describe ' +
  'a real, everyday situation that people in THIS trade recognise, in words they would use? A message that would fit any trade ' +
  'equally well is still generic and must score low.\n' +
  'It may be in simple English, Hinglish (Hindi in English letters) or Hindi; judge all three the same way, never deduct for the language itself.\n' +
  'Our readers are Indian small-business owners, many not comfortable with formal English. Score 4.0 or lower if: it does not say ' +
  'early on who is writing (Chetan / Dreams Technology) and why; it uses formal or hard words ("would you be open to", "manage", ' +
  '"keep track of", "streamline", bookish Hindi); or the question is not easy to answer in a word or two.\n' +
  'Also check Meta approval risk: high risk = misleading or vague claims, pressure, prices/offers, "free", links, ALL CAPS, ' +
  'threats, asking for sensitive info, or text that reads like spam/promotion more than a conversation opener.';

async function scoreVersion(niche, body) {
  const trade = niche === GENERIC_NICHE ? 'small manufacturing/trading business (GIDC estate)' : niche;
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 200,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `You review a WhatsApp opening message to the owner of a ${trade} business in Gujarat, sent by a small web team.\n` +
          `${TEMPLATE_REVIEW_CONTEXT}\n${SCORING_RUBRIC}\n` +
          'Reply JSON only: {"score": 0.0-5.0, "meta_risk": "low"|"high", "note": "one short, concrete fix if below 4.5, else why it works"}',
      },
      { role: 'user', content: body },
    ],
  }, { purpose: 'wa_template_score' });
  const parsed = JSON.parse(response.choices[0].message.content || '{}');
  let score = Math.round(Number.parseFloat(parsed.score) * 10) / 10;
  score = Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : 0;
  const risky = String(parsed.meta_risk || '').toLowerCase() === 'high';
  const note = String(parsed.note || '').slice(0, 300);
  // A Meta-risky version never passes, however human it sounds — a rejection costs a template slot.
  return risky ? { score: Math.min(score, 3), note: `Meta approval risk: ${note}` } : { score, note };
}

// A near-miss (>= POLISH_FROM) gets rewritten with the reviewer's note and re-scored, up to POLISH_TRIES
// times, instead of being thrown away — OpenAI does the editing a human reviewer would do. The bar
// itself (minScore) is unchanged: only versions that actually reach it are kept.
const POLISH_FROM = 3.5;
const POLISH_TRIES = 2;

async function polishVersion(niche, body, note) {
  const trade = niche === GENERIC_NICHE ? 'small manufacturing/trading businesses in GIDC estates' : niche;
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 400,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `You edit a WhatsApp template from Dreams Technology (Gandhinagar) to owners of ${trade} in Gujarat.\n${TEMPLATE_RULES}\n\n` +
          'Keep the same idea and the same language (English, Hinglish or Hindi) and the same greeting. ' +
          'Fix exactly what the reviewer said. Keep 35-70 words, ' +
          '{{1}} exactly once, no other variables, no links, prices, "free" or ALL CAPS, end with one easy question.\n' +
          'Reply JSON only: {"text": "..."}',
      },
      { role: 'user', content: `Message:\n${body}\n\nReviewer: ${note}` },
    ],
  }, { purpose: 'wa_template_polish' });
  const parsed = JSON.parse(response.choices[0].message.content || '{}');
  return String(parsed.text || '').trim();
}

async function scoreAndPolish(niche, body, minScore, notes) {
  let text = body.trim();
  let { score, note } = await scoreVersion(niche, text);
  for (let i = 0; i < POLISH_TRIES && score < minScore && score >= POLISH_FROM; i++) {
    const edited = await polishVersion(niche, text, note);
    if (!edited || validateBody(edited)) break;
    const rescored = await scoreVersion(niche, edited);
    if (rescored.score <= score) { note = rescored.note; continue; }
    text = edited;
    ({ score, note } = rescored);
  }
  if (score < minScore) notes.push(note);
  return { body: text, score, note };
}

// Score every version; an idea is kept when >= minVersions pass, best-scoring versions first.
// Returns {kept:[{idea, versions:[{body,score,note}]}], best, feedback}.
async function scoreIdeas(niche, ideas, minScore, minVersions = 2) {
  const kept = [];
  const notes = [];
  let best = null;
  for (const idea of ideas) {
    const passing = [];
    for (const body of (Array.isArray(idea.versions) ? idea.versions : [])) {
      const problem = validateBody(body);
      if (problem) { notes.push(problem); continue; }
      const v = await scoreAndPolish(niche, body, minScore, notes);
      if (best === null || v.score > best) best = v.score;
      if (v.score >= minScore) passing.push(v);
    }
    if (passing.length >= minVersions) kept.push({ idea: idea.idea, versions: passing.sort((a, b) => b.score - a.score) });
  }
  return { kept, best, feedback: notes.filter(Boolean).slice(0, 4).join(' | ') };
}

async function insertGroup(niche, idea, versions, lang = 'en') {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '') + Math.random().toString(36).slice(2, 5);
  const group = `${slug(niche, 20)}_${lang}_${slug(idea, 24)}_${stamp}`;
  const names = [];
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const name = `${group}_v${i + 1}`.slice(0, 120);
    await pool.query(
      `INSERT INTO waba_templates
         (template_name, template_category, body_text, footer_text, examples, parameter_mapping, status, industry,
          auto_generated, created_by, template_group, variant, quality_score, quality_note)
       VALUES ($1, 'MARKETING', $2, $3, $4, $5, 'draft', $6, TRUE, 'auto', $7, $8, $9, $10)
       ON CONFLICT (template_name) DO NOTHING`,
      [name, v.body, FOOTER, JSON.stringify(['Rakesh']), JSON.stringify({ 1: 'owner_first_name' }), niche, group, i + 1, v.score, v.note]
    );
    names.push(name);
  }
  return names;
}

async function submittedToday() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM waba_templates
     WHERE submitted_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::timestamp`
  );
  return r.rows[0].n;
}

// Submit passing drafts to Meta (oldest first), within today's cap.
async function submitDrafts({ limit } = {}) {
  const c = await cfg();
  const room = Math.max(0, (limit ?? c.maxSubmitPerDay) - (await submittedToday()));
  if (room === 0) return [];
  const { rows } = await pool.query(
    `SELECT * FROM waba_templates
     WHERE status = 'draft' AND auto_generated AND template_group IS NOT NULL AND quality_score >= $1
     ORDER BY id LIMIT $2`,
    [c.minScore, room]
  );
  const out = [];
  for (const t of rows) {
    const examples = Array.isArray(t.examples) ? t.examples : JSON.parse(t.examples || '[]');
    const result = await WABAService.submitTemplateToMeta({ ...t, examples, language: metaLanguage(t.body_text) });
    if (result.success) {
      await pool.query(
        `UPDATE waba_templates SET status = 'pending_approval', meta_template_id = COALESCE($1, meta_template_id),
           submitted_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [String(result.data?.id || '') || null, t.id]
      );
    } else {
      await pool.query(`UPDATE waba_templates SET quality_note = $2, updated_at = NOW() WHERE id = $1`,
        [t.id, `Submit failed: ${String(result.error).slice(0, 250)}`]);
    }
    out.push({ template: t.template_name, success: result.success, error: result.error });
  }
  return out;
}

// Safety net for the webhook: ask Meta about anything still pending after an hour.
async function syncPending() {
  const { rows } = await pool.query(
    `SELECT id, template_name FROM waba_templates
     WHERE status = 'pending_approval' AND template_group IS NOT NULL AND submitted_at < NOW() - INTERVAL '1 hour'
     ORDER BY submitted_at LIMIT 50`
  );
  let changed = 0;
  for (const t of rows) {
    const r = await WABAService.syncTemplateStatus(t.template_name);
    if (r.success && r.status !== 'pending_approval') {
      await pool.query(
        `UPDATE waba_templates SET status = $1::varchar, rejection_reason = CASE WHEN $1::varchar = 'rejected' THEN $2 ELSE rejection_reason END,
           updated_at = NOW() WHERE id = $3`,
        [r.status, r.rejected_reason || r.meta_status || null, t.id]
      );
      changed++;
    }
  }
  return { checked: rows.length, changed };
}

// How many of the missing ideas to write in each language: Hindi and Hinglish quotas first, rest English.
function missingByLang(c, liveGroups, niche) {
  const have = { en: 0, hing: 0, hi: 0 };
  for (const g of liveGroups) have[langOfGroup(g, niche)]++;
  const hi = Math.min(c.hindiIdeas, c.groups);
  const hing = Math.min(c.hinglishIdeas, c.groups - hi);
  const target = { hi, hing, en: c.groups - hi - hing };
  let room = Math.max(0, c.groups - liveGroups.length);
  const out = { hi: 0, hing: 0, en: 0 };
  for (const lang of ['hi', 'hing', 'en']) {
    out[lang] = Math.min(Math.max(0, target[lang] - have[lang]), room);
    room -= out[lang];
  }
  // Pool short but every language at its quota (old groups count as English) → top up in English.
  out.en += room;
  return out;
}

// Duplicate check, layer 1 (no AI): a version that shares most of its words with a live template of this
// niche is a reworded copy. The shared self-introduction is ignored, it is in every template by design.
const INTRO_WORDS = new Set(('chetan here from dreams technology gandhinagar make websites website business email and for the you your ' +
  'with are this that hai aap aapke aapka namaste hello main hum').split(' '));
const words = (s) => new Set(String(s || '').toLowerCase().replace(/\{\{1\}\}/g, ' ')
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !INTRO_WORDS.has(w)));
function wordOverlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}
const WORD_OVERLAP_MAX = 0.75;

// Layer 2 (GPT): the owner's rule is "not even a similar meaning". An idea that makes the same point as a
// live idea (in any language) or as another new idea is dropped; a version that is not about its own idea
// is dropped (the "tender" idea once came back with a "product catalogue" version).
async function dropDuplicates(niche, ideas, known, minVersions = 2) {
  const fresh = [];
  for (const idea of ideas) {
    const versions = (Array.isArray(idea.versions) ? idea.versions : [])
      .filter((v) => !known.some((k) => wordOverlap(v, k.body) >= WORD_OVERLAP_MAX));
    if (versions.length >= minVersions) fresh.push({ idea: idea.idea, versions });
  }
  if (!fresh.length) return { ideas: [], dropped: ideas.length };

  const list = (arr) => arr.map((x, i) => `${x.label}${i + 1}: ${x.text}`).join('\n') || '(none)';
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 800,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You check WhatsApp message templates for repeats. Texts may be English, Hinglish or Hindi; compare MEANING, not words or language. ' +
          'Two ideas are the same if they raise the same problem or ask about the same thing, even in different words ' +
          '(e.g. "enquiries get lost in WhatsApp" and "hard to keep track of customer messages" are the same).\n' +
          'For each NEW idea: same_as = the id of an EXISTING idea or an EARLIER new idea it repeats, else null. ' +
          'off_topic = the letters of its versions that are not about the idea named (a different problem than the other version).\n' +
          'Reply JSON only: {"ideas":[{"id":"N1","same_as":null,"off_topic":[]}]}',
      },
      {
        role: 'user',
        content:
          `EXISTING ideas:\n${list(known.map((k) => ({ label: 'E', text: k.body })))}\n\nNEW ideas:\n` +
          fresh.map((f, i) => `N${i + 1} (${f.idea}):\n${f.versions.map((v, j) => `  ${String.fromCharCode(97 + j)}) ${v}`).join('\n')}`).join('\n'),
      },
    ],
  }, { purpose: 'wa_template_dedupe' });
  const verdicts = JSON.parse(response.choices[0].message.content || '{}').ideas;
  if (!Array.isArray(verdicts)) throw new Error('duplicate check returned no verdicts'); // fail closed: write nothing
  const kept = [];
  fresh.forEach((f, i) => {
    const v = verdicts.find((x) => String(x.id).toUpperCase() === `N${i + 1}`);
    if (!v || v.same_as) return;
    const off = new Set((Array.isArray(v.off_topic) ? v.off_topic : []).map((l) => String(l).toLowerCase()));
    const versions = f.versions.filter((_, j) => !off.has(String.fromCharCode(97 + j)));
    if (versions.length >= minVersions) kept.push({ idea: f.idea, versions });
  });
  return { ideas: kept, dropped: ideas.length - kept.length };
}

// Retire one template: delete it on Meta if it was ever submitted (frees a slot under Meta's 250 cap),
// and keep the row as status 'retired' so outreach_logs.template_id — and the Inbox text — survive.
// A failed Meta delete leaves the row untouched (retried next run) unless Meta says it's already gone.
async function retireTemplate(t, reason) {
  if (t.status !== 'draft') {
    const del = await WABAService.deleteFromMeta(t.template_name);
    if (!del.success && !/does not exist|not found|no template/i.test(del.error || '')) {
      return { template: t.template_name, retired: false, error: del.error };
    }
  }
  await pool.query(
    `UPDATE waba_templates SET status = 'retired', quality_note = $2, updated_at = NOW() WHERE id = $1`,
    [t.id, String(reason).slice(0, 250)]
  );
  return { template: t.template_name, retired: true, reason };
}

// Sends per template (every outreach_logs row that used it).
async function sendCounts(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(
    `SELECT template_id, COUNT(*)::int AS n FROM outreach_logs WHERE template_id = ANY($1) GROUP BY template_id`, [ids]
  );
  return new Map(r.rows.map((x) => [x.template_id, x.n]));
}

// Retire auto templates that reached the send limit. templateId → check just that one (after a send).
async function retireUsedUp({ templateId = null, c = null } = {}) {
  const conf = c || (await cfg());
  const { rows } = await pool.query(
    `SELECT t.* FROM waba_templates t
     WHERE t.auto_generated AND t.template_group IS NOT NULL AND t.status = 'approved'
       AND ($1::int IS NULL OR t.id = $1)
       AND (SELECT COUNT(*) FROM outreach_logs o WHERE o.template_id = t.id) >= $2`,
    [templateId, conf.retireAfter]
  );
  const out = [];
  for (const t of rows) out.push(await retireTemplate(t, `Retired after ${conf.retireAfter} sends — a fresh message replaces it`));
  return out;
}

// Keep a niche within groups × variants live templates: the best ideas stay (approved first, then
// fewest sends, then highest score, then oldest), and within an idea the best versions; the rest retire.
async function trimNiche(niche, c) {
  const { rows } = await pool.query(
    `SELECT * FROM waba_templates WHERE LOWER(industry) = $1 AND auto_generated AND template_group IS NOT NULL AND status = ANY($2)`,
    [niche, LIVE_STATUSES]
  );
  if (rows.length <= c.groups * c.variants) return [];
  const sends = await sendCounts(rows.map((r) => r.id));
  const rank = (t) => [t.status === 'approved' ? 0 : t.status === 'pending_approval' ? 1 : 2, sends.get(t.id) || 0, -Number(t.quality_score || 0), t.id];
  const cmp = (a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const byGroup = new Map();
  for (const t of [...rows].sort(cmp)) {
    if (!byGroup.has(t.template_group)) byGroup.set(t.template_group, []);
    byGroup.get(t.template_group).push(t);
  }
  const keep = new Set();
  [...byGroup.values()].slice(0, c.groups).forEach((versions) => versions.slice(0, c.variants).forEach((t) => keep.add(t.id)));
  const out = [];
  for (const t of rows) {
    if (!keep.has(t.id)) out.push(await retireTemplate(t, `Retired: over the limit of ${c.groups * c.variants} live templates for ${niche}`));
  }
  return out;
}

async function ensureNiche(niche, c) {
  const result = { niche, wrote: [], dropped: 0, duplicates: 0, bestScore: null, feedback: null };
  const existing = await pool.query(
    `SELECT body_text, rejection_reason, status, template_group FROM waba_templates
     WHERE LOWER(industry) = $1 AND template_group IS NOT NULL ORDER BY id DESC LIMIT 80`,
    [niche]
  );
  // One representative text per live idea — what new ideas must not repeat.
  const liveByGroup = new Map();
  for (const r of existing.rows) {
    if (['approved', 'pending_approval', 'draft'].includes(r.status) && !liveByGroup.has(r.template_group)) liveByGroup.set(r.template_group, r.body_text);
  }
  const missing = missingByLang(c, [...liveByGroup.keys()], niche);
  if (missing.en + missing.hing + missing.hi <= 0) return result;
  if (!isAiAvailable()) return { ...result, aiSkipped: true };

  const known = [...liveByGroup.values()].map((body) => ({ body }));
  const avoid = existing.rows.filter((r) => r.status !== 'rejected').map((r) => r.body_text).slice(0, 15);
  const rejections = [...new Set(existing.rows.map((r) => r.rejection_reason).filter(Boolean))].slice(0, 5);

  for (const lang of ['en', 'hing', 'hi']) {
    let feedback = null;
    let need = missing[lang];
    for (let round = 1; round <= 2 && need > 0; round++) {
      // Draft at least 2 versions so there is a choice; keep only the best c.variants of them.
      const ideas = await writeIdeas(niche, need, Math.max(c.variants, 2), avoid, rejections, feedback, lang);
      const distinct = await dropDuplicates(niche, ideas, known, c.variants);
      result.duplicates += distinct.dropped;
      const scored = await scoreIdeas(niche, distinct.ideas, c.minScore, c.variants);
      result.dropped += ideas.length - scored.kept.length;
      if (scored.best !== null && (result.bestScore === null || scored.best > result.bestScore)) result.bestScore = scored.best;
      if (scored.feedback) result.feedback = scored.feedback;
      for (const k of scored.kept.slice(0, need)) {
        result.wrote.push(...(await insertGroup(niche, k.idea, k.versions.slice(0, c.variants), lang)));
        known.push({ body: k.versions[0].body });
        avoid.push(k.versions[0].body);
        need--;
      }
      feedback = [scored.feedback, distinct.dropped ? `${distinct.dropped} idea(s) repeated an existing idea, pick a clearly different problem` : '']
        .filter(Boolean).join(' | ') || null;
    }
  }
  return result;
}

// Last run's outcome, kept in the settings table so the page (and the daily health alert) can say
// "no templates were written" even when the run was the unattended 10:05 job.
const LAST_RUN_KEY = 'WA_TEMPLATE_LAST_RUN';
async function saveLastRun(run) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [LAST_RUN_KEY, JSON.stringify(run)]
  ).catch((err) => console.error('[TemplatePool] could not save last run:', err.message));
}
async function lastRun() {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [LAST_RUN_KEY]);
    return r.rows[0]?.value ? JSON.parse(r.rows[0].value) : null;
  } catch { return null; }
}

// Daily job / "Run now": top up every niche, submit what passed, sync pending.
// One run at a time — a run is ~30 GPT calls per niche, and a second click (or a second tab) used to
// start a parallel run that doubled the cost and raced the inserts.
let running = null;
async function ensurePool() {
  if (running) return { alreadyRunning: true, startedAt: running, status: await poolStatus(), lastRun: await lastRun() };
  running = new Date().toISOString();
  try {
    return await runEnsurePool();
  } finally {
    running = null;
  }
}

async function runEnsurePool() {
  const c = await cfg();
  const niches = await activeNiches();
  // Retire first, so the top-up below replaces what was retired in the same run.
  const retired = await retireUsedUp({ c }).catch((err) => [{ error: err.message }]);
  const perNiche = [];
  for (const niche of niches) {
    try {
      retired.push(...(await trimNiche(niche, c)));
      perNiche.push(await ensureNiche(niche, c));
    } catch (err) {
      perNiche.push({ niche, error: err.message });
    }
  }
  const submitted = c.autoSubmit ? await submitDrafts() : [];
  const synced = await syncPending().catch((err) => ({ error: err.message }));
  const summary = { config: c, niches: perNiche, retired, submitted, synced };
  if (retired.length) console.log(`[TemplatePool] retired: ${JSON.stringify(retired)}`);
  if (perNiche.some((n) => n.wrote?.length) || submitted.length) console.log(`[TemplatePool] ${JSON.stringify(summary)}`);
  const wrote = perNiche.reduce((n, x) => n + (x.wrote?.length || 0), 0);
  const scores = perNiche.map((x) => x.bestScore).filter((x) => x !== null && x !== undefined);
  const run = {
    at: new Date().toISOString(),
    wrote,
    submitted: submitted.length,
    minScore: c.minScore,
    bestScore: scores.length ? Math.max(...scores) : null,
    aiSkipped: perNiche.some((x) => x.aiSkipped),
    errors: perNiche.filter((x) => x.error).map((x) => `${x.niche}: ${x.error}`),
    feedback: perNiche.map((x) => x.feedback).filter(Boolean)[0] || null,
  };
  await saveLastRun(run);
  if (!wrote) console.warn(`[TemplatePool] run wrote no templates: ${JSON.stringify(run)}`);
  return { ...summary, lastRun: run, status: await poolStatus() };
}

const isRunning = () => !!running;

module.exports = {
  ensurePool, ensureNiche, poolStatus, lastRun, isRunning, submitDrafts, syncPending, validateBody, activeNiches, wordOverlap,
  retireUsedUp, trimNiche, retireTemplate, GENERIC_NICHE,
};
