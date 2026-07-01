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
    const localImageUrl  = typeof template === 'object' ? (template.header_image_url || null) : null;
    const localBodyText  = typeof template === 'object' && template?.body_text ? template.body_text : '';

    // Possible fill values in order: {{1}} owner_name, {{2}} hotel_name, {{3}} city, {{4}} demo_link
    const fillValues = [
      hotelLead.owner_name || hotelLead.hotel_name || '',
      hotelLead.hotel_name || '',
      hotelLead.city       || '',
      process.env.DEMO_LINK || 'https://resort.dreamstechnology.in',
    ];

    // Fetch actual template structure from Meta so we send exactly the right components
    const metaTemplate = await this.getTemplateDetails(templateName);
    const components = [];

    if (metaTemplate && metaTemplate.components) {
      for (const comp of metaTemplate.components) {
        if (comp.type === 'HEADER') {
          if (comp.format === 'IMAGE') {
            // Use our stored image URL, or fall back to the example handle Meta has
            const imgUrl = localImageUrl || comp.example?.header_handle?.[0];
            if (imgUrl) {
              components.push({
                type: 'header',
                parameters: [{ type: 'image', image: { link: imgUrl } }]
              });
            }
          }
          // TEXT / DOCUMENT / VIDEO headers without variables need no parameters component
        } else if (comp.type === 'BODY') {
          const varMatches = (comp.text || '').match(/\{\{\d+\}\}/g) || [];
          const varCount = [...new Set(varMatches)].length;
          if (varCount > 0) {
            components.push({
              type: 'body',
              parameters: fillValues.slice(0, varCount).map(v => ({ type: 'text', text: String(v) }))
            });
          }
        } else if (comp.type === 'BUTTONS') {
          // Handle URL buttons with dynamic {{1}} variable
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
      console.log(`[WABA] Built components from Meta template for "${templateName}":`, JSON.stringify(components));
    } else {
      // Fallback: use local DB body text if Meta fetch fails
      console.warn(`[WABA] Could not fetch Meta template "${templateName}", using local body text as fallback`);
      const varMatches = localBodyText.match(/\{\{\d+\}\}/g) || [];
      const varCount = [...new Set(varMatches)].length;
      if (localImageUrl) {
        components.push({ type: 'header', parameters: [{ type: 'image', image: { link: localImageUrl } }] });
      }
      if (varCount > 0) {
        components.push({ type: 'body', parameters: fillValues.slice(0, varCount).map(v => ({ type: 'text', text: String(v) })) });
      }
    }

    return this.sendTemplateMessageWithComponents(hotelLead.whatsapp_number, templateName, components);
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
  static async sendTemplateMessageWithComponents(recipientPhone, templateName, components) {
    try {
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
