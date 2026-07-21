const OpenAI = require('openai');
const { trackedCompletion } = require('../utils/aiUsage');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Synthesis call over an existing lead_research row — no crawling here, so gpt-4o-mini is enough
// (matches sequenceEmailWorker/replyQualityService, which stay on gpt-4o-mini for the same reason).
const PROPOSAL_MODEL = 'gpt-4o-mini';

function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function buildSystemPrompt(lead, research, portfolioItems) {
  const painPoints = parseJsonColumn(research.pain_points, []);
  const recommendedServices = parseJsonColumn(research.recommended_services, []);
  const opportunityScore = parseJsonColumn(research.opportunity_score, {});
  const emailAngles = parseJsonColumn(research.email_angles, []);
  const business = parseJsonColumn(research.business, {});

  const portfolioText = portfolioItems.length
    ? `\n\nDreams Technology's real past work — reference by name only where it genuinely fits:\n` +
      portfolioItems.map((p) => `- ${p.title}${p.description ? `: ${p.description}` : ''}`).join('\n')
    : '';

  return `You are a solutions consultant at Dreams Technology, a business management software company in India. Draft an internal sales proposal for a rep to review before a meeting with "${lead.hotel_name}" (${lead.business_category || 'business'}, ${lead.city || 'India'}).

Ground every claim in the research below — never invent facts about this specific business beyond what's given. Speculative sections (ROI, quotation) should be clearly reasonable estimates, not fabricated statistics.

Company summary: ${research.summary || 'Not stated'}
Pain points observed: ${painPoints.join('; ') || 'None recorded'}
Products/markets: ${(business.products || []).join('; ') || 'Not stated'} / ${(business.markets || []).join('; ') || 'Not stated'}
Recommended Dreams Technology services: ${recommendedServices.join('; ') || 'None recorded'}
Opportunity score: overall ${opportunityScore.overall ?? 'n/a'}/100, expected budget ${opportunityScore.expected_budget || 'unknown'}, decision maker ${opportunityScore.decision_maker || 'unknown'}, buying intent ${opportunityScore.buying_intent ?? 'n/a'}%
Talking points: ${emailAngles.join('; ') || 'None recorded'}${portfolioText}

Produce a proposal draft with exactly these sections:
- proposal: a short title and a 3-4 sentence pitch summary tailored to this business's specific pain points
- timeline: 3-5 implementation phases in order, each with a name, a duration estimate (e.g. "1-2 weeks"), and what happens in it
- quotation: 2-5 line items (one per recommended service), each a short service name and an INR price range (e.g. "₹1.5L-3L"); a total_range that is roughly consistent with both the line items and the opportunity score's expected budget; and a one-sentence note that this is a planning estimate, not a final quote
- architecture: a 1-2 sentence summary of the proposed solution, plus 3-5 components (name + one-line description) describing how the pieces fit together
- current_vs_future: 3-5 rows contrasting this business's CURRENT state (grounded in the pain points/research above) against the FUTURE state after adopting the recommended services
- roi: a 2-3 sentence summary of expected business value, plus 3-4 concrete highlights (time saved, leads captured, errors reduced, etc.) — plausible given the business type, not invented statistics

Respond with ONLY a single JSON object, no markdown fences, no commentary outside the JSON, in exactly this shape:
{
  "proposal": { "title": "", "summary": "" },
  "timeline": [{ "phase": "", "duration": "", "description": "" }],
  "quotation": { "items": [{ "service": "", "price_range": "" }], "total_range": "", "note": "" },
  "architecture": { "summary": "", "components": [{ "name": "", "description": "" }] },
  "current_vs_future": [{ "area": "", "current": "", "future": "" }],
  "roi": { "summary": "", "highlights": [""] }
}`;
}

function sanitize(parsed) {
  const proposal = parsed?.proposal && typeof parsed.proposal === 'object' ? parsed.proposal : {};
  const quotationRaw = parsed?.quotation && typeof parsed.quotation === 'object' ? parsed.quotation : {};
  const architectureRaw = parsed?.architecture && typeof parsed.architecture === 'object' ? parsed.architecture : {};
  const roiRaw = parsed?.roi && typeof parsed.roi === 'object' ? parsed.roi : {};

  return {
    proposal: {
      title: (proposal.title || '').toString().trim() || 'Proposal',
      summary: (proposal.summary || '').toString().trim() || 'Not enough signal to draft a summary.',
    },
    timeline: Array.isArray(parsed?.timeline)
      ? parsed.timeline
          .filter((t) => t && typeof t === 'object')
          .map((t) => ({
            phase: (t.phase || 'Phase').toString(),
            duration: (t.duration || 'TBD').toString(),
            description: (t.description || '').toString(),
          }))
      : [],
    quotation: {
      items: Array.isArray(quotationRaw.items)
        ? quotationRaw.items
            .filter((i) => i && typeof i === 'object')
            .map((i) => ({
              service: (i.service || 'Service').toString(),
              price_range: (i.price_range || 'Not enough signal').toString(),
            }))
        : [],
      total_range: (quotationRaw.total_range || 'Not enough signal').toString(),
      note: (quotationRaw.note || 'Planning estimate only — final pricing after a requirements review.').toString(),
    },
    architecture: {
      summary: (architectureRaw.summary || '').toString().trim() || 'Not enough signal.',
      components: Array.isArray(architectureRaw.components)
        ? architectureRaw.components
            .filter((c) => c && typeof c === 'object')
            .map((c) => ({ name: (c.name || 'Component').toString(), description: (c.description || '').toString() }))
        : [],
    },
    current_vs_future: Array.isArray(parsed?.current_vs_future)
      ? parsed.current_vs_future
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            area: (r.area || 'Area').toString(),
            current: (r.current || '').toString(),
            future: (r.future || '').toString(),
          }))
      : [],
    roi: {
      summary: (roiRaw.summary || '').toString().trim() || 'Not enough signal.',
      highlights: Array.isArray(roiRaw.highlights) ? roiRaw.highlights.map((h) => String(h)) : [],
    },
  };
}

async function generateProposal(lead, research, portfolioItems = []) {
  const response = await trackedCompletion(client, {
    model: PROPOSAL_MODEL,
    max_tokens: 1600,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt(lead, research, portfolioItems) },
      { role: 'user', content: `Generate the proposal for ${lead.hotel_name}.` },
    ],
  }, { purpose: 'proposal_generation', leadId: lead.id ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  return sanitize(parsed);
}

module.exports = { generateProposal };
