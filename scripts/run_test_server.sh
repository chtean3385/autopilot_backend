#!/usr/bin/env bash
# Boots the backend against the throwaway test DB (scripts/setup_overnight_db.js) with every outbound
# channel disabled: OUTBOUND_DRY_RUN blocks sends at the choke points, and the WhatsApp/verifier/
# Places credentials are blanked so even an unguarded call can't authenticate. dotenv never overrides
# a variable that is already set, so these empty values win over backend/.env.
# Usage: bash scripts/run_test_server.sh [port]   (default 5055)
cd "$(dirname "$0")/.."
DEV_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
export DATABASE_URL="${DEV_URL%/*}/${TEST_DB_NAME:-autoagent_overnight}"
export OUTBOUND_DRY_RUN=true
export AUTH_DISABLED=true   # test server only — the VPS never sets this (see services/authService.js)
export PORT="${1:-5055}"
export NODE_ENV=development
export WABA_API_TOKEN= WABA_PHONE_ID= WABA_BUSINESS_ACCOUNT_ID= OWNER_WHATSAPP=
export GOOGLE_PLACES_API_KEY= VERIFIER_API_KEY= HUNTER_API_KEY=
exec node server.js
