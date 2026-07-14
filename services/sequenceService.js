const pool = require('../config/db');

class SequenceService {
  static async getAll() {
    const result = await pool.query('SELECT * FROM sequences ORDER BY created_at DESC');
    return result.rows;
  }

  static async getById(id) {
    const result = await pool.query('SELECT * FROM sequences WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  static async create(data) {
    const result = await pool.query(
      `INSERT INTO sequences
         (name, channel, initial_gaps, recurring_interval_days, daily_send_limit, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.name,
        data.channel || 'email',
        JSON.stringify(data.initial_gaps ?? [1, 2, 3]),
        data.recurring_interval_days ?? 7,
        data.daily_send_limit ?? 20,
        data.active ?? true,
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

    if (data.name !== undefined) set('name', data.name);
    if (data.channel !== undefined) set('channel', data.channel);
    if (data.initial_gaps !== undefined) set('initial_gaps', JSON.stringify(data.initial_gaps));
    if (data.recurring_interval_days !== undefined) set('recurring_interval_days', data.recurring_interval_days);
    if (data.daily_send_limit !== undefined) set('daily_send_limit', data.daily_send_limit);
    if (data.active !== undefined) set('active', data.active);

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const result = await pool.query(
      `UPDATE sequences SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  static async delete(id) {
    await pool.query('DELETE FROM sequences WHERE id = $1', [id]);
    return { success: true };
  }

  // Starts leads down a sequence — the email equivalent of "launching" a WhatsApp campaign.
  // Only email-channel leads with a *verified* address are enrolled (mandatory verification
  // guardrail — see leadService.addLeads, which is where email_status gets set); leads already
  // mid-sequence (active/paused/waiting_estimate, in any sequence) are skipped to avoid double-enrolling.
  static async enrollLeads(sequenceId, leadIds) {
    const sequence = await this.getById(sequenceId);
    if (!sequence) return { success: false, error: 'Sequence not found' };

    const leadsResult = await pool.query(
      `SELECT id, email, channel, email_status FROM hotel_leads WHERE id = ANY($1::int[])`,
      [leadIds]
    );
    const leadsById = new Map(leadsResult.rows.map(l => [l.id, l]));

    const existingResult = await pool.query(
      `SELECT DISTINCT lead_id FROM lead_sequences
       WHERE lead_id = ANY($1::int[]) AND status IN ('active', 'paused', 'waiting_estimate')`,
      [leadIds]
    );
    const alreadyEnrolled = new Set(existingResult.rows.map(r => r.lead_id));

    let enrolled = 0;
    let skippedNotEligible = 0;
    let skippedUnverified = 0;
    let skippedAlreadyEnrolled = 0;

    for (const id of leadIds) {
      const lead = leadsById.get(id);
      if (!lead || lead.channel !== 'email' || !lead.email) { skippedNotEligible++; continue; }
      if (alreadyEnrolled.has(id)) { skippedAlreadyEnrolled++; continue; }
      if (lead.email_status !== 'verified') { skippedUnverified++; continue; }
      await pool.query(
        `INSERT INTO lead_sequences (lead_id, sequence_id, current_step, next_run_at, status)
         VALUES ($1, $2, 0, NOW(), 'active')`,
        [id, sequenceId]
      );
      enrolled++;
    }

    return { success: true, enrolled, skippedNotEligible, skippedUnverified, skippedAlreadyEnrolled };
  }

  // Zero out sent_today for any sequence whose counter is from a previous day
  static async resetStaleCounters() {
    await pool.query(
      `UPDATE sequences SET sent_today = 0, last_reset_date = CURRENT_DATE
       WHERE last_reset_date IS DISTINCT FROM CURRENT_DATE OR last_reset_date IS NULL`
    );
  }

  static async incrementSentToday(id) {
    await pool.query(
      `UPDATE sequences SET sent_today = 0, last_reset_date = CURRENT_DATE
       WHERE id = $1 AND (last_reset_date IS DISTINCT FROM CURRENT_DATE OR last_reset_date IS NULL)`,
      [id]
    );
    await pool.query('UPDATE sequences SET sent_today = sent_today + 1 WHERE id = $1', [id]);
  }
}

module.exports = SequenceService;
