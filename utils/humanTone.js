// One shared bar for "does this read like a real person wrote it to ME?" — used to write and to score
// directory-lead WhatsApp templates (services/templatePoolService.js) and directory cold emails
// (services/cadenceService.js → sequenceEmailWorker.composeAndSendColdEmail). Owner's brief: very
// personal, human, specific to their trade, must not look AI-generated; only 4.5+ out of 5 goes out.

// Email writing rules (only cadenceService.js uses these, for directory cold emails). Rewritten 2026-11-23:
// the owner wants simple Indian English that says who we are, why we are writing to THEM, and one
// offer for what they lack, framed as more enquiries, orders and sales.
const WRITING_RULES = `Write like a polite, experienced person from Dreams Technology (Gandhinagar) writing personally to one Indian business owner.
- Simple Indian English: short sentences, everyday words, respectful. Not American sales style.
- Be specific to THEM: their website or listing, their real products, the one gap we found.
- One clear offer for that gap, framed as more enquiries, orders and sales for them. Never a list of services.
- No jargon: never "solution", "leverage", "streamline", "unlock", "elevate", "boost", "digital transformation", "CRM", "analytics", "lead capture", "seamless".
- No AI tells: no "I hope this message finds you well", "I wanted to reach out", "I came across", no em dashes, no exclamation marks, no emojis, no bullet lists, no flattery.
- Never invent facts, clients, numbers or results. Never criticise their business.`;

const SCORING_RUBRIC = `Score 0.0-5.0 (one decimal). Be strict and honest.
5.0 = reads exactly like a real person who knows this trade typed it personally; the owner would reply as if to a human.
4.5 = very good, natural and specific; maybe one tiny thing to polish.
4.0 = fine but slightly generic or slightly "marketing" — NOT good enough.
3.0 or below = sounds templated, salesy, or AI-written.
Deduct heavily for: generic copy that could go to any business; jargon or sales words; any AI tell (em dash, "I hope", "reach out", "I came across", flattery, exclamation, emoji, list-like rhythm); more than one question; anything pushy; anything not specific to the stated trade.`;

// Cold EMAIL rubric (2026-11-23 format): who we are → specific reason → one offer → easy ask.
const EMAIL_SCORING_RUBRIC = `Score 0.0-5.0 (one decimal). Be strict and honest. The reader is a busy Indian business owner.
5.0 = in 10 seconds they know who is writing, exactly why we wrote to THEM (a real, specific detail about their business: their website, products or a gap), one clear offer that fixes that gap and how it brings them more enquiries/orders/sales, and an easy way to reply. Simple, polite Indian English; reads like a real person.
4.5 = very good, one tiny thing to polish.
4.0 = clear but slightly generic or slightly salesy. NOT good enough.
3.0 or below = unclear why we are writing, generic (could go to any business), jargon, pushy, or AI-sounding.
Deduct for: no clear reason for writing; generic copy; a list of services; jargon (CRM, analytics, solution, streamline, leverage, lead capture); invented facts or numbers; AI tells ("I hope", "reach out", "I came across", em dash, exclamation, emoji, flattery); more than one question; pushiness. A short self-introduction ("I am writing from Dreams Technology…") is REQUIRED, not a pleasantry.`;

module.exports = { WRITING_RULES, SCORING_RUBRIC, EMAIL_SCORING_RUBRIC };
