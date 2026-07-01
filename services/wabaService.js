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
    const templateName  = typeof template === 'string' ? template : template.template_name;
    const localImageUrl = typeof template === 'object' ? (template.header_image_url || null) : null;
    const localBodyText = typeof template === 'object' && template?.body_text ? template.body_text : '';

    // parameter_mapping: {"1": "owner_name", "2": "hotel_name", ...} — set by user when creating template
    let paramMapping = {};
    if (typeof template === 'object' && template.parameter_mapping) {
      paramMapping = typeof template.parameter_mapping === 'string'
        ? JSON.parse(template.parameter_mapping)
        : template.parameter_mapping;
    }

    // Resolve a variable number (string "1","2",...) to the actual value for this lead
    const resolveVar = (num) => {
      const field = paramMapping[String(num)];
      if (field === 'demo_link') return process.env.DEMO_LINK || 'https://resort.dreamstechnology.in';
      if (field && hotelLead[field] !== undefined) return String(hotelLead[field] || '');
      // No mapping — positional fallback so existing templates without mapping still work
      const fallback = {
        '1': hotelLead.owner_name || hotelLead.hotel_name || '',
        '2': hotelLead.hotel_name || '',
        '3': hotelLead.city || '',
        '4': process.env.DEMO_LINK || 'https://resort.dreamstechnology.in',
      };
      return fallback[String(num)] || '';
    };

    // Fetch actual template structure from Meta — never guess what components exist
    const metaTemplate = await this.getTemplateDetails(templateName);
    const language = metaTemplate?.language || 'en_US';
    const components = [];

    if (metaTemplate && metaTemplate.components) {
      for (const comp of metaTemplate.components) {
        if (comp.type === 'HEADER') {
          if (comp.format === 'IMAGE') {
            // Prefer our stored URL (user-chosen), fall back to Meta's example handle
            const imgUrl = localImageUrl || comp.example?.header_handle?.[0];
            if (imgUrl) {
              components.push({ type: 'header', parameters: [{ type: 'image', image: { link: imgUrl } }] });
            } else {
              console.warn(`[WABA] Template "${templateName}" has IMAGE header but no image URL set. Set header_image_url in the template.`);
            }
          }
          // TEXT/VIDEO/DOCUMENT headers with no variables need no parameters entry
        } else if (comp.type === 'BODY') {
          // Extract unique variable numbers in order they appear ({{1}}, {{2}}, ...)
          const varNums = [...new Set((comp.text || '').match(/\{\{(\d+)\}\}/g) || [])]
            .map(v => v.replace(/\D/g, ''))
            .sort((a, b) => Number(a) - Number(b));
          if (varNums.length > 0) {
            components.push({
              type: 'body',
              parameters: varNums.map(num => ({ type: 'text', text: resolveVar(num) }))
            });
          }
        } else if (comp.type === 'BUTTONS') {
          // Handle URL buttons that have a dynamic {{1}} suffix variable
          (comp.buttons || []).forEach((btn, idx) => {
            if (btn.type === 'URL' && btn.url && btn.url.includes('{{')) {
              components.push({
                type: 'button',
                sub_type: 'url',
                index: String(idx),
                parameters: [{ type: 'text', text: process.env.DEMO_LINK || 'https://resort.dreamstechnology.in' }]
              });
            }
          });
        }
      }
      console.log(`[WABA] Components for "${templateName}" (lang: ${language}):`, JSON.stringify(components));
    } else {
      // Meta fetch failed — fall back to local DB body text so send still works
      console.warn(`[WABA] Could not fetch "${templateName}" from Meta — using local DB body as fallback`);
      const varNums = [...new Set((localBodyText.match(/\{\{(\d+)\}\}/g) || []))]
        .map(v => v.replace(/\D/g, ''))
        .sort((a, b) => Number(a) - Number(b));
      if (localImageUrl) {
        components.push({ type: 'header', parameters: [{ type: 'image', image: { link: localImageUrl } }] });
      }
      if (varNums.length > 0) {
        components.push({ type: 'body', parameters: varNums.map(num => ({ type: 'text', text: resolveVar(num) })) });
      }
    }

    return this.sendTemplateMessageWithComponents(hotelLead.whatsapp_number, templateName, components, language);
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

  // Send a template with a pre-built components array (used by sendPersonalizedTemplate)
  static async sendTemplateMessageWithComponents(recipientPhone, templateName, components, language = 'en_US') {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
          components
        }
      };

      console.log(`[WABA] Sending template "${templateName}" to ${recipientPhone} with ${components.length} component(s)`);

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
