// Pre-send spam-trigger lint for GPT-composed cold emails. Deliberately high-precision:
// only classic spam-filter phrases and shouty formatting, nothing a legitimate Dreams
// Technology pitch would normally contain ("free demo" is our actual CTA and must NOT be
// flagged — hence the narrow "free money/gift/cash" patterns instead of a bare "free").
// Used by sequenceEmailWorker: one recompose with the flagged terms as feedback, then send
// anyway with an agent_actions trail — a lint, not a gate, so sequences never stall on it.

const SPAM_PATTERNS = [
  { label: '100% free', pattern: /100%\s*free/i },
  { label: 'act now', pattern: /\bact now\b/i },
  { label: 'apply now', pattern: /\bapply now\b/i },
  { label: 'buy now', pattern: /\bbuy now\b/i },
  { label: 'call now', pattern: /\bcall now\b/i },
  { label: 'order now', pattern: /\border now\b/i },
  { label: 'cash bonus', pattern: /\bcash bonus\b/i },
  { label: 'click here', pattern: /\bclick here\b/i },
  { label: 'congratulations', pattern: /\bcongratulations?\b/i },
  { label: 'double your', pattern: /\bdouble your\b/i },
  { label: 'earn money/income', pattern: /\bearn (extra )?(money|cash|income)\b/i },
  { label: 'free money/gift/cash', pattern: /\bfree (money|gift|cash)\b/i },
  { label: 'guaranteed', pattern: /\bguaranteed\b/i },
  { label: 'limited time', pattern: /\blimited[- ]time\b/i },
  { label: 'make money', pattern: /\bmake money\b/i },
  { label: 'miracle', pattern: /\bmiracle\b/i },
  { label: 'no obligation', pattern: /\bno obligation\b/i },
  { label: 'risk-free / no risk', pattern: /\bno risk\b|\brisk[- ]free\b/i },
  { label: 'once in a lifetime', pattern: /\bonce[- ]in[- ]a[- ]lifetime\b/i },
  { label: 'special promotion', pattern: /\bspecial promotion\b/i },
  { label: 'urgent', pattern: /\burgent\b/i },
  { label: 'winner / you won', pattern: /\bwinner\b|\byou (have )?won\b/i },
  { label: 'millions of dollars/rupees', pattern: /\bmillions? (of )?(dollars|rupees)\b/i },
  { label: 'exclusive deal', pattern: /\bexclusive (deal|offer)\b/i },
  { label: "don't miss", pattern: /\bdon'?t miss\b/i },
  { label: 'lowest/best price', pattern: /\b(lowest|best) price\b/i },
  { label: 'satisfaction guaranteed', pattern: /\bsatisfaction guaranteed\b/i },
];

function checkSpamContent(subject, body) {
  const subj = String(subject || '');
  const combined = `${subj}\n${String(body || '')}`;

  const flagged = SPAM_PATTERNS.filter((p) => p.pattern.test(combined)).map((p) => p.label);

  if (subj.length >= 8 && subj === subj.toUpperCase() && /[A-Z]/.test(subj)) flagged.push('all-caps subject');
  if ((subj.match(/!/g) || []).length >= 2) flagged.push('multiple exclamation marks in subject');
  if ((String(body || '').match(/!/g) || []).length >= 4) flagged.push('excessive exclamation marks in body');

  return { clean: flagged.length === 0, flagged };
}

module.exports = { checkSpamContent };
