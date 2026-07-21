const cheerio = require('cheerio');
const OpenAI = require('openai');
const pool = require('../config/db');
const {
  normalizeUrl,
  fetchPage,
  fetchPageWithMeta,
  fetchRobotsTxt,
  extractMailtoTel,
  discoverRankedLinks,
  discoverSitemapUrls,
} = require('../utils/siteCrawler');
const { detectTechnology, mergeTechnology } = require('../utils/techDetect');
const { trackedCompletion } = require('../utils/aiUsage');
const { getSpeedScore } = require('./pagespeedService');
const { logAgentAction } = require('./replyDeliveryService');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Highest-value call in the pipeline — this is the ONE GPT call per lead that produces reusable
// business intelligence (email drafting/reply QA/intent classification stay on gpt-4o-mini,
// unchanged, elsewhere). 'gpt-5.5' verified as a live model id on this account 2026-07-21
// (client.models.list — snapshot gpt-5.5-2026-04-23). If it's ever retired, the fallback below
// is tried once before giving up.
const RESEARCH_MODEL = 'gpt-5.5';
const RESEARCH_MODEL_FALLBACK = 'gpt-5.1';

// Bump when the GPT JSON contract / sanitized shape changes. Rows with schema_version 1 (or the
// column NULL/defaulted) predate confidence_breakdown and the richer business fields.
const RESEARCH_SCHEMA_VERSION = 2;

const MAX_PAGE_TEXT = 2000; // lower than the old single-purpose crawler's 3000 — we now fetch ~12 pages, not ~5
const FETCH_CONCURRENCY = 3;

// Page-type taxonomy, in priority order. Also doubles as the nav-link fallback's flattened
// priority list (see buildFallbackPriorityList) when a lead's site has no sitemap.xml.
const CATEGORY_PATTERNS = {
  contact: [/contact[-_]?us/i, /\bcontact\b/i, /get[-_]?in[-_]?touch/i, /reach[-_]?us/i, /\bconnect\b/i],
  about: [/about[-_]?us/i, /\babout\b/i, /\bteam\b/i, /leadership/i, /\bcompany\b/i, /who[-_-]?we[-_]?are/i],
  products: [/\bproducts?\b/i, /\bportfolio\b/i, /\bcatalog(ue)?\b/i],
  services: [/\bservices?\b/i, /\bsolutions?\b/i, /\bofferings?\b/i],
  blogs: [/\bblogs?\b/i, /\barticles?\b/i, /\bnews\b/i, /\binsights?\b/i],
  careers: [/\bcareers?\b/i, /\bjobs?\b/i, /\bhiring\b/i, /work[-_]?with[-_]?us/i],
  privacy: [/privacy[-_]?policy/i, /\bprivacy\b/i, /\bterms\b/i, /\bimprint\b/i, /\blegal\b/i],
};

// How many extra pages (beyond the homepage) to fetch per category. Blogs/careers/privacy are
// capped at 1 deliberately: a site can have hundreds of blog posts, but one is enough to detect
// "do they blog at all" (a content-marketing maturity signal) — more adds ~zero incremental
// company-level signal for the GPT call's purposes.
const CATEGORY_CAPS = { contact: 2, about: 2, products: 2, services: 2, blogs: 1, careers: 1, privacy: 1 };
const MAX_TOTAL_EXTRA_PAGES = 11; // + homepage = 12 pages/lead max, regardless of category-sum drift

const NON_PAGE_EXTENSION = /\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mp3|css|js|xml|json)$/i;

function categorize(url) {
  if (NON_PAGE_EXTENSION.test(url)) return null;
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some((rx) => rx.test(url))) return category;
  }
  return null;
}

