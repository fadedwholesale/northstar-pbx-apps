#!/usr/bin/env bash
# Creates a NEW Twilio Standard API Key (SK + secret) via the Twilio REST API using your
# primary credentials, then uploads TWILIO_API_KEY + TWILIO_API_SECRET to Supabase Edge secrets.
#
# Prerequisites: Twilio Console → Account (copy Account SID + Auth Token once).
#
# Usage:
#   TWILIO_ACCOUNT_SID='ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
#   TWILIO_AUTH_TOKEN='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
#   ./scripts/rotate-twilio-api-key-and-push-to-supabase.sh
#
# Or:
#   ./scripts/rotate-twilio-api-key-and-push-to-supabase.sh --env-file /path/to/temp.env
#
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-gbffglopzqxmsvzazkfj}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?}"
      shift 2
      ;;
    --project-ref)
      PROJECT_REF="${2:?}"
      shift 2
      ;;
    -h|--help)
      sed -n '1,25p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" ]]; then
  echo "Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN." >&2
  echo "Copy both from Twilio Console → Account → API keys & tokens (show Auth Token)." >&2
  exit 1
fi

if [[ "${TWILIO_ACCOUNT_SID}" != AC* ]]; then
  echo "TWILIO_ACCOUNT_SID must start with AC" >&2
  exit 1
fi

echo "Creating new Twilio API Key (FriendlyName: northstar-supabase-edge)..."
RESP="$(curl -sS -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Keys.json" \
  -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
  -d "FriendlyName=northstar-supabase-edge")"

if echo "$RESP" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  :
else
  echo "Twilio API error (invalid JSON). Raw response:" >&2
  echo "$RESP" >&2
  exit 1
fi

CODE="$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('code', d.get('status', '')))" 2>/dev/null || true)"
if [[ "$RESP" == *'"code"'* ]] && [[ "$RESP" != *'"sid"'* ]]; then
  echo "Twilio rejected the request:" >&2
  echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP" >&2
  exit 1
fi

SK="$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['sid'])")"
SECRET="$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")"

if [[ "${SK:-}" != SK* ]]; then
  echo "Unexpected Key SID: $SK" >&2
  exit 1
fi

echo "Pushing TWILIO_API_KEY + TWILIO_API_SECRET + TWILIO_ACCOUNT_SID to Supabase (project: $PROJECT_REF)..."

cd "$REPO_ROOT"
supabase secrets set \
  TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
  TWILIO_API_KEY="$SK" \
  TWILIO_API_SECRET="$SECRET" \
  --project-ref "$PROJECT_REF" \
  --yes

echo ""
echo "Done. New API Key SID: $SK"
echo "The secret was sent to Supabase only; it is not printed again."
echo "Optional: delete old API keys in Twilio Console if you no longer need them."
echo "Test: curl -s -X POST https://${PROJECT_REF}.functions.supabase.co/twilio-access-token -H 'Content-Type: application/json' -d '{\"identity\":\"test\"}' | head -c 200"
