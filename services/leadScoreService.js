const pool = require('../config/db');

// Lead completeness score, 0-100: how much real contact data we hold for a lead. Every field we
// have = 100 = hot. Pure SQL over hotel_leads columns, so it can never drift from the data — run
// refreshScores() after anything that changes a lead, and the 10-minute sweep catches the rest
// (e.g. emailVerificationWorker flipping an email to verified).
//
//   business name               10
//   WhatsApp-able Indian mobile 25
//   email                       20  (unverifiable: 10, bounced/unsubscribed: 0)
//     … verified                +5
//   website                     15
//   category                    10
//   contact person              10
//   address                      5
//                              ----
//                              100
//
// Tier: hot >= 80, warm >= 50, else cold. The cadence starts hot leads first.
const HOT_MIN = 80;
const WARM_MIN = 50;

const SCORE_SQL = `(
  (CASE WHEN COALESCE(TRIM(hotel_name), '') <> '' THEN 10 ELSE 0 END)
  + (CASE WHEN whatsapp_number ~ '^91[6-9][0-9]{9}$' THEN 25 ELSE 0 END)
  + (CASE
       WHEN COALESCE(TRIM(email), '') = '' OR email_status IN ('bounced', 'unsubscribed') THEN 0
       WHEN email_status = 'verified' THEN 25
       WHEN email_status = 'unverifiable' THEN 10
       ELSE 20
     END)
  + (CASE WHEN COALESCE(TRIM(website), '') <> '' THEN 15 ELSE 0 END)
  + (CASE WHEN COALESCE(TRIM(business_category), '') <> '' THEN 10 ELSE 0 END)
  + (CASE WHEN COALESCE(TRIM(owner_name), '') <> '' THEN 10 ELSE 0 END)
  + (CASE WHEN COALESCE(TRIM(address), '') <> '' THEN 5 ELSE 0 END)
)`;

const TIER_SQL = `(CASE WHEN ${SCORE_SQL} >= ${HOT_MIN} THEN 'hot' WHEN ${SCORE_SQL} >= ${WARM_MIN} THEN 'warm' ELSE 'cold' END)`;

// leadIds omitted → every lead whose stored score is out of date.
async function refreshScores(leadIds = null) {
  const ids = Array.isArray(leadIds) ? leadIds.filter(Boolean) : null;
  if (ids && ids.length === 0) return 0;
  const result = await pool.query(
    `UPDATE hotel_leads SET lead_score = ${SCORE_SQL}, lead_tier = ${TIER_SQL}
     WHERE ($1::int[] IS NULL OR id = ANY($1::int[]))
       AND (lead_score IS DISTINCT FROM ${SCORE_SQL} OR lead_tier IS DISTINCT FROM ${TIER_SQL})`,
    [ids]
  );
  return result.rowCount;
}

module.exports = { refreshScores, HOT_MIN, WARM_MIN };