// Buckets a flat list of candidate URLs into { category: [urls...] }, respecting CATEGORY_CAPS
// and MAX_TOTAL_EXTRA_PAGES, preserving input order within each category.
function bucketByCategory(urls) {
  const buckets = {};
  let total = 0;
  for (const url of urls) {
    if (total >= MAX_TOTAL_EXTRA_PAGES) break;
    const category = categorize(url);
    if (!category) continue;
    const cap = CATEGORY_CAPS[category] || 0;
    buckets[category] = buckets[category] || [];
    if (buckets[category].length >= cap) continue;
    if (buckets[category].includes(url)) continue;
    buckets[category].push(url);
    total += 1;
  }
  return buckets;
}

// discoverRankedLinks just needs one flat, priority-ordered pattern list — the resulting URLs
// get re-categorized by bucketByCategory/categorize() same as sitemap URLs, so no rank->category
// mapping needs to be carried through here.
function buildFallbackPriorityList() {
  return Object.values(CATEGORY_PATTERNS).flat();
}

// Best-effort robots.txt courtesy for the extra-page crawl (the homepage itself is always
// fetched — the lead gave us their site). Prefix-match on the path, with a rule's wildcard
// tail and $-anchor stripped — full robots pattern semantics are out of scope.
function isDisallowedByRobots(url, disallowPaths) {
  if (!disallowPaths || disallowPaths.length === 0) return false;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return disallowPaths.some((rule) => {
    const prefix = rule.split('*')[0].replace(/\$$/, '');
    return prefix && pathname.startsWith(prefix);
  });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Same targeted-section text extraction as the pre-rewrite crawler: header/nav/hero-ish top
// section/footer/contact-about blocks, falling back to general body text if those came up thin.
function extractPageText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const clean = (text) => text.replace(/\s+/g, ' ').trim();

  const parts = [];
  const headerText = clean($('header').text());
  if (headerText) parts.push(`Header: ${headerText}`);

  const navText = clean($('nav').text());
  if (navText) parts.push(`Nav: ${navText}`);

  const heroText = clean(
    $('[class*="hero"], [id*="hero"], [class*="banner"], [id*="banner"], [class*="jumbotron"], [class*="masthead"], [class*="intro"]')
      .first()
      .text()
  );
  if (heroText) parts.push(`Hero: ${heroText}`);

  const contactAboutText = clean($('[class*="contact"], [id*="contact"], [class*="about"], [id*="about"]').text());
  if (contactAboutText) parts.push(`Contact/About block: ${contactAboutText}`);

  const footerText = clean($('footer').text());
  if (footerText) parts.push(`Footer: ${footerText}`);

  let combined = parts.join(' | ');
  if (combined.length < 200) {
    const bodyText = clean($('body').text());
    combined = combined ? `${combined} | Body: ${bodyText}` : `Body: ${bodyText}`;
  }

  return combined.slice(0, MAX_PAGE_TEXT);
}

// Structural signals grounded in the literal markup — stand-in for a visual review since this
// is a static-HTML fetch with no rendering. Payment detection lives in techDetect.js's
// PAYMENT_SIGNATURES now (script/domain fingerprints, not just body keywords).
function extractSignals(html, pageUrl) {
  const $ = cheerio.load(html);
  const lowerHtml = html.toLowerCase();

  const hasViewportMeta = $('meta[name="viewport"]').length > 0;
  const hasForm = $('form').length > 0;

  const hasWhatsApp =
    $('a[href*="wa.me"], a[href*="api.whatsapp.com"]').length > 0 ||
    /wa\.me\//i.test(html) ||
    /api\.whatsapp\.com/i.test(html);

  const bookingWidget =
    ['book now', 'book a table', 'calendly', 'opentable', 'booking.com', 'reservation'].some((kw) => lowerHtml.includes(kw)) ||
    $('script[src*="calendly"], script[src*="opentable"], script[src*="booking"]').length > 0;

  const socialDomains = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com'];
  const socialLinks = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').toLowerCase();
    const match = socialDomains.find((d) => href.includes(d));
    if (match && !socialLinks.includes(match)) socialLinks.push(match);
  });

  const hasTestimonials =
    ['testimonial', 'review'].some((kw) => lowerHtml.includes(kw)) ||
    $('[class*="star-rating"], [class*="rating"], [itemprop="ratingValue"]').length > 0 ||
    /aggregaterating/i.test(html);

  const { mailtoEmails: mailtoLinks, telNumbers: telLinks } = extractMailtoTel(html);

  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();

  return {
    url: pageUrl,
    hasViewportMeta,
    hasForm,
    hasWhatsApp,
    bookingWidget,
    socialLinks,
    hasTestimonials,
    mailtoLinks,
    telLinks,
    title,
    metaDescription,
  };
}

