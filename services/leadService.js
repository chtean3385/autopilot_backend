const pool = require('../config/db');
const { verifyEmail } = require('./emailVerifierService');

class LeadService {
  // Add leads (bulk) — skips duplicates by email (when present) or hotel_name + city.
  // Every email-channel lead is run through the verifier here — this is the single
  // choke point both the bulk-domain scrape and CSV import flow through, so it's the
  // one place that can guarantee "no unverified email enters a sequence" (enrollLeads
  // also re-checks email_status === 'verified', but the value has to be set correctly
  // at insert time for that check to mean anything).
  static async addLeads(leadsArray) {
    try {
      const inserted = [];
      const skipped = [];
      for (const lead of leadsArray) {
        // Duplicate check — an email address should never appear on two leads,
        // regardless of hotel_name/city (GPT-derived owner names vary run to run).
        const dup = lead.email
          ? await pool.query('SELECT id FROM hotel_leads WHERE LOWER(email) = LOWER($1)', [lead.email])
          : await pool.query(
              'SELECT id FROM hotel_leads WHERE hotel_name = $1 AND (city = $2 OR city IS NULL)',
              [lead.hotel_name, lead.city || '']
            );
        if (dup.rows.length > 0) {
          skipped.push({ id: dup.rows[0].id, hotel_name: lead.hotel_name, duplicate: true });
          continue;
        }

        let emailStatus = lead.email_status || (lead.email ? 'found' : 'unknown');
        if (lead.channel === 'email' && lead.email) {
          const verification = await verifyEmail(lead.email);
          // 'error' means the verifier couldn't be reached / isn't configured — leave it
          // as 'unknown' rather than falsely branding it undeliverable. Only an explicit
          // non-deliverable result from the provider earns 'unverifiable'.
          emailStatus = verification.status === 'error'
            ? 'unknown'
            : (verification.valid ? 'verified' : 'unverifiable');
        }

        const result = await pool.query(
          `INSERT INTO hotel_leads
             (hotel_name, owner_name, email, whatsapp_number, city, source, status,
              channel, website, email_status, email_source)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'new'), $8, $9, $10, $11)
           RETURNING id, hotel_name`,
          [lead.hotel_name, lead.owner_name || '', lead.email || '',
           lead.whatsapp_number || '', lead.city || '', lead.source || 'manual', lead.status || null,
           lead.channel || 'whatsapp', lead.website || '',
           emailStatus, lead.email_source || null]
        );
        if (result.rows.length > 0) inserted.push({ ...result.rows[0], email_status: emailStatus });
      }
      return { success: true, added: inserted.length, skipped: skipped.length, inserted, skippedList: skipped };
    } catch (error) {
      console.error('Error adding leads:', error);
      return { success: false, error: error.message };
    }
  }

  // Get all leads
  static async getAllLeads(filters = {}) {
    let query = 'SELECT * FROM hotel_leads WHERE 1=1';
    const params = [];

    if (filters.city) {
      query += ` AND city = $${params.length + 1}`;
      params.push(filters.city);
    }
    if (filters.status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(filters.status);
    }
    if (filters.channel) {
      query += ` AND channel = $${params.length + 1}`;
      params.push(filters.channel);
    }

    query += ' ORDER BY created_at DESC';

    try {
      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Error fetching leads:', error);
      return [];
    }
  }

  // Update lead status
  static async updateLeadStatus(leadId, status) {
    const query = 'UPDATE hotel_leads SET status = $1, updated_at = NOW() WHERE id = $2';
    try {
      await pool.query(query, [status, leadId]);
      return { success: true };
    } catch (error) {
      console.error('Error updating lead:', error);
      return { success: false, error: error.message };
    }
  }

  // Log outreach
  static async logOutreach(leadId, campaignId, templateId, wabaMessageId) {
    const query = `
      INSERT INTO outreach_logs
      (lead_id, campaign_id, template_id, waba_message_id, message_type, sent_at)
      VALUES ($1, $2, $3, $4, 'template', NOW())
      RETURNING id;
    `;
    try {
      const result = await pool.query(query, [leadId, campaignId, templateId, wabaMessageId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error logging outreach:', error);
      return null;
    }
  }

  // Get outreach stats
  static async getOutreachStats(campaignId) {
    const query = `
      SELECT
        COUNT(*) as total_sent,
        SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) as total_delivered,
        SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) as total_read,
        SUM(CASE WHEN response_received = true THEN 1 ELSE 0 END) as total_responses,
        SUM(CASE WHEN qualified_for_demo = true THEN 1 ELSE 0 END) as demo_qualified
      FROM outreach_logs
      WHERE campaign_id = $1;
    `;
    try {
      const result = await pool.query(query, [campaignId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error getting stats:', error);
      return null;
    }
  }
}

module.exports = LeadService;
