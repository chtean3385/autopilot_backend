// Static (non-headless) technology fingerprinting: pure regex over a page's raw HTML string.
// No cheerio needed — cheap enough to run on every crawled page. Feeds leadResearchService.js's
// `technology` object; these fields are never left to GPT to guess (see leadResearchService.js).

const CMS_SIGNATURES = [
  { name: 'WordPress', pattern: /wp-content\/|wp-includes\/|wp-json|<meta[^>]+generator[^>]+wordpress/i },
  { name: 'Wix', pattern: /static\.wixstatic\.com|_wixCIDX|<meta[^>]+generator[^>]+wix/i },
  { name: 'Shopify', pattern: /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i },
  { name: 'Squarespace', pattern: /static\d?\.squarespace\.com|<meta[^>]+generator[^>]+squarespace/i },
  { name: 'Webflow', pattern: /website-files\.com|data-wf-(page|site)/i },
  { name: 'Joomla', pattern: /<meta[^>]+generator[^>]+joomla|\/media\/jui\// },
  { name: 'Drupal', pattern: /Drupal\.settings|\/sites\/default\/files\/|<meta[^>]+generator[^>]+drupal/i },
];

const ECOMMERCE_SIGNATURES = [
  { name: 'WooCommerce', pattern: /woocommerce/i },
  { name: 'Magento', pattern: /Mage\.Cookies|Magento_|\/skin\/frontend\// },
  { name: 'Shopify', pattern: /cdn\.shopify\.com|myshopify\.com/i },
];

const CHAT_WIDGET_SIGNATURES = [
  { name: 'Tawk.to', pattern: /embed\.tawk\.to/i },
  { name: 'Intercom', pattern: /widget\.intercom\.io|Intercom\(/ },
  { name: 'Drift', pattern: /js\.driftt\.com/i },
  { name: 'Crisp', pattern: /client\.crisp\.chat|\$crisp/i },
  { name: 'Zendesk Chat', pattern: /static\.zdassets\.com/i },
  { name: 'Freshchat', pattern: /wchat\.freshchat\.com/i },
  { name: 'WhatsApp', pattern: /wa\.me\/|api\.whatsapp\.com/i },
];

const FORM_TOOL_SIGNATURES = [
  { name: 'Typeform', pattern: /embed\.typeform\.com|typeform\.com\/to\// },
  { name: 'HubSpot Forms', pattern: /js\.hsforms\.net|hsforms\.com/i },
  { name: 'Contact Form 7', pattern: /wpcf7/i },
  { name: 'Gravity Forms', pattern: /gform_wrapper|gravityforms/i },
  { name: 'Google Forms', pattern: /docs\.google\.com\/forms/i },
  { name: 'JotForm', pattern: /jotform\.com/i },
];

const CRM_SIGNATURES = [
  { name: 'HubSpot', pattern: /hs-scripts\.com|hs-analytics\.net/i },
  { name: 'Salesforce', pattern: /servlet\.WebToLead/i },
  { name: 'Zoho', pattern: /salesiq\.zoho\.com|zoho\.com\/crm/i },
  { name: 'Pipedrive', pattern: /pipedrive\.com/i },
  { name: 'Freshsales', pattern: /freshsales\.io|freshworks\.com/i },
];

const ANALYTICS_SIGNATURES = [
  { name: 'Google Analytics (GA4)', pattern: /gtag\(['"]config['"],\s*['"]G-|googletagmanager\.com\/gtag\/js/i },
  { name: 'Universal Analytics', pattern: /google-analytics\.com\/analytics\.js|UA-\d{4,}-\d+/i },
  { name: 'Google Tag Manager', pattern: /googletagmanager\.com\/gtm\.js/i },
  { name: 'Meta Pixel', pattern: /connect\.facebook\.net\/[^"']+\/fbevents\.js|fbq\(['"]init['"]/i },
  { name: 'Hotjar', pattern: /static\.hotjar\.com/i },
  { name: 'Microsoft Clarity', pattern: /clarity\.ms\/tag/i },
];

// Keyword-in-body fallback + real script/domain fingerprints — replaces the old crude
// keyword-only paymentMentions check that used to live in leadResearchService.js's extractSignals.
const PAYMENT_SIGNATURES = [
  { name: 'Razorpay', pattern: /checkout\.razorpay\.com|razorpay\.com/i },
  { name: 'Stripe', pattern: /js\.stripe\.com|stripe\.com\/v3/i },
  { name: 'PayU', pattern: /secure\.payu\.in|payu\.in/i },
  { name: 'Instamojo', pattern: /instamojo\.com/i },
  { name: 'PayPal', pattern: /paypal\.com\/sdk\/js|paypalobjects\.com/i },
  { name: 'UPI', pattern: /\bupi:\/\/pay|\bUPI\b.{0,20}(id|payment)/i },
];

const SEO_SIGNATURES = [
  { name: 'Structured data (schema.org)', pattern: /application\/ld\+json/i },
  { name: 'Canonical tag', pattern: /<link[^>]+rel=["']canonical["']/i },
  { name: 'Open Graph tags', pattern: /<meta[^>]+property=["']og:/i },
  { name: 'Meta robots', pattern: /<meta[^>]+name=["']robots["']/i },
];

// Header-based fingerprints — needs the response headers, not just the HTML body, so this only
// runs where a caller supplies them (see fetchPageWithMeta in siteCrawler.js). Optional/additive:
// detectTechnology() below works exactly as before when called with no headers.
const HOSTING_HEADER_SIGNATURES = [
  { name: 'Cloudflare', test: (h) => 'cf-ray' in h || /cloudflare/i.test(h['server'] || '') },
  { name: 'Vercel', test: (h) => 'x-vercel-id' in h || /vercel/i.test(h['server'] || '') },
  { name: 'Netlify', test: (h) => /netlify/i.test(h['server'] || '') || 'x-nf-request-id' in h },
  { name: 'AWS (CloudFront/S3)', test: (h) => 'x-amz-cf-id' in h || /amazons3/i.test(h['server'] || '') },
  { name: 'GitHub Pages', test: (h) => /github\.io|github\.com/i.test(h['server'] || '') },
];

function firstMatch(html, signatures) {
  const hit = signatures.find((s) => s.pattern.test(html));
  return hit ? hit.name : null;
}

function allMatches(html, signatures) {
  return signatures.filter((s) => s.pattern.test(html)).map((s) => s.name);
}

function detectHosting(headers) {
  if (!headers) return null;
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const hit = HOSTING_HEADER_SIGNATURES.find((s) => s.test(lowerHeaders));
  return hit ? hit.name : null;
}

// Per-page detection. Callers merge across every page of a crawl since some plugins/widgets
// only mount on inner pages, not the homepage. `headers` is optional — only the homepage fetch
// in leadResearchService.js currently supplies it (via fetchPageWithMeta).
function detectTechnology(html, headers) {
  return {
    cms: firstMatch(html, CMS_SIGNATURES),
    ecommerce: firstMatch(html, ECOMMERCE_SIGNATURES),
    chatWidgets: allMatches(html, CHAT_WIDGET_SIGNATURES),
    formTools: allMatches(html, FORM_TOOL_SIGNATURES),
    crmSignals: allMatches(html, CRM_SIGNATURES),
    analytics: allMatches(html, ANALYTICS_SIGNATURES),
    paymentGateways: allMatches(html, PAYMENT_SIGNATURES),
    seoSignals: allMatches(html, SEO_SIGNATURES),
    hosting: detectHosting(headers),
  };
}

// Merges detectTechnology() results across every fetched page of a crawl into one summary.
function mergeTechnology(perPageResults) {
  const merged = {
    cms: null, ecommerce: null, hosting: null,
    chatWidgets: [], formTools: [], crmSignals: [], analytics: [], paymentGateways: [], seoSignals: [],
  };
  for (const r of perPageResults) {
    if (!merged.cms && r.cms) merged.cms = r.cms;
    if (!merged.ecommerce && r.ecommerce) merged.ecommerce = r.ecommerce;
    if (!merged.hosting && r.hosting) merged.hosting = r.hosting;
    for (const w of r.chatWidgets) if (!merged.chatWidgets.includes(w)) merged.chatWidgets.push(w);
    for (const f of r.formTools) if (!merged.formTools.includes(f)) merged.formTools.push(f);
    for (const c of r.crmSignals) if (!merged.crmSignals.includes(c)) merged.crmSignals.push(c);
    for (const a of (r.analytics || [])) if (!merged.analytics.includes(a)) merged.analytics.push(a);
    for (const p of (r.paymentGateways || [])) if (!merged.paymentGateways.includes(p)) merged.paymentGateways.push(p);
    for (const s of (r.seoSignals || [])) if (!merged.seoSignals.includes(s)) merged.seoSignals.push(s);
  }
  return merged;
}

module.exports = { detectTechnology, mergeTechnology };
