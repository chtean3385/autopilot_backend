const pool = require('../config/db');

class TemplateService {
  // Create/register template
  static async createTemplate(templateData) {
    const query = `
      INSERT INTO waba_templates
      (template_name, template_category, body_text, parameters, examples, footer_text, status, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
      RETURNING *;
    `;
    try {
      const result = await pool.query(query, [
        templateData.template_name,
        templateData.template_category,
        templateData.body_text,
        JSON.stringify(templateData.parameters || {}),
        JSON.stringify(templateData.examples || []),
        templateData.footer_text || null,
        'admin'
      ]);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error('Error creating template:', error);
      return { success: false, error: error.message };
    }
  }

  // Get all templates
  static async getAllTemplates() {
    const query = 'SELECT * FROM waba_templates ORDER BY created_at DESC';
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error fetching templates:', error);
      return [];
    }
  }

  // Get approved templates only
  static async getApprovedTemplates() {
    const query = "SELECT * FROM waba_templates WHERE status = 'approved' ORDER BY created_at DESC";
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error fetching approved templates:', error);
      return [];
    }
  }

  // Get template by name
  static async getTemplateByName(templateName) {
    const query = 'SELECT * FROM waba_templates WHERE template_name = $1';
    try {
      const result = await pool.query(query, [templateName]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error fetching template:', error);
      return null;
    }
  }

  // Update template status
  static async updateTemplateStatus(templateId, status) {
    const query = 'UPDATE waba_templates SET status = $1 WHERE id = $2 RETURNING *';
    try {
      const result = await pool.query(query, [status, templateId]);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error('Error updating template:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = TemplateService;
