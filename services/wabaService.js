const axios = require('axios');
require('dotenv').config();

// WhatsApp Cloud API base URL (graph.facebook.com — NOT instagram)
const WABA_API_URL = `https://graph.facebook.com/${process.env.WABA_API_VERSION || 'v18.0'}`;

class WABAService {
  static async sendTemplateMessage(recipientPhone, templateName, parameters = [], headerImageUrl = null) {
    try {
      const components = [];

      if (headerImageUrl) {
        components.push({
          type: 'header',
          parameters: [{ type: 'image', image: { link: headerImageUrl } }]
        });
      }

      if (parameters.length > 0) {
        components.push({
          type: 'body',
          parameters: parameters.map(p => ({ type: 'text', text: String(p) }))
        });
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en_US' },
          components
        }
      };

      console.log(`[WABA] Sending template "${templateName}" to ${recipientPhone}`);

      const response = await axios.post(
        `${WABA_API_URL}/${process.env.WABA_PHONE_ID}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WABA_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`[WABA] Message sent. ID: ${response.data.messages[0].id}`);
      return { success: true, messageId: response.data.messages[0].id, timestamp: new Date() };
    } catch (error) {
      console.error('[WABA] Error sending message:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.error?.message || error.message };
    }
  }

  // template can be a string (template_name) or the full template object from DB
  static async sendPersonalizedTemplate(hotelLead, template) {
    const templateName   = typeof template === 'string' ? template : template.template_name;
    const bodyText       = typeof template === 'object' && template?.body_text ? template.body_text : '';
    const headerImageUrl = typeof template === 'object' ? (template.header_image_url || null) : null;

    // Count unique {{n}} variables in the body — only send exactly that many params
    const varMatches = bodyText.match(/\{\{\d+\}\}/g) || [];
    const varCount = [...new Set(varMatches)].length;

    // All possible params in order: {{1}} owner_name, {{2}} hotel_name, {{3}} city, {{4}} demo_link
    const allParams = [
      hotelLead.owner_name || hotelLead.hotel_name || '',
      hotelLead.hotel_name || '',
      hotelLead.city       || '',
      process.env.DEMO_LINK || 'https://resort.dreamstechnology.in',
    ];

    // Only pass as many params as the template actually uses
    const params = varCount > 0 ? allParams.slice(0, varCount) : [];

    return this.sendTemplateMessage(hotelLead.whatsapp_number, templateName, params, headerImageUrl);
  }

  // Submit a template to Meta for approval
  static async submitTemplateToMeta(templateData) {
    try {
      const components = [];

      // Header image component — if provided, include as IMAGE header
      if (templateData.header_image_url) {
        components.push({
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_handle: [templateData.header_image_url] }
        });
      }

      // Body component — detect {{n}} variables and add examples
      const bodyText = templateData.body_text;
      const varMatches = bodyText.match(/\{\{\d+\}\}/g) || [];
      const bodyComponent = { type: 'BODY', text: bodyText };
      if (varMatches.length > 0) {
        // Use the example values provided, or fallback to generic
        const examples = templateData.examples || varMatches.map((_, i) => `example_${i + 1}`);
        bodyComponent.example = { body_text: [examples] };
      }
      components.push(bodyComponent);

      if (templateData.footer_text) {
        components.push({ type: 'FOOTER', text: templateData.footer_text });
      }

      const payload = {
        name: templateData.template_name,
        language: 'en_US',
        category: templateData.template_category || 'MARKETING',
        components
      };

      console.log('[WABA] Submitting template to Meta:', payload.name);

      const response = await axios.post(
        `${WABA_API_URL}/${process.env.WABA_BUSINESS_ACCOUNT_ID}/message_templates`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WABA_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      console.error('[WABA] Template submit error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.error?.message || error.message };
    }
  }

  // Fetch current approval status from Meta
  static async syncTemplateStatus(templateName) {
    try {
      const response = await axios.get(
        `${WABA_API_URL}/${process.env.WABA_BUSINESS_ACCOUNT_ID}/message_templates?name=${templateName}`,
        { headers: { Authorization: `Bearer ${process.env.WABA_API_TOKEN}` } }
      );

      const template = response.data.data?.[0];
      if (!template) return { success: false, error: 'Template not found on Meta' };

      const statusMap = {
        APPROVED: 'approved',
        REJECTED: 'rejected',
        PENDING: 'pending_approval',
        PENDING_DELETION: 'pending_approval',
        DELETED: 'rejected',
        DISABLED: 'rejected',
        PAUSED: 'pending_approval'
      };

      return {
        success: true,
        status: statusMap[template.status] || 'pending_approval',
        meta_status: template.status,
        quality_score: template.quality_score,
        meta_id: String(template.id || ''),
      };
    } catch (error) {
      console.error('[WABA] Sync status error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.error?.message || error.message };
    }
  }

  // Delete template from Meta (use for deactivation — cannot be undone on Meta)
  static async deleteFromMeta(templateName) {
    try {
      const response = await axios.delete(
        `${WABA_API_URL}/${process.env.WABA_BUSINESS_ACCOUNT_ID}/message_templates`,
        {
          params: { name: templateName },
          headers: { Authorization: `Bearer ${process.env.WABA_API_TOKEN}` }
        }
      );
      return { success: true, data: response.data };
    } catch (error) {
      console.error('[WABA] Delete template error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.error?.message || error.message };
    }
  }

  static async sendTextMessage(recipientPhone, text) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'text',
        text: { body: text, preview_url: false }
      };
      const response = await axios.post(
        `${WABA_API_URL}/${process.env.WABA_PHONE_ID}/messages`,
        payload,
        { headers: { Authorization: `Bearer ${process.env.WABA_API_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      return { success: true, messageId: response.data.messages[0].id };
    } catch (error) {
      console.error('[WABA] sendTextMessage error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.error?.message || error.message };
    }
  }

  static async getTemplateDetails(templateName) {
    try {
      const response = await axios.get(
        `${WABA_API_URL}/${process.env.WABA_BUSINESS_ACCOUNT_ID}/message_templates?name=${templateName}`,
        { headers: { Authorization: `Bearer ${process.env.WABA_API_TOKEN}` } }
      );
      return response.data.data[0];
    } catch (error) {
      console.error('[WABA] Error fetching template:', error.message);
      return null;
    }
  }
}

module.exports = WABAService;