// Full-site crawl: robots.txt-declared sitemaps + sitemap.xml first (categorized + capped per
// CATEGORY_CAPS), falling back to homepage nav-link discovery when no sitemap is found/parseable.
// In the no-sitemap case a second-level pass also mines the fetched inner pages' own links —
// small sites often link products/services from the about page but not the homepage nav. All
// passes share one fetchedUrls dedup set and the MAX_TOTAL_EXTRA_PAGES budget, so total fetch
// count is bounded exactly as before.
async function crawlSite(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const [homeResult, robots] = await Promise.all([fetchPageWithMeta(base), fetchRobotsTxt(base)]);
  if (!homeResult) return null;
  const { html: homeHtml, headers: homeHeaders } = homeResult;

  let candidateUrls = [];
  const sitemapUrls = await discoverSitemapUrls(base, robots.sitemaps);
  if (sitemapUrls) {
    candidateUrls = sitemapUrls;
  } else {
    const ranked = discoverRankedLinks(homeHtml, base + '/', buildFallbackPriorityList(), { sameDomainOnly: true });
    candidateUrls = ranked.map((r) => r.url);
  }
  candidateUrls = candidateUrls.filter((u) => !isDisallowedByRobots(u, robots.disallow));

  const buckets = bucketByCategory(candidateUrls);
  const extraUrls = Object.values(buckets).flat();

  const fetchedUrls = new Set([base]);
  const dedupe = (urls) =>
    urls.filter((u) => {
      const norm = u.replace(/\/$/, '');
      if (fetchedUrls.has(norm)) return false;
      fetchedUrls.add(norm);
      return true;
    });

  const fetchBatch = (urls) =>
    mapWithConcurrency(urls, FETCH_CONCURRENCY, async (url) => {
      const html = await fetchPage(url);
      return html ? { url, html } : null;
    });

  const extraPages = await fetchBatch(dedupe(extraUrls));

  if (!sitemapUrls) {
    const fetchedOk = extraPages.filter(Boolean);
    const budgetLeft = MAX_TOTAL_EXTRA_PAGES - fetchedOk.length;
    if (budgetLeft > 0 && fetchedOk.length > 0) {
      const secondLevel = [];
      for (const { url, html } of fetchedOk) {
        for (const r of discoverRankedLinks(html, url, buildFallbackPriorityList(), { sameDomainOnly: true })) {
          secondLevel.push(r.url);
        }
      }
      // Re-bucket the union so level-1 picks keep occupying their category slots and level-2
      // URLs only fill genuinely spare capacity.
      const combinedBuckets = bucketByCategory([
        ...candidateUrls,
        ...secondLevel.filter((u) => !isDisallowedByRobots(u, robots.disallow)),
      ]);
      const newUrls = dedupe(Object.values(combinedBuckets).flat()).slice(0, budgetLeft);
      if (newUrls.length > 0) extraPages.push(...(await fetchBatch(newUrls)));
    }
  }

  const pages = [
    { url: base, category: 'home', text: extractPageText(homeHtml), signals: extractSignals(homeHtml, base), tech: detectTechnology(homeHtml, homeHeaders) },
    ...extraPages
      .filter(Boolean)
      .map(({ url, html }) => ({
        url,
        category: categorize(url) || 'other',
        text: extractPageText(html),
        signals: extractSignals(html, url),
        tech: detectTechnology(html),
      })),
  ];

  return pages;
}

