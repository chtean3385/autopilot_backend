const WABAService = require('./wabaService');
const settingsService = require('./settingsService');

// WhatsApp alert to the business owner's OWN number.
//
// Why this exists: a plain text message on the WhatsApp Cloud API only delivers inside a
// 24-hour customer-service window — i.e. within 24h of that number messaging the business
// number. The owner never messages the business number, so for ~6 months every owner alert
// (`sendTextMessage` in agentService / adminNotifyService) silently failed with Meta error
// 131047 and only logged a console line nobody watched.
//
// The fix: send an approved template (category UTILITY), which delivers any time. Free text
// is kept only as the in-window path (e.g. the owner replied to an earlier alert).
//
// Template `owner_alert` (submit via scripts/submit_owner_alert_template.js) is one variable
// wrapped in fixed copy — {{1}} carries the whole alert: "<title>: <detail>".
// Override the name in settings key OWNER_ALERT_TEMPLATE if you approve it under another name.
async function alertOwner(title, body) {
  let phone = await settingsService.getSetting('OWNER_WHATSAPP');
  if (!phone) {
    console.log('[OwnerAlert] OWNER_WHATSAPP not set (Settings → App) — skipping');
    return { skipped: true };
  }
  phone = phone.replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;

  const tpl = (await settingsService.getSetting('OWNER_ALERT_TEMPLATE')) || 'owner_alert';
  const t = String(title || 'Dreams CRM alert').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Dreams CRM alert';
  const b = String(body || '').replace(/\s*\n\s*/g, ' — ').replace(/\s+/g, ' ').trim().slice(0, 600);
  const line = b ? `${t}: ${b}` : t;

  const viaTemplate = await WABAService.sendTemplateMessage(phone, tpl, [line]);
  if (viaTemplate.success) return { ok: true, via: 'template' };

  const viaText = await WABAService.sendTextMessage(phone, `🔔 ${line}`);
  if (!viaText.success) {
    console.error(`[OwnerAlert] template "${tpl}" failed (${viaTemplate.error}) AND text failed (${viaText.error}). ` +
      `Approve the "${tpl}" template in Meta — see backend/scripts/submit_owner_alert_template.js`);
  }
  return { ok: !!viaText.success, via: viaText.success ? 'text' : 'none', error: viaText.success ? undefined : viaText.error };
}

module.exports = { alertOwner };
