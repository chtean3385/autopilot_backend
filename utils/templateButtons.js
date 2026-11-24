// WABA template buttons: validate + normalise to Meta's format.
// Accepts plain strings (old style, = quick reply) or {type, text, url, phone_number}.
// Meta rules: max 10 buttons, label max 25 chars, max 2 website links, max 1 call button.
// Links must be static: the send path only fills a {{1}} link with DEMO_LINK, so a variable
// link here would send the wrong URL. Website/call buttons go first and quick replies after,
// because Meta wants each kind kept together.

const MAX_LABEL = 25;

function normalizeButtons(input) {
  if (input == null || input === '') return { buttons: [] };
  let list = input;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return { error: 'Buttons are not valid JSON.' }; }
  }
  if (!Array.isArray(list)) return { error: 'Buttons must be a list.' };

  const out = [];
  for (const raw of list) {
    const b = typeof raw === 'string' ? { type: 'QUICK_REPLY', text: raw } : { ...(raw || {}) };
    const type = String(b.type || 'QUICK_REPLY').toUpperCase();
    const text = String(b.text || '').trim();
    if (!text) continue; // empty row in the form: ignore
    if (text.length > MAX_LABEL) return { error: `Button "${text}" is ${text.length} characters; Meta allows ${MAX_LABEL}.` };

    if (type === 'QUICK_REPLY') {
      out.push({ type, text });
    } else if (type === 'URL') {
      const url = String(b.url || '').trim();
      if (!/^https?:\/\/\S+\.\S+/i.test(url)) return { error: `Button "${text}" needs a full link starting with https://` };
      if (url.includes('{{')) return { error: `Button "${text}": use a fixed link, without {{1}}.` };
      out.push({ type, text, url });
    } else if (type === 'PHONE_NUMBER') {
      const phone = String(b.phone_number || '').replace(/[\s()-]/g, '');
      if (!/^\+\d{8,15}$/.test(phone)) return { error: `Button "${text}" needs a phone number with country code, e.g. +919876543210` };
      out.push({ type, text, phone_number: phone });
    } else {
      return { error: `Unknown button type "${b.type}".` };
    }
  }

  if (out.length > 10) return { error: 'Meta allows at most 10 buttons.' };
  if (out.filter((b) => b.type === 'URL').length > 2) return { error: 'Meta allows at most 2 website buttons.' };
  if (out.filter((b) => b.type === 'PHONE_NUMBER').length > 1) return { error: 'Meta allows only 1 call button.' };
  const labels = out.map((b) => b.text.toLowerCase());
  if (new Set(labels).size !== labels.length) return { error: 'Two buttons have the same text.' };

  // Website/call first, quick replies after (Meta wants each kind grouped together).
  const sorted = [...out.filter((b) => b.type !== 'QUICK_REPLY'), ...out.filter((b) => b.type === 'QUICK_REPLY')];
  return { buttons: sorted };
}

module.exports = { normalizeButtons };