function buildScrapedContext(pages) {
  return pages
    .map((p, i) => {
      const s = p.signals;
      const socialLinks = s.socialLinks.length ? s.socialLinks.join(', ') : 'none found';
      const paymentGateways = p.tech.paymentGateways.length ? p.tech.paymentGateways.join(', ') : 'none found';
      const mailtoLinks = s.mailtoLinks.length ? s.mailtoLinks.join(', ') : 'none found';
      const telLinks = s.telLinks.length ? s.telLinks.join(', ') : 'none found';

      return `--- Page ${i + 1} (${p.category}): ${p.url} ---
Title: ${s.title || 'none'}
Meta description: ${s.metaDescription || 'none'}
Structural signals: viewport meta tag=${s.hasViewportMeta}, contact form present=${s.hasForm}, WhatsApp link present=${s.hasWhatsApp}, booking/reservation widget keywords found=${s.bookingWidget}, testimonial/review signals found=${s.hasTestimonials}
Social links found: ${socialLinks}
Payment gateways found: ${paymentGateways}
Mailto links found: ${mailtoLinks}
Tel links found: ${telLinks}
Extracted text: ${p.text}`;
    })
    .join('\n\n');
}

function buildTechContextText(mergedTech, anyWhatsApp, anyForm, speed) {
  return `Detected technology signals (code-computed from the actual page markup and response headers — use for context in your Technology Maturity/Digital Presence analysis, do not contradict them):
CMS/platform: ${mergedTech.cms || 'not detected'}
E-commerce platform: ${mergedTech.ecommerce || 'not detected'}
Hosting/CDN: ${mergedTech.hosting || 'not detected'}
Chat widgets found: ${mergedTech.chatWidgets.length ? mergedTech.chatWidgets.join(', ') : 'none detected'}
Form tools found: ${mergedTech.formTools.length ? mergedTech.formTools.join(', ') : 'none detected (may still have a plain HTML contact form)'}
CRM signals found: ${mergedTech.crmSignals.length ? mergedTech.crmSignals.join(', ') : 'none detected'}
Analytics/tracking tools found: ${mergedTech.analytics.length ? mergedTech.analytics.join(', ') : 'none detected (a marketing-maturity signal in itself)'}
Payment gateways found: ${mergedTech.paymentGateways.length ? mergedTech.paymentGateways.join(', ') : 'none detected'}
SEO signals found: ${mergedTech.seoSignals.length ? mergedTech.seoSignals.join(', ') : 'none detected'}
Google PageSpeed score (mobile, 0-100): ${typeof speed === 'number' ? speed : 'not measured'}
WhatsApp link present anywhere on site: ${anyWhatsApp}
Contact form present anywhere on site: ${anyForm}`;
}

