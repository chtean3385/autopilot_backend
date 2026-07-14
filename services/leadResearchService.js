const cheerio = require('cheerio');
const OpenAI = require('openai');
const { normalizeUrl, fetchPage, extractMailtoTel, discoverRankedLinks } = require('../utils/siteCrawler');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_PAGE_TEXT = 3000;
const MAX_EXTRA_PAGES = 4; // + homepage = 5 total
const EMAIL_BODY_WORD_CAP = 180;

// Priority order per spec: Contact, Contact Us, About, About Us, Team, Leadership, Privacy Policy, Terms.
// Lower index = higher priority. A link only needs to match ONE of these to be a candidate; rank is
// the index of the first (highest-priority) pattern it matches.
const LINK_PRIORITY = [
  /\bcontact\b/i,
  /contact[-_\s]?us/i,
  /\babout\b/i,
  /about[-_\s]?us/i,
  /\bteam\b/i,
  /leadership/i,
  /privacy[-_\s]?policy/i,
  /\bterms\b/i,
];

// Never crawl these page types even if they happen to also match a priority pattern.
const EXCLUDE_PATTERNS = [/\bblogs?\b/i, /\bproducts?\b/i, /\bnews\b/i, /\bcareers?\b/i, /\barticles?\b/i];

const BOOKING_KEYWORDS = ['book now', 'book a table', 'calendly', 'opentable', 'booking.com', 'reservation'];
const TESTIMONIAL_KEYWORDS = ['testimonial', 'review'];
const PAYMENT_KEYWORDS = ['razorpay', 'paypal', 'stripe', 'upi', 'credit card', 'debit card'];

// Text extraction for GPT context: header/nav/hero-ish top section/footer/contact-about blocks,
// falling back to general body text if those targeted selectors came up thin. Capped like
// enrichmentService.js's extractFromHtml.
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

// Structural signals that stand in for a visual/UX review, since this is a static-HTML fetch with
// no rendering. Everything here is grounded in something literally present in the markup.
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
    BOOKING_KEYWORDS.some((kw) => lowerHtml.includes(kw)) ||
    $('script[src*="calendly"], script[src*="opentable"], script[src*="booking"]').length > 0;

  const socialDomains = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com'];
  const socialLinks = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').toLowerCase();
    const match = socialDomains.find((d) => href.includes(d));
    if (match && !socialLinks.includes(match)) socialLinks.push(match);
  });

  const hasTestimonials =
    TESTIMONIAL_KEYWORDS.some((kw) => lowerHtml.includes(kw)) ||
    $('[class*="star-rating"], [class*="rating"], [itemprop="ratingValue"]').length > 0 ||
    /aggregaterating/i.test(html) ||
    (/google/i.test(html) && /review/i.test(html));

  const paymentMentions = PAYMENT_KEYWORDS.filter((kw) => lowerHtml.includes(kw));

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
    paymentMentions,
    mailtoLinks,
    telLinks,
    title,
    metaDescription,
  };
}

// STEP 1 — crawl. Homepage + up to 4 more pages (contact/about/team/leadership/privacy/terms, in
// that priority order), static HTML only via axios+cheerio. Returns null only if the homepage
// itself can't be fetched at all.
async function crawlSite(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const homeHtml = await fetchPage(base);
  if (!homeHtml) return null;

  const fetchedUrls = new Set([base]);
  const pages = [
    { url: base, text: extractPageText(homeHtml), signals: extractSignals(homeHtml, base) },
  ];

  const candidates = discoverRankedLinks(homeHtml, base + '/', LINK_PRIORITY, {
    excludePatterns: EXCLUDE_PATTERNS,
    sameDomainOnly: true,
  });
  for (const candidate of candidates) {
    if (pages.length - 1 >= MAX_EXTRA_PAGES) break;
    const norm = candidate.url.replace(/\/$/, '');
    if (fetchedUrls.has(norm)) continue;
    fetchedUrls.add(norm);

    const html = await fetchPage(candidate.url);
    if (html) {
      pages.push({ url: candidate.url, text: extractPageText(html), signals: extractSignals(html, candidate.url) });
    }
  }

  return pages;
}

