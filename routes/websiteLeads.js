const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const settingsService = require('../services/settingsService');
const { alertOwner } = require('../services/ownerAlertService');
const { stopCadence } = require('../services/cadenceReplyService');

const router = express.Router();

// POST /api/public/website-lead — the "Let's Connect" form on our own website posts here
// (server-to-server from the site's PHP handler, never from the browser, so the key stays secret).
// Public under /api (see PUBLIC_API in authService.js); guarded by the X-Lead-Key header, which must
// match settings key WEBSITE_LEAD_KEY. Unset key = endpoint disabled.
//
// These are inbound, warm leads: saved as source='website', status='interested', needs_attention so a
// human calls them back, and the owner gets a WhatsApp alert. status='interested' keeps them out of
// runFollowUps (status='new' only) and the directory cadence, so no cold template ever goes to them.
// A visitor who is already a lead (same email or mobile) is updated, not duplicated, and any cold
// cadence/sequence to them is stopped.

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function normalizeMobile(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d.length >= 10 && d.length <= 15 ? d : '';
}

function keyMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/website-lead', async (req, res) => {
  const expected = await settingsService.getSetting('WEBSITE_LEAD_KEY');
  if (!expected) return res.status(503).json({ ok: false, error: 'Website lead intake is not configured (WEBSITE_LEAD_KEY).' });
  if (!keyMatches(req.get('x-lead-key'), expected)) return res.status(401).json({ ok: false, error: 'Bad key.' });

  const b = req.body || {};
  const form = {
    name: clean(b.name, 120),
    mobile: clean(b.mobile, 30),
    email: clean(b.email, 200).toLowerCase(),
    company: clean(b.company, 200),
    city: clean(b.city, 100),
    need: clean(b.need, 120),
    budget: clean(b.budget, 60),
    timeline: clean(b.timeline, 60),
    message: clean(b.message, 2000),
    page_url: clean(b.page_url, 500),
    utm_source: clean(b.utm_source, 100),
    utm_medium: clean(b.utm_medium, 100),
    utm_campaign: clean(b.utm_campaign, 150),
    ip: clean(b.ip, 64),
    submitted_at: new Date().toISOString(),
  };
  const mobile = normalizeMobile(form.mobile);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) ? form.email : '';

  if (!form.name) return res.status(400).json({ ok: false, error: 'name is required.' });
  if (!mobile && !email) return res.status(400).json({ ok: false, error: 'A valid mobile or email is required.' });

  const reason = ['Website enquiry', form.need, form.budget && `budget ${form.budget}`, form.timeline && `start ${form.timeline}`]
    .filter(Boolean).join(' · ').slice(0, 250);

  try {
    const existing = await pool.query(
      `SELECT id FROM hotel_leads
        WHERE ($1 <> '' AND LOWER(email) = $1) OR ($2 <> '' AND whatsapp_number = $2)
        ORDER BY id LIMIT 1`,
      [email, mobile]
    );

    let leadId;
    let isNew = false;
    if (existing.rows.length) {
      leadId = existing.rows[0].id;
      await pool.query(
        `UPDATE hotel_leads
            SET website_form = $2::jsonb, website_form_at = NOW(),
                email = CASE WHEN COALESCE(email, '') = '' THEN $3 ELSE email END,
                whatsapp_number = CASE WHEN COALESCE(whatsapp_number, '') = '' THEN $4 ELSE whatsapp_number END,
                status = CASE WHEN status IN ('new', 'no_response', 'dead', 'stalled') THEN 'interested' ELSE status END,
                needs_attention = TRUE, needs_attention_reason = $5, updated_at = NOW()
          WHERE id = $1`,
        [leadId, JSON.stringify(form), email, mobile, reason]
      );
      await stopCadence(leadId, 'replied', 'website_form');
    } else {
      isNew = true;
      const ins = await pool.query(
        `INSERT INTO hotel_leads
           (hotel_name, owner_name, email, whatsapp_number, phone, city, source, status, channel,
            email_status, email_source, business_category, needs_attention, needs_attention_reason,
            website_form, website_form_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'website', 'interested', $7,
                 $8, $9, $10, TRUE, $11, $12::jsonb, NOW())
         RETURNING id`,
        [form.company || form.name, form.name, email, mobile, mobile || null, form.city,
         mobile ? 'whatsapp' : 'email', email ? 'found' : 'unknown', email ? 'website_form' : null,
         form.need || null, reason, JSON.stringify(form)]
      );
      leadId = ins.rows[0].id;
    }

    // Fire-and-forget: the website must get its answer fast even if Meta is slow.
    alertOwner(
      isNew ? 'New website lead' : 'Website enquiry (existing lead)',
      [form.name, mobile && `+${mobile}`, email, form.need, form.budget && `Budget ${form.budget}`,
       form.timeline && `Start ${form.timeline}`].filter(Boolean).join(' | ')
    ).catch((err) => console.error('[website-lead] owner alert failed:', err.message));

    console.log(`[website-lead] ${isNew ? 'created' : 'updated'} lead ${leadId} (${form.name})`);
    return res.json({ ok: true, lead_id: leadId, created: isNew });
  } catch (err) {
    console.error('[website-lead] save failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not save the lead.' });
  }
});

module.exports = router;
