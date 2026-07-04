const pool = require('../config/db');

class LeadService {
  // Add leads (bulk) — skips duplicates by hotel_name + city
  static async addLeads(leadsArray) {
    try {
      const inserted = [];
      const skipped = [];
      for (const lead of leadsArray) {
        // Duplicate check
        const dup = await pool.query(
          'SELECT id FROM hotel_leads WHERE hotel_name = $1 AND (city = $2 OR city IS NULL)',
          [lead.hotel_name, lead.city || '']
        );
        if (dup.rows.length > 0) {
          skipped.push({ id: dup.rows[0].id, hotel_name: lead.hotel_name, duplicate: true });
          continue;
        }
        const result = await pool.query(
          `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, source, status)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'new')) RETURNING id, hotel_name`,
          [lead.hotel_name, lead.owner_name || '', lead.email || '',
           lead.whatsapp_number || '', lead.city || '', lead.source || 'manual', lead.status || null]
        );
        if (result.rows.length > 0) inserted.push(result.rows[0]);
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
