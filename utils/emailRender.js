function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Unsubscribe footer required on every outbound email — shared so estimate/portfolio emails stay compliant too
function unsubscribeFooterHtml(unsubscribeUrl) {
  return `<hr style="margin-top:24px;border:none;border-top:1px solid #ddd">\n<p style="font-size:12px;color:#888">Dreams Technology &middot; <a href="${unsubscribeUrl}">Unsubscribe</a></p>`;
}

// Plain-text body -> {html, text} with the unsubscribe footer required on every outbound email
function renderEmailBody(body, unsubscribeUrl) {
  const text = `${body}\n\n—\nDreams Technology\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;
  const htmlBody = body
    .split(/\n\n+/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const html = `${htmlBody}\n${unsubscribeFooterHtml(unsubscribeUrl)}`;
  return { html, text };
}

module.exports = { escapeHtml, renderEmailBody, unsubscribeFooterHtml };
