const pool = require('../config/db');

// RFC 5322 threading headers (In-Reply-To/References) for outbound email, built from the
// provider_message_ids already logged in email_logs — Brevo's returned messageId and
// nodemailer's info.messageId are both the actual Message-ID header of the delivered mail,
// and inbound ids come from mailparser, so the chain is real. Without these headers the
// recipient's mail client showed every reply/follow-up as a brand-new conversation.

const MAX_REFERENCES = 10;

function normalizeMessageId(id) {
  const trimmed = String(id || '').trim();
  if (!trimmed) return null;
  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
}

// Headers for the next outbound email to this lead. Pass `inReplyTo` (the raw provider
// message id) when answering a specific inbound message; without it the last message in the
// thread is targeted (sequence follow-ups threading onto the conversation so far). A lead
// with no logged messages yet (step-0 cold email) gets null headers — a genuinely new thread.
async function getThreadHeaders(leadId, inReplyTo = null) {
  const result = await pool.query(
    `SELECT provider_message_id FROM email_logs
     WHERE lead_id = $1 AND provider_message_id IS NOT NULL
     ORDER BY COALESCE(sent_at, created_at) ASC`,
    [leadId]
  );
  const ids = [...new Set(result.rows.map(r => normalizeMessageId(r.provider_message_id)).filter(Boolean))];
  const target = normalizeMessageId(inReplyTo) || ids[ids.length - 1] || null;
  if (!target) return { inReplyTo: null, references: null };

  const chain = ids.filter(id => id !== target).slice(-(MAX_REFERENCES - 1));
  chain.push(target);
  return { inReplyTo: target, references: chain.join(' ') };
}

module.exports = { getThreadHeaders, normalizeMessageId };
