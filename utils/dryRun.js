// OUTBOUND_DRY_RUN=true blocks every real outbound message (email + WhatsApp + Meta template
// submit/delete) at the two send choke points — emailSenderService.send() and wabaService. The call
// is logged and returns a fake success, so callers (workers, reply handlers) run their normal path
// and write their normal DB rows without anything leaving the machine. Exists because the local dev
// DB mirrors prod (real leads + a live Brevo sender) and .env holds a real WABA token — starting the
// server locally used to mean starting live senders. Never set this on the VPS.
function isDryRun() {
  return String(process.env.OUTBOUND_DRY_RUN || '').toLowerCase() === 'true';
}

function dryRunResult(kind, detail) {
  const messageId = `dryrun-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[DRY RUN] ${kind} blocked — ${detail} (fake id ${messageId})`);
  return { success: true, messageId, dryRun: true, timestamp: new Date() };
}

module.exports = { isDryRun, dryRunResult };
