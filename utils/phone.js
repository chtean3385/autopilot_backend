// Shared phone helpers. normalizeMobileNumber moved here from schedulerService.js so the
// directory crawler can reuse it without importing schedulerService (which starts cron jobs on load).

// Normalize raw phone → 12-digit WhatsApp-ready Indian mobile (91XXXXXXXXXX)
// Returns null for landlines or invalid numbers.
//
// Indian landline detection using Google's international_phone_number format:
//   Mobiles:   "+91 98765 43210"  → digit groups after +91: one group of 10
//   Landlines: "+91 79 2345 6789" → digit groups after +91: STD (2-3 digits) + local (6-8 digits)
//
// We detect landlines by checking if the number after +91 is split into
// a short STD prefix (2-3 digits) followed by 6-8 digit local number.
function normalizeMobileNumber(rawPhone) {
  const str = (rawPhone || '').trim();

  // If Google gave us international format (+91 ...), analyse the spacing
  const intlMatch = str.match(/^\+91\s+(.+)$/);
  if (intlMatch) {
    const afterCode = intlMatch[1].trim();
    const parts = afterCode.split(/\s+/);

    if (parts.length >= 2) {
      // First part is STD code (2-4 digits), rest is local number
      // Mobile numbers from Google come as a single group or 2 groups of 5
      const firstLen = parts[0].replace(/\D/g, '').length;
      const restDigits = parts.slice(1).join('').replace(/\D/g, '');

      // Landline pattern: short first group (2-4 digits) + 6-8 digit local
      if (firstLen <= 4 && restDigits.length >= 6 && restDigits.length <= 8) {
        console.log(`[Scraper] Rejecting landline (STD format): ${str}`);
        return null;
      }
    }
  }

  // National landline format: 0 + 2-4 digit STD code + separator ("079-23287589", "079 2328 7589").
  // Without this, stripping to digits turned 079-23287589 into 7923287589 — a valid-looking mobile.
  if (/^0\d{2,4}[\s-]/.test(str)) return null;

  // Strip all non-digits and validate as Indian mobile
  const digits = str.replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    const mobile = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(mobile)) return digits;
    return null;
  }

  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return '91' + digits;
  }

  // 11 digits with leading 0 (local STD format like 07912345678) — likely landline
  if (digits.length === 11 && digits.startsWith('0')) {
    const withoutZero = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(withoutZero)) return '91' + withoutZero;
    return null;
  }

  return null;
}

module.exports = { normalizeMobileNumber };