// STEP 2-7 system prompt — consultant persona, operationalizing the sales-research workflow.
// Grounding language ("never invent," "Not stated") is repeated deliberately so the model doesn't
// drift into inventing facts the static crawl couldn't have seen.
function buildSystemPrompt() {
  return `You are a senior management consultant retained by Dreams Technology, a business management software company in India, to profile a prospective client from their own website ahead of a sales outreach.

You have been given scraped static-HTML text and structural signals from a full crawl of the lead's website: a homepage plus pages classified by type (contact, about/team, products, services, blogs, careers, privacy/terms). You do NOT have a screenshot or a rendered view of the site, and no JavaScript executed during the crawl — work only from the text and signals provided. Never invent anything you cannot point to in the supplied content; use "Not stated" for genuinely unknown fields rather than guessing.

Read the complete company profile and identify:
- Business Model — what they sell, to whom; classify as exactly one of "B2B", "B2C", "Both", or "Not stated"
- Company Size — approximate employee count and headquarters, if stated
- Locations — every city/branch/outlet location mentioned anywhere in the crawl (multi-location is an operational-complexity signal)
- Target Customer — a short phrase describing who they sell to (e.g. "budget travelers", "SME manufacturers"), or "Not stated"
- Products — concrete product/service names offered
- Export Activities — whether they sell internationally and to which markets, if stated
- Technology Maturity — a short one-line read of how modern/dated their digital presence is, informed by (and consistent with) the detected technology signals given to you below
- Sales Process — how leads currently seem to reach them (forms, phone, WhatsApp, none visible)
- Lead Generation — how they seem to attract customers today (ads, SEO content, referral-only, none visible)
- Digital Presence — overall quality/completeness of their online presence
- Operational Complexity — signs of multi-location, multi-product, or manual-process operations
- Potential Software Requirements — what they'd plausibly need from Dreams Technology
- Pain Points — operational, sales, marketing, or customer-experience problems evidenced by the content (fold genuine business risks in here too, e.g. single point of contact, no online lead capture, no visible CRM)
- Recommended Solutions — ONLY from this list, and only where they genuinely fit the evidence: CRM, ERP, Hotel Management, Restaurant POS, Booking System, Inventory, Billing, Payroll, Attendance, WhatsApp Automation, QR Ordering, Online Booking, Lead Management, Marketing Automation, Reports, Analytics, Custom Software, Website Redesign, Mobile App
- Estimated Project Size — a rough budget range in Indian Rupees (e.g. "₹3L-8L"), or "Not enough signal" if you can't ground an estimate

Also produce:
- A 2-3 sentence business summary
- decision_makers: any named real person with a title (owner/founder/director/CEO/manager) mentioned anywhere in the crawl — never a role label alone like "Sales Team" or "Admin"
- opportunity_score: your judgment of fit and buying-readiness — overall (0-100), categories (erp/crm/website/seo/automation, each 1-5, how much each area needs investment), expected_budget (same idea as Estimated Project Size), decision_maker (a role like "Owner" or "Not stated"), buying_intent (0-100 — this is speculative business judgment from signals like active hiring, multiple locations, or a dated site, not a fact)
- email_angles: 3-5 short talking points a salesperson could use to open a genuinely specific cold email — real details from the crawl, never generic pitches
- confidence_breakdown: how much real signal the crawl gave you in each area, each 0-100 — company_info (name/size/locations facts), business_model (what+who they sell), technology (their stack/digital presence), pain_points (evidenced problems), financials (budget/project-size signals — usually the lowest), and overall (your blended judgment; low if very little content was scraped)

Self-review before responding: every claim must be traceable to the supplied content or signals. Respond with ONLY a single JSON object, no markdown fences, no commentary outside the JSON, in exactly this shape:
{
  "company": { "name": "", "industry": "", "employees": "", "headquarters": "", "exports": true, "founded": null },
  "summary": "",
  "business": { "products": [""], "markets": [""], "business_model": "", "locations": [""], "target_customer": "" },
  "technology_maturity_note": "",
  "pain_points": [""],
  "recommended_services": [""],
  "opportunity_score": { "overall": 0, "categories": { "erp": 0, "crm": 0, "website": 0, "seo": 0, "automation": 0 }, "expected_budget": "", "decision_maker": "", "buying_intent": 0 },
  "email_angles": [""],
  "decision_makers": [{ "name": "", "title": "" }],
  "confidence_breakdown": { "company_info": 0, "business_model": 0, "technology": 0, "pain_points": 0, "financials": 0, "overall": 0 }
}
Use short phrases (not full paragraphs) for company fields. Use "Not stated" for genuinely unknown string fields. Clamp opportunity_score.overall/buying_intent and every confidence_breakdown value to 0-100, and opportunity_score.categories.* to 1-5.`;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function sanitizeResult(parsed, tech) {
  const company = parsed?.company && typeof parsed.company === 'object' ? parsed.company : {};
  const business = parsed?.business && typeof parsed.business === 'object' ? parsed.business : {};
  const opportunityRaw = parsed?.opportunity_score && typeof parsed.opportunity_score === 'object' ? parsed.opportunity_score : {};
  const categoriesRaw = opportunityRaw.categories && typeof opportunityRaw.categories === 'object' ? opportunityRaw.categories : {};
  const breakdownRaw = parsed?.confidence_breakdown && typeof parsed.confidence_breakdown === 'object' ? parsed.confidence_breakdown : {};

  const decisionMakers = Array.isArray(parsed?.decision_makers)
    ? parsed.decision_makers
        .filter((d) => d && typeof d === 'object' && d.name)
        .map((d) => ({ name: String(d.name), title: d.title ? String(d.title) : 'Not stated' }))
    : [];

  // Legacy top-level "confidence" accepted as the overall fallback so a fallback-model response
  // trained on the old shape still sanitizes cleanly.
  const overallConfidence = clampInt(breakdownRaw.overall ?? parsed?.confidence, 0, 100, 40);

  return {
    company: {
      name: company.name || 'Not stated',
      industry: company.industry || 'Not stated',
      employees: company.employees || 'Not stated',
      headquarters: company.headquarters || 'Not stated',
      exports: Boolean(company.exports),
      founded: Number.isFinite(Number.parseInt(company.founded, 10)) ? Number.parseInt(company.founded, 10) : null,
    },
    summary: (parsed?.summary || '').toString().trim() || 'Not stated',
    business: {
      products: Array.isArray(business.products) ? business.products : [],
      markets: Array.isArray(business.markets) ? business.markets : [],
      business_model: (business.business_model || '').toString().trim() || 'Not stated',
      locations: Array.isArray(business.locations) ? business.locations.map(String) : [],
      target_customer: (business.target_customer || '').toString().trim() || 'Not stated',
    },
    technology: {
      cms: tech.cms,
      whatsapp: tech.anyWhatsApp,
      chatbot: tech.mergedTech.chatWidgets.length > 0,
      crm: tech.mergedTech.crmSignals.length > 0,
      forms: tech.anyForm,
      speed: tech.speed,
      maturity_note: (parsed?.technology_maturity_note || '').toString().trim() || 'Not stated',
      analytics: tech.mergedTech.analytics,
      payment_gateways: tech.mergedTech.paymentGateways,
      seo_signals: tech.mergedTech.seoSignals,
      hosting: tech.mergedTech.hosting,
    },
    pain_points: Array.isArray(parsed?.pain_points) ? parsed.pain_points : [],
    recommended_services: Array.isArray(parsed?.recommended_services) ? parsed.recommended_services : [],
    opportunity_score: {
      overall: clampInt(opportunityRaw.overall, 0, 100, 40),
      categories: {
        erp: clampInt(categoriesRaw.erp, 1, 5, 1),
        crm: clampInt(categoriesRaw.crm, 1, 5, 1),
        website: clampInt(categoriesRaw.website, 1, 5, 1),
        seo: clampInt(categoriesRaw.seo, 1, 5, 1),
        automation: clampInt(categoriesRaw.automation, 1, 5, 1),
      },
      expected_budget: opportunityRaw.expected_budget || 'Not enough signal',
      decision_maker: opportunityRaw.decision_maker || 'Not stated',
      buying_intent: clampInt(opportunityRaw.buying_intent, 0, 100, 30),
    },
    email_angles: Array.isArray(parsed?.email_angles) ? parsed.email_angles : [],
    decision_makers: decisionMakers,
    confidence: overallConfidence,
    confidence_breakdown: {
      company_info: clampInt(breakdownRaw.company_info, 0, 100, overallConfidence),
      business_model: clampInt(breakdownRaw.business_model, 0, 100, overallConfidence),
      technology: clampInt(breakdownRaw.technology, 0, 100, overallConfidence),
      pain_points: clampInt(breakdownRaw.pain_points, 0, 100, overallConfidence),
      financials: clampInt(breakdownRaw.financials, 0, 100, overallConfidence),
      overall: overallConfidence,
    },
    schema_version: RESEARCH_SCHEMA_VERSION,
  };
}

// Pre-save gate: hard structural validity, plus a quality check that catches the model returning
// a mostly-empty profile despite real scraped signal (multi-page crawl). A thin single-page site
// legitimately produces a thin profile — that's not a failure.
function validateResearch(parsed, pages) {
  if (!parsed || typeof parsed !== 'object') return { valid: false, reason: 'not_an_object' };
  for (const key of ['company', 'summary', 'opportunity_score']) {
    if (!(key in parsed)) return { valid: false, reason: `missing_${key}` };
  }

  const company = parsed.company && typeof parsed.company === 'object' ? parsed.company : {};
  const business = parsed.business && typeof parsed.business === 'object' ? parsed.business : {};
  const isEmpty = (v) => !v || /^not stated$/i.test(String(v).trim());
  const stringFields = [
    company.name, company.industry, company.employees, company.headquarters,
    parsed.summary, parsed.technology_maturity_note, business.business_model, business.target_customer,
  ];
  const arrayFields = [business.products, business.markets, parsed.pain_points, parsed.recommended_services, parsed.email_angles];
  const emptyCount =
    stringFields.filter(isEmpty).length +
    arrayFields.filter((v) => !Array.isArray(v) || v.length === 0).length;
  const emptyRatio = emptyCount / (stringFields.length + arrayFields.length);
  if (emptyRatio > 0.8 && pages.length > 1) return { valid: false, reason: 'mostly_empty_despite_signal' };

  return { valid: true };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callResearchModel(messages, leadId) {
  // gpt-5.x are reasoning models: they reject 'max_tokens' (max_completion_tokens only), and
  // reasoning tokens count against the cap — so it's set well above the ~1800-token answer.
  const request = (model) =>
    trackedCompletion(client, {
      model,
      max_completion_tokens: 6000,
      response_format: { type: 'json_object' },
      messages,
    }, { purpose: 'research', leadId });
  try {
    return await request(RESEARCH_MODEL);
  } catch (error) {
    const modelUnavailable = error?.status === 404 || error?.code === 'model_not_found';
    if (!modelUnavailable) throw error;
    console.warn(`[LeadResearch] ${RESEARCH_MODEL} unavailable, retrying with ${RESEARCH_MODEL_FALLBACK}`);
    return request(RESEARCH_MODEL_FALLBACK);
  }
}

async function safeLogAgentAction(leadId, action, options) {
  try {
    await logAgentAction(leadId, action, options);
  } catch (err) {
    console.error('[LeadResearch] agent_actions log failed:', err.message);
  }
}

async function researchCompany(lead) {
  if (!lead?.website) return null;
  const leadId = lead.lead_id ?? lead.id ?? null;

  try {
    const base = normalizeUrl(lead.website);
    const [pages, speed] = await Promise.all([crawlSite(base), getSpeedScore(base)]);
    if (!pages || pages.length === 0) return null;

    const mergedTech = mergeTechnology(pages.map((p) => p.tech));
    const anyWhatsApp = pages.some((p) => p.signals.hasWhatsApp) || mergedTech.chatWidgets.includes('WhatsApp');
    const anyForm = pages.some((p) => p.signals.hasForm) || mergedTech.formTools.length > 0;

    const scrapedContext = buildScrapedContext(pages);
    const techContext = buildTechContextText(mergedTech, anyWhatsApp, anyForm, speed);
    const leadContext = `Business: ${lead.hotel_name || 'Unknown'}\nOwner (from CRM, may be outdated): ${lead.owner_name || 'Unknown'}\nCity: ${lead.city || 'Unknown'}${lead.business_category ? `\nCategory: ${lead.business_category}` : ''}\nWebsite: ${lead.website}\n\n${techContext}\n\nScraped website content (static HTML crawl, ${pages.length} page(s)):\n${scrapedContext}`;

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: leadContext },
    ];

    let rawContent = (await callResearchModel(messages, leadId)).choices[0].message.content;
    let parsed = tryParseJson(rawContent);
    let validation = parsed ? validateResearch(parsed, pages) : { valid: false, reason: 'invalid_json' };
    let repaired = false;

    if (!validation.valid) {
      repaired = true;
      const repairMessages = [
        ...messages,
        { role: 'assistant', content: rawContent || '' },
        {
          role: 'user',
          content: `Your previous response was rejected (reason: ${validation.reason}). Respond again with ONLY a single valid JSON object exactly matching the schema in the system message — no markdown fences, no commentary — and fill in every field you can genuinely ground in the supplied content.`,
        },
      ];
      rawContent = (await callResearchModel(repairMessages, leadId)).choices[0].message.content;
      parsed = tryParseJson(rawContent);
      validation = parsed ? validateResearch(parsed, pages) : { valid: false, reason: 'invalid_json' };
      if (!validation.valid) {
        await safeLogAgentAction(leadId, 'research_failed', {
          detail: { reason: validation.reason, website: lead.website, pages: pages.length },
          decision: 'give_up',
        });
        return null;
      }
    }

    const result = sanitizeResult(parsed, { cms: mergedTech.cms, mergedTech, anyWhatsApp, anyForm, speed });
    await safeLogAgentAction(leadId, repaired ? 'research_repaired' : 'research_completed', {
      detail: { website: lead.website, pages: pages.length, confidence: result.confidence },
      decision: 'saved',
    });
    return result;
  } catch (error) {
    console.error('[LeadResearch] researchCompany error:', error.message);
    await safeLogAgentAction(leadId, 'research_failed', {
      detail: { error: error.message, website: lead.website },
      decision: 'error',
    });
    return null;
  }
}

