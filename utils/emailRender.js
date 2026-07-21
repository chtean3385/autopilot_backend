function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain-text URL matcher for linkify. Excludes quotes/brackets/whitespace; trailing sentence
// punctuation is trimmed separately so "see https://x.com." links cleanly.
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

function trimTrailingPunctuation(url) {
  return url.replace(/[.,!?;:]+$/, '');
}

// Escape + linkify one plain-text paragraph. URLs become real <a> tags (mail clients don't
// auto-link plain URLs inside HTML parts) — routed through the click tracker when a trackUrl
// builder is provided; everything else is entity-escaped exactly as before.
function paragraphToHtml(paragraph, trackUrl) {
  let html = '';
  let last = 0;
  for (const match of paragraph.matchAll(URL_PATTERN)) {
    const url = trimTrailingPunctuation(match[0]);
    html += escapeHtml(paragraph.slice(last, match.index));
    const href = trackUrl ? trackUrl(url) : url;
    html += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
    last = match.index + url.length;
  }
  html += escapeHtml(paragraph.slice(last));
  return html.replace(/\n/g, '<br>');
}

// Unsubscribe footer required on every outbound email — shared so estimate/portfolio emails stay
// compliant too. The optional pixelUrl appends the self-hosted open-tracking pixel here because
// every outbound HTML path ends in this footer — coverage can't be forgotten by a new send path.
function unsubscribeFooterHtml(unsubscribeUrl, pixelUrl) {
  const pixel = pixelUrl ? `\n<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none">` : '';
  return `<hr style="margin-top:24px;border:none;border-top:1px solid #ddd">\n<p style="font-size:12px;color:#888">Dreams Technology &middot; <a href="${unsubscribeUrl}">Unsubscribe</a></p>${pixel}`;
}

// Plain-text body -> {html, text} with the unsubscribe footer required on every outbound email.
// `tracking` ({ pixelUrl, trackUrl }) comes from utils/emailTracking.js — optional so previews
// and owner notifications render untracked. The text part always keeps the original URLs.
function renderEmailBody(body, unsubscribeUrl, tracking = {}) {
  const text = `${body}\n\n—\nDreams Technology\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;
  const htmlBody = body
    .split(/\n\n+/)
    .map(p => `<p>${paragraphToHtml(p, tracking.trackUrl)}</p>`)
    .join('\n');
  const html = `${htmlBody}\n${unsubscribeFooterHtml(unsubscribeUrl, tracking.pixelUrl)}`;
  return { html, text };
}

module.exports = { escapeHtml, renderEmailBody, unsubscribeFooterHtml };
