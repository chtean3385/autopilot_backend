const pool = require('../config/db');
const axios = require('axios');
const nodemailer = require('nodemailer');

const WARMUP_START_CAP = 10; // day 1 daily cap during warmup
const WARMUP_STEP = 10;      // added per full week elapsed

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
          daily_cap, warmup_started_at, sent_today, last_reset_date, imap_config, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), 0, CURRENT_DATE, $10, COALESCE($11, 'active'))
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

    if (data.label !== undefined) set('label', data.label);
    if (data.provider !== undefined) set('provider', data.provider);
    if (data.api_key !== undefined) set('api_key', data.api_key);
    if (data.smtp_config !== undefined) set('smtp_config', data.smtp_config ? JSON.stringify(data.smtp_config) : null);
    if (data.from_name !== undefined) set('from_name', data.from_name);
    if (data.from_email !== undefined) set('from_email', data.from_email);
    if (data.sending_domain !== undefined) set('sending_domain', data.sending_domain);
    if (data.daily_cap !== undefined) set('daily_cap', data.daily_cap);
    if (data.warmup_started_at !== undefined) set('warmup_started_at', data.warmup_started_at);
    if (data.imap_config !== undefined) set('imap_config', data.imap_config ? JSON.stringify(data.imap_config) : null);
    if (data.status !== undefined) set('status', data.status);

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

  // Active sender with the most remaining quota today (effective cap minus already sent)
  static async pickSenderForRotation() {
    await this.resetStaleCounters();
    const result = await pool.query(`SELECT * FROM email_senders WHERE status = 'active'`);
    let best = null;
    let bestRemaining = 0;
    for (const sender of result.rows) {
      const remaining = this.effectiveDailyCap(sender) - sender.sent_today;
      if (remaining > 0 && remaining > bestRemaining) {
        best = sender;
        bestRemaining = remaining;
      }
    }
    return best;
  }

  // Sender previously used for this lead, if it's still active — keeps a thread on one mailbox
  static async getStickySender(leadId) {
    const result = await pool.query(
      `SELECT sender_id FROM lead_sequences
       WHERE lead_id = $1 AND sender_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
      [leadId]
    );
    const senderId = result.rows[0]?.sender_id;
    if (!senderId) return null;
    const sender = await this.getById(senderId);
    return sender && sender.status === 'active' ? sender : null;
  }

  // Sticky sender if the lead has one and it's still active, otherwise rotate
  static async getSenderForLead(leadId) {
    const sticky = await this.getStickySender(leadId);
    if (sticky) return sticky;
    return this.pickSenderForRotation();
  }

  // Optional extras beyond the body:
  // - unsubscribeUrl → RFC 8058 List-Unsubscribe + one-click POST headers (Gmail/Yahoo bulk-sender
  //   requirement; POST /unsubscribe?token=... already unsubscribes without confirmation)
  // - inReplyTo/references → RFC 5322 threading headers so replies/follow-ups land in the
  //   recipient's existing conversation (built by utils/emailThreading.js)
  static async send(sender, { to, subject, html, text, unsubscribeUrl, inReplyTo, references }) {
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
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }
}

module.exports = EmailSenderService;