// Persists a researchCompany() result: appends an immutable row to lead_research_versions
// (per-lead version counter) AND upserts the "current research" row in lead_research. The
// unique index on (lead_id, version) backstops the rare concurrent-research race.
async function saveResearch(leadId, researched) {
  const values = [
    leadId,
    JSON.stringify(researched.company),
    researched.summary,
    JSON.stringify(researched.business),
    JSON.stringify(researched.technology),
    JSON.stringify(researched.pain_points),
    JSON.stringify(researched.recommended_services),
    JSON.stringify(researched.opportunity_score),
    JSON.stringify(researched.email_angles),
    JSON.stringify(researched.decision_makers),
    researched.confidence,
    researched.confidence_breakdown ? JSON.stringify(researched.confidence_breakdown) : null,
    researched.schema_version || 1,
  ];

  await pool.query(
    `INSERT INTO lead_research_versions
       (lead_id, version, company, summary, business, technology, pain_points, recommended_services,
        opportunity_score, email_angles, decision_makers, confidence, confidence_breakdown, schema_version)
     VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM lead_research_versions WHERE lead_id = $1),
             $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    values
  );

  const row = await pool.query(
    `INSERT INTO lead_research
       (lead_id, company, summary, business, technology, pain_points, recommended_services,
        opportunity_score, email_angles, decision_makers, confidence, confidence_breakdown, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (lead_id) DO UPDATE SET
       company=$2, summary=$3, business=$4, technology=$5, pain_points=$6, recommended_services=$7,
       opportunity_score=$8, email_angles=$9, decision_makers=$10, confidence=$11,
       confidence_breakdown=$12, schema_version=$13, created_at=NOW()
     RETURNING *`,
    values
  );
  return row.rows[0];
}

// Shared cache-check-then-research flow used by routes/leads.js, routes/proposals.js and
// workers/sequenceEmailWorker.js (which previously each hand-rolled this). Cache is checked
// before the website gate so an existing research row still serves leads whose website was
// later cleared. Accepts either a hotel_leads row (id) or a worker's joined row (lead_id).
async function getOrCreateResearch(lead, { force = false } = {}) {
  const leadId = lead.lead_id ?? lead.id;

  if (!force) {
    const cached = await pool.query('SELECT * FROM lead_research WHERE lead_id = $1', [leadId]);
    if (cached.rows[0]) return { research: cached.rows[0], wasCached: true };
  }

  if (!lead.website) return { research: null, wasCached: false };

  const researched = await researchCompany(lead);
  if (!researched) return { research: null, wasCached: false };

  const research = await saveResearch(leadId, researched);
  return { research, wasCached: false };
}

module.exports = { researchCompany, getOrCreateResearch, saveResearch };
