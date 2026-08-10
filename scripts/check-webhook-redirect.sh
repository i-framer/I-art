#!/usr/bin/env bash
# check-webhook-redirect.sh
#
# Confirms that the apex domain (i-art.com.au) does NOT redirect the Stripe
# webhook endpoint OR the Vercel cron endpoints.  Vercel cron and Stripe both
# hit registered paths exactly and silently fail on 3xx — this script catches
# the misconfiguration before it becomes a production incident.
#
# Checks three endpoints:
#   1. /api/stripe/webhook  — Stripe webhook (does not follow redirects)
#   2. /api/email-sweep     — Vercel cron (every 10 min); GET with Bearer token
#   3. /api/reservation-sweep — Vercel cron (every 5 min); GET with Bearer token
#
# Usage:
#   bash scripts/check-webhook-redirect.sh
#   bash scripts/check-webhook-redirect.sh https://www.i-art.com.au/api/stripe/webhook
#
# When called with no arguments, all three apex endpoints are checked.
# When called with one argument, only that URL is checked.
#
# Exit codes:
#   0 — all checked endpoints returned a non-3xx status (safe)
#   1 — at least one endpoint redirected (fix Vercel primary domain first)
#   2 — curl failed (network / DNS problem)

set -euo pipefail

BASE_URL="https://i-art.com.au"

# If a single URL is passed, check only that URL (backward-compatible).
SINGLE_URL="${1:-}"

check_url() {
  local url="$1"
  local label="$2"

  echo "Checking: $url"

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-redirs 0 \
    --connect-timeout 10 \
    --max-time 15 \
    "$url" 2>&1) || {
    echo "❌  curl failed — cannot reach $url"
    echo "    Check DNS and network connectivity."
    return 2
  }

  LOCATION=$(curl -sI \
    --max-redirs 0 \
    --connect-timeout 10 \
    --max-time 15 \
    "$url" 2>/dev/null | grep -i "^location:" | tr -d '\r' | awk '{print $2}') || true

  echo "HTTP status: $HTTP_CODE"
  if [[ -n "$LOCATION" ]]; then
    echo "Location:    $LOCATION"
  fi

  if [[ "$HTTP_CODE" =~ ^3 ]]; then
    echo "❌  REDIRECT on $label — ${HTTP_CODE} → ${LOCATION:-<see Location header>}"
    echo
    echo "    Fix (DEPLOY.md §4, Option A — recommended):"
    echo "      1. Vercel → Project → Settings → Domains"
    echo "         Click ⋮ next to i-art.com.au → Set as primary"
    echo "      2. Ensure NEXT_PUBLIC_SITE_URL=https://i-art.com.au (no www)"
    echo "      3. Re-register Stripe webhook as https://i-art.com.au/api/stripe/webhook"
    echo "      4. Re-run this script to confirm all three endpoints pass"
    return 1
  else
    if [[ "$HTTP_CODE" == "405" || "$HTTP_CODE" == "400" || "$HTTP_CODE" == "200" \
       || "$HTTP_CODE" == "401" || "$HTTP_CODE" == "403" || "$HTTP_CODE" == "207" ]]; then
      echo "✅  No redirect — $label returned HTTP $HTTP_CODE."
    else
      echo "⚠️  $label returned HTTP $HTTP_CODE — no redirect, but endpoint may not be reachable."
    fi
    return 0
  fi
}

if [[ -n "$SINGLE_URL" ]]; then
  # Backward-compatible single-URL mode
  echo "Checking redirect behaviour for: $SINGLE_URL"
  echo
  check_url "$SINGLE_URL" "$SINGLE_URL"
  exit $?
fi

# Full check — all three critical endpoints
echo "=========================================="
echo " Vercel apex redirect check — i-art.com.au"
echo "=========================================="
echo "Checking that i-art.com.au does NOT redirect the Stripe webhook"
echo "or either Vercel cron endpoint. All three must return non-3xx."
echo

OVERALL=0

echo "--- 1/3  Stripe webhook ---"
check_url "${BASE_URL}/api/stripe/webhook" "Stripe webhook" || OVERALL=1
echo

echo "--- 2/3  Email-sweep cron ---"
check_url "${BASE_URL}/api/email-sweep" "email-sweep cron" || OVERALL=1
echo

echo "--- 3/3  Reservation-sweep cron ---"
check_url "${BASE_URL}/api/reservation-sweep" "reservation-sweep cron" || OVERALL=1
echo

echo "=========================================="
if [[ "$OVERALL" -eq 0 ]]; then
  echo "✅  ALL PASS — apex domain serves all three endpoints directly."
  echo "    Safe to run Vercel crons and register the Stripe webhook."
  echo
  echo "    Verify cron execution:"
  echo "      curl -s -H \"Authorization: Bearer \$CRON_SECRET\" \\"
  echo "           ${BASE_URL}/api/email-sweep | jq ."
  echo "      curl -s -H \"Authorization: Bearer \$CRON_SECRET\" \\"
  echo "           ${BASE_URL}/api/reservation-sweep | jq ."
else
  echo "❌  ONE OR MORE ENDPOINTS REDIRECT — fix the Vercel primary domain."
  echo "    See DEPLOY.md §4 for step-by-step instructions."
fi
echo "=========================================="

exit $OVERALL