function buildScrapedContext(pages) {
  return pages
    .map((p, i) => {
      const s = p.signals;
      const socialLinks = s.socialLinks.length ? s.socialLinks.join(', ') : 'none found';
      const paymentMentions = s.paymentMentions.length ? s.paymentMentions.join(', ') : 'none found';
      const mailtoLinks = s.mailtoLinks.length ? s.mailtoLinks.join(', ') : 'none found';
      const telLinks = s.telLinks.length ? s.telLinks.join(', ') : 'none found';

      return `--- Page ${i + 1}: ${p.url} ---
Title: ${s.title || 'none'}
Meta description: ${s.metaDescription || 'none'}
Structural signals: viewport meta tag=${s.hasViewportMeta}, contact form present=${s.hasForm}, WhatsApp link present=${s.hasWhatsApp}, booking/reservation widget keywords found=${s.bookingWidget}, testimonial/review signals found=${s.hasTestimonials}
Social links found: ${socialLinks}
Payment method mentions found: ${paymentMentions}
Mailto links found: ${mailtoLinks}
Tel links found: ${telLinks}
Extracted text: ${p.text}`;
    })
    .join('\n\n');
}

// STEP 2-7 system prompt — operationalizes the business owner's literal research + audit + email
// workflow. Grounding language is repeated deliberately (identify/audit/self-review) so the model
// doesn't quietly drift into inventing facts the static crawl couldn't have seen.
function buildSystemPrompt() {
  return `You are a research analyst and sales copywriter for Dreams Technology, a business management software company in India. You have been given scraped static-HTML text and structural signals from a lead's website (a homepage plus up to four secondary pages such as contact/about/team/leadership/privacy/terms). You do NOT have a screenshot or a rendered view of the site, and no JavaScript executed during the crawl — work only from the text and signals provided. Never invent anything you cannot point to in the supplied content.

Follow this exact workflow:

STEP 1 — Identify, from the scraped content only:
Business Name, Industry, Services, Products, Target Customers, Business Location, Years in Business (if stated), Contact Details, Owner/Founder/Director (if a real person is named), Mobile Number (ignore landline numbers), Email Address, Social Media presence, Booking System, CRM/ERP if visible, Payment Methods, WhatsApp availability, and Technology stack if detectable.

STEP 2 — Audit the website across these dimensions, grounded ONLY in the scraped text and structural signals given to you:
UI Design, UX, Mobile Responsiveness (use the viewport meta signal), Navigation, Call To Action, Lead Capture (use the contact-form signal), Contact Visibility, Loading Experience, SEO Basics (title/meta description quality), Trust Signals, Google Reviews, Testimonials, Portfolio, Branding, Accessibility.

STEP 3 — Identify top pain points: operational, sales, marketing, and customer-experience problems, possible revenue loss, and manual processes — but ONLY ones evidenced by the scraped content and signals. Never invent a problem you cannot point to evidence for.

STEP 4 — Recommend solutions ONLY from this list, and only where they genuinely fit the evidence collected: CRM, ERP, Hotel Management, Restaurant POS, Booking System, Inventory, Billing, Payroll, Attendance, WhatsApp Automation, QR Ordering, Online Booking, Lead Management, Marketing Automation, Reports, Analytics, Custom Software, Website Redesign, Mobile App.

STEP 5 — Write a cold outreach email:
- Mention something SPECIFIC from their website (a real detail drawn from the scraped text).
- Include one genuine website observation (drawn from your audit).
- Include one business opportunity.
- Explain how Dreams Technology can help.
- Friendly, professional tone. No buzzwords. No fake claims, no fabricated statistics or case studies (never say things like "we've helped hundreds of companies" — we have no such data).
- Use phrasing such as "Based on what we observed on your website...".
- Mention only 2-3 relevant improvements — never overwhelm the reader.
- End with a soft call to action (e.g. offer a free consultation or demo).
- The email body must be a MAXIMUM of 180 words.

STEP 6 — Self-review before responding: every single claim in your output must be traceable to the supplied scraped content or structural signals. No assumptions. No fake statistics, clients, or case studies. If something is not verifiable from the given content, use "Not found" or "Not detectable from site" instead of guessing.

STEP 7 — Respond with ONLY a single JSON object, no markdown fences, no commentary outside the JSON, in exactly this shape:
{
  "businessProfile": { "businessName": "", "industry": "", "services": "", "products": "", "targetCustomers": "", "location": "", "yearsInBusiness": "", "ownerName": "", "mobileNumber": "", "email": "", "socialMedia": "", "bookingSystem": "", "crmOrErp": "", "paymentMethods": "", "whatsappAvailable": "", "techStack": "" },
  "websiteAudit": { "uiDesign": "", "ux": "", "mobileResponsiveness": "", "navigation": "", "callToAction": "", "leadCapture": "", "contactVisibility": "", "loadingExperience": "", "seoBasics": "", "trustSignals": "", "googleReviews": "", "testimonials": "", "portfolio": "", "branding": "", "accessibility": "" },
  "painPoints": ["..."],
  "opportunities": ["..."],
  "recommendedServices": ["..."],
  "emailSubject": "...",
  "emailBody": "...",
  "confidence": "High" | "Medium" | "Low"
}

Use short phrases (not full paragraphs) as string values for every businessProfile and websiteAudit field so the JSON renders cleanly. Use "Not found" or "Not detectable from site" for genuinely unknown fields rather than guessing. Set "confidence" based on how much real signal was available from the crawl (e.g. "Low" if very little content was scraped).`;
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// Enforce the 180-word cap in code rather than trusting the model: trim whole paragraphs off the
// end first, then whole sentences, and only as a last resort cut at a word boundary (never mid-word).
function enforceWordCap(text, maxWords) {
  if (!text) return text;
  if (countWords(text) <= maxWords) return text;

  const paragraphs = text.split(/\n\n+/);
  while (paragraphs.length > 1 && countWords(paragraphs.join(' ')) > maxWords) {
    paragraphs.pop();
  }
  let result = paragraphs.join('\n\n');
  if (countWords(result) <= maxWords) return result;

  const sentences = result.split(/(?<=[.!?])\s+/);
  while (sentences.length > 1 && countWords(sentences.join(' ')) > maxWords) {
    sentences.pop();
  }
  result = sentences.join(' ');
  if (countWords(result) <= maxWords) return result;

  const capped = result.split(/\s+/).slice(0, maxWords).join(' ');
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function sanitizeResult(parsed, lead) {
  const businessProfile =
    parsed && typeof parsed.businessProfile === 'object' && parsed.businessProfile !== null ? parsed.businessProfile : {};
  const websiteAudit =
    parsed && typeof parsed.websiteAudit === 'object' && parsed.websiteAudit !== null ? parsed.websiteAudit : {};
  const painPoints = Array.isArray(parsed.painPoints) ? parsed.painPoints : [];
  const opportunities = Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
  const recommendedServices = Array.isArray(parsed.recommendedServices) ? parsed.recommendedServices : [];

  const businessName = businessProfile.businessName || lead.hotel_name || 'your business';
  const emailSubject = (parsed.emailSubject || '').toString().trim() || `Quick thoughts on ${businessName}'s website`;

  const emailBody = enforceWordCap((parsed.emailBody || '').toString().trim(), EMAIL_BODY_WORD_CAP);

  const confidence = ['High', 'Medium', 'Low'].includes(parsed.confidence) ? parsed.confidence : 'Medium';

  return {
    businessProfile,
    websiteAudit,
    painPoints,
    opportunities,
    recommendedServices,
    emailSubject,
    emailBody,
    confidence,
  };
}

async function researchAndDraft(lead) {
  if (!lead || !lead.website) return null;

  try {
    const pages = await crawlSite(normalizeUrl(lead.website));
    if (!pages || pages.length === 0) return null;

    const scrapedContext = buildScrapedContext(pages);
    const leadContext = `Business: ${lead.hotel_name || 'Unknown'}\nOwner (from CRM, may be outdated): ${lead.owner_name || 'Unknown'}\nCity: ${lead.city || 'Unknown'}${lead.business_category ? `\nCategory: ${lead.business_category}` : ''}\nWebsite: ${lead.website}\n\nScraped website content (static HTML crawl, ${pages.length} page(s)):\n${scrapedContext}`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: leadContext },
      ],
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    return sanitizeResult(parsed, lead);
  } catch (error) {
    console.error('[LeadResearch] researchAndDraft error:', error.message);
    return null;
  }
}

module.exports = { researchAndDraft };
