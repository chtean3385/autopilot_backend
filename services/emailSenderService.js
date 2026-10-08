const pool = require('../config/db');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { isDryRun, dryRunResult } = require('../utils/dryRun');
const { getSetting, setSetting } = require('./settingsService');

const WARMUP_START_CAP = 10; // day 1 daily cap during warmup
const WARMUP_STEP = 10;      // added per full week elapsed
const ROTATION_BATCH_DEFAULT = 10;                   // new leads per sender before moving to the next
const ROTATION_STATE_KEY = 'EMAIL_ROTATION_STATE';
const COMPANY_LINE = 'Dreams Technology, Gandhinagar · +91 84607 65785';
const WEBSITE_LINE = 'https://dreamstechnology.in/';

class EmailSenderService {
  static async getAll() {
    const result = await pool.query('SELECT * FROM email_senders ORDER BY created_at DESC');
    return result.rows;
  }

  static async getById(id) {
    const result = await pool.query('SELECT * FROM email_senders WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  static async create(data) {
    const result = await pool.query(
      `INSERT INTO email_senders
         (label, provider, api_key, smtp_config, from_name, from_email, sending_domain,
          daily_cap, warmup_started_at, sent_today, last_reset_date, imap_config, status, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), 0, CURRENT_DATE, $10, COALESCE($11, 'active'), $12)
       RETURNING *`,
      [
        data.label,
        data.provider || 'brevo',
        data.api_key || null,
        data.smtp_config ? JSON.stringify(data.smtp_config) : null,
        data.from_name || null,
        data.from_email,
        data.sending_domain || null,
        data.daily_cap ?? 20,
        data.warmup_started_at || null,
        data.imap_config ? JSON.stringify(data.imap_config) : null,
        data.status || null,
        data.signature ? String(data.signature).trim() : null,
      ]
    );
    return result.rows[0];
  }

  static async update(id, data) {
    const fields = [];
    const values = [];
    let i = 1;

    const set = (column, value) => {
      fields.push(`${column} = $${i++}`);
      values.push(value);
    };

    // A blank password in an edit means "leave it as-is", not "erase it" — the frontend never
    // round-trips the real secret back into the form, so an untouched password field always
    // submits blank. Without this merge, saving ANY change to a sender (even just the label)
    // would silently wipe its stored IMAP/SMTP password.
    let existing = null;
    const needsExisting = (data.imap_config && !data.imap_config.pass) || (data.smtp_config && !data.smtp_config.pass) || data.api_key === '';
    if (needsExisting) existing = await this.getById(id);

    if (data.label !== undefined) set('label', data.label);
    if (data.provider !== undefined) set('provider', data.provider);
    if (data.api_key !== undefined) {
      set('api_key', data.api_key === '' ? (existing?.api_key ?? null) : data.api_key);
    }
    if (data.smtp_config !== undefined) {
      let smtpConfig = data.smtp_config;
      if (smtpConfig && !smtpConfig.pass) {
        const existingSmtp = typeof existing?.smtp_config === 'string' ? JSON.parse(existing.smtp_config || '{}') : (existing?.smtp_config || {});
        smtpConfig = { ...smtpConfig, pass: existingSmtp.pass };
      }
      set('smtp_config', smtpConfig ? JSON.stringify(smtpConfig) : null);
    }
    if (data.from_name !== undefined) set('from_name', data.from_name);
    if (data.from_email !== undefined) set('from_email', data.from_email);
    if (data.sending_domain !== undefined) set('sending_domain', data.sending_domain);
    if (data.daily_cap !== undefined) set('daily_cap', data.daily_cap);
    if (data.warmup_started_at !== undefined) set('warmup_started_at', data.warmup_started_at);
    if (data.imap_config !== undefined) {
      let imapConfig = data.imap_config;
      if (imapConfig && !imapConfig.pass) {
        const existingImap = typeof existing?.imap_config === 'string' ? JSON.parse(existing.imap_config || '{}') : (existing?.imap_config || {});
        imapConfig = { ...imapConfig, pass: existingImap.pass };
      }
      set('imap_config', imapConfig ? JSON.stringify(imapConfig) : null);
    }
    if (data.status !== undefined) set('status', data.status);
    if (data.signature !== undefined) set('signature', String(data.signature || '').trim() || null);

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const result = await pool.query(
      `UPDATE email_senders SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  static async setStatus(id, status) {
    const result = await pool.query(
      'UPDATE email_senders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    return result.rows[0] || null;
  }

  static pause(id) { return this.setStatus(id, 'paused'); }
  static activate(id) { return this.setStatus(id, 'active'); }

  static async delete(id) {
    await pool.query('DELETE FROM email_senders WHERE id = $1', [id]);
    return { success: true };
  }

  // Effective cap during warmup: week 1 = 10/day, +10 per full week elapsed, capped at daily_cap
  static effectiveDailyCap(sender) {
    if (!sender.warmup_started_at) return sender.daily_cap;
    const daysElapsed = (Date.now() - new Date(sender.warmup_started_at).getTime()) / 86400000;
    const weeksElapsed = Math.max(0, Math.floor(daysElapsed / 7));
    const ramp = WARMUP_START_CAP + weeksElapsed * WARMUP_STEP;
    return Math.min(ramp, sender.daily_cap);
  }

  // Zero out sent_today for any sender whose counter is from a previous day
  static async resetStaleCounters() {
    await pool.query(
      `UPDATE email_senders SET sent_today = 0, last_reset_date = CURRENT_DATE
       WHERE last_reset_date IS DISTINCT FROM CURRENT_DATE OR last_reset_date IS NULL`
    );
  }

  static async incrementSentCount(senderId) {
    await pool.query(
      `UPDATE email_senders SET sent_today = 0, last_reset_date = CURRENT_DATE
       WHERE id = $1 AND (last_reset_date IS DISTINCT FROM CURRENT_DATE OR last_reset_date IS NULL)`,
      [senderId]
    );
    await pool.query('UPDATE email_senders SET sent_today = sent_today + 1 WHERE id = $1', [senderId]);
  }

  // Sign-off for mail sent from this mailbox: its own signature if set, else the EMAIL_SIGNATURE
  // setting, else "<From name> / Dreams Technology, Gandhinagar · phone / website" on three lines.
  // A literal "\n" typed into a one-line settings box becomes a real line break.
  static async signatureFor(sender) {
    const own = String(sender?.signature || '').trim();
    if (own) return own.replace(/\\n/g, '\n');
    const global = String((await getSetting('EMAIL_SIGNATURE')) || '').trim();
    if (global) return global.replace(/\\n/g, '\n');
    const name = String(sender?.from_name || '').trim() || 'Chetan Makwana';
    return `${name}\n${COMPANY_LINE}\n${WEBSITE_LINE}`;
  }

  static hasCapacity(sender) {
    return this.effectiveDailyCap(sender) - sender.sent_today > 0;
  }

  // Active sender with the most remaining quota today — for one-off internal mail (owner alerts)
  // that must not consume a slot in the new-lead rotation below.
  static async pickAnyActiveSender() {
    await this.resetStaleCounters();
    const result = await pool.query(`SELECT * FROM email_senders WHERE status = 'active'`);
    let best = null;
    let bestRemaining = 0;
    for (const sender of result.rows) {
      const remaining = this.effectiveDailyCap(sender) - sender.sent_today;
      if (remaining > bestRemaining) {
        best = sender;
        bestRemaining = remaining;
      }
    }
    return best;
  }

  // Mailbox for a lead's FIRST email. Block rotation: EMAIL_ROTATION_BATCH (default 10) new leads
  // from sender A, then the next 10 from B, … in id order, wrapping around. A sender that is paused
  // or out of today's capacity is skipped. Each call takes one slot, so only call it when about to
  // send. Position is kept in settings key EMAIL_ROTATION_STATE ({ senderId, count }).
  static async pickSenderForRotation() {
    await this.resetStaleCounters();
    const result = await pool.query(`SELECT * FROM email_senders WHERE status = 'active' ORDER BY id`);
    const eligible = result.rows.filter(s => this.hasCapacity(s));
    if (eligible.length === 0) return null;

    const batch = Number.parseInt(await getSetting('EMAIL_ROTATION_BATCH'), 10) || ROTATION_BATCH_DEFAULT;
    let state = {};
    try { state = JSON.parse(await getSetting(ROTATION_STATE_KEY) || '{}'); } catch { /* reset below */ }

    const current = eligible.find(s => s.id === state.senderId);
    let pick;
    let count;
    if (current && (state.count || 0) < batch) {
      pick = current;
      count = (state.count || 0) + 1;
    } else {
      pick = eligible.find(s => s.id > (state.senderId ?? 0)) || eligible[0];
      count = 1;
    }
    await setSetting(ROTATION_STATE_KEY, JSON.stringify({ senderId: pick.id, count }));
    return pick;
  }

  // Mailbox that last emailed this lead (email_logs covers sequences, cadence and replies;
  // lead_sequences.sender_id is a fallback for rows that predate sender_id on email_logs)
  static async getPriorSenderId(leadId) {
    const logged = await pool.query(
      `SELECT sender_id FROM email_logs
       WHERE lead_id = $1 AND direction = 'out' AND sender_id IS NOT NULL AND error IS NULL
       ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`,
      [leadId]
    );
    if (logged.rows[0]) return logged.rows[0].sender_id;
    const seq = await pool.query(
      `SELECT sender_id FROM lead_sequences
       WHERE lead_id = $1 AND sender_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
      [leadId]
    );
    return seq.rows[0]?.sender_id || null;
  }

  // Follow-ups always go from the mailbox that sent the first email. If that mailbox is paused or
  // out of today's capacity, returns null and the caller waits — it never switches mailbox mid-thread.
  // Only if the mailbox was deleted does the lead go back into rotation.
  // { strict: false } (human-triggered proposals/estimates, replies to a lead who wrote back) keeps
  // the old behaviour: prior mailbox if active regardless of cap, else any active sender.
  static async getSenderForLead(leadId, { strict = true } = {}) {
    await this.resetStaleCounters();
    const priorId = await this.getPriorSenderId(leadId);
    const prior = priorId ? await this.getById(priorId) : null;

    if (!strict) {
      if (prior && prior.status === 'active') return prior;
      return this.pickAnyActiveSender();
    }

    if (prior) {
      if (prior.status !== 'active' || !this.hasCapacity(prior)) return null;
      return prior;
    }
    return this.pickSenderForRotation();
  }

  // Optional extras beyond the body:
  // - unsubscribeUrl → RFC 8058 List-Unsubscribe + one-click POST headers (Gmail/Yahoo bulk-sender
  //   requirement; POST /unsubscribe?token=... already unsubscribes without confirmation)
  // - inReplyTo/references → RFC 5322 threading headers so replies/follow-ups land in the
  //   recipient's existing conversation (built by utils/emailThreading.js)
  static async send(sender, { to, subject, html, text, unsubscribeUrl, inReplyTo, references }) {
    if (isDryRun()) {
      const r = dryRunResult('email', `from ${sender.from_email} to ${to} — "${subject}" — ${String(text || '').slice(0, 200)}`);
      return { success: true, messageId: `<${r.messageId}@dryrun.local>`, dryRun: true };
    }
    try {
      let messageId;

      const extraHeaders = {};
      if (unsubscribeUrl) {
        extraHeaders['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
        extraHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      if (inReplyTo) extraHeaders['In-Reply-To'] = inReplyTo;
      if (references) extraHeaders['References'] = references;

      if (sender.provider === 'brevo') {
        const response = await axios.post(
          'https://api.brevo.com/v3/smtp/email',
          {
            sender: { name: sender.from_name || sender.label, email: sender.from_email },
            to: [{ email: to }],
            subject,
            htmlContent: html,
            textContent: text || undefined,
            ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
          },
          { headers: { 'api-key': sender.api_key, 'Content-Type': 'application/json' } }
        );
        messageId = response.data.messageId;
      } else if (sender.provider === 'smtp') {
        const cfg = typeof sender.smtp_config === 'string' ? JSON.parse(sender.smtp_config) : (sender.smtp_config || {});
        const transporter = nodemailer.createTransport({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure ?? cfg.port === 465,
          auth: { user: cfg.user, pass: cfg.pass },
        });
        const info = await transporter.sendMail({
          from: `"${sender.from_name || sender.label}" <${sender.from_email}>`,
          to,
          subject,
          html,
          text,
          headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        });
        messageId = info.messageId;
      } else {
        return { success: false, error: `Unknown provider: ${sender.provider}` };
      }

      await this.incrementSentCount(sender.id);
      return { success: true, messageId };
    } catch (error) {
      console.error('[EmailSender] send error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message, status: error.response?.status || null };
    }
  }
}

module.exports = EmailSenderService;
