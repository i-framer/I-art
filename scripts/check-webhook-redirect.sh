#!/usr/bin/env bash
# check-webhook-redirect.sh
#
# Confirms that https://i-art.com.au/api/stripe/webhook does NOT redirect
# before you (re-)register it in the Stripe Dashboard.
#
# Stripe does not follow redirects, so a 3xx response means every webhook
# delivery will fail silently.  Run this after any Vercel primary-domain
# change and after the DNS cut-over.
#
# Usage:
#   bash scripts/check-webhook-redirect.sh
#   bash scripts/check-webhook-redirect.sh https://www.i-art.com.au/api/stripe/webhook
#
# Exit codes:
#   0 — endpoint returned a non-3xx status (safe to register in Stripe)
#   1 — endpoint redirected (fix Vercel primary domain first, then re-run)
#   2 — curl failed (network / DNS problem)

set -euo pipefail

WEBHOOK_URL="${1:-https://i-art.com.au/api/stripe/webhook}"

echo "Checking redirect behaviour for: $WEBHOOK_URL"
echo

# Use GET — Stripe uses POST, but we just need to see the status code / Location
# --max-redirs 0 ensures curl reports the redirect rather than following it
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-redirs 0 \
  --connect-timeout 10 \
  --max-time 15 \
  "$WEBHOOK_URL" 2>&1) || {
  echo "❌  curl failed — cannot reach $WEBHOOK_URL"
  echo "    Check DNS and network connectivity."
  exit 2
}

LOCATION=$(curl -sI \
  --max-redirs 0 \
  --connect-timeout 10 \
  --max-time 15 \
  "$WEBHOOK_URL" 2>/dev/null | grep -i "^location:" | tr -d '\r' | awk '{print $2}') || true

echo "HTTP status: $HTTP_CODE"
if [[ -n "$LOCATION" ]]; then
  echo "Location:    $LOCATION"
fi
echo

if [[ "$HTTP_CODE" =~ ^3 ]]; then
  echo "❌  REDIRECT DETECTED — Stripe will NOT follow this ${HTTP_CODE}."
  echo
  echo "    The webhook endpoint at:"
  echo "      $WEBHOOK_URL"
  echo "    redirects to:"
  echo "      ${LOCATION:-<see Location header above>}"
  echo
  echo "    Fix (DEPLOY.md §4, Option A — recommended):"
  echo "      1. Vercel → Project → Settings → Domains"
  echo "         Click ⋮ next to i-art.com.au → Set as primary"
  echo "      2. Ensure NEXT_PUBLIC_SITE_URL=https://i-art.com.au (no www)"
  echo "      3. Re-register Stripe webhook as https://i-art.com.au/api/stripe/webhook"
  echo "      4. Re-run this script to confirm the redirect is gone"
  echo "      5. Send a test event from Stripe Dashboard and confirm 200 in the log"
  exit 1
else
  if [[ "$HTTP_CODE" == "405" || "$HTTP_CODE" == "400" || "$HTTP_CODE" == "200" ]]; then
    echo "✅  No redirect — endpoint returned HTTP $HTTP_CODE."
    echo "    Safe to register $WEBHOOK_URL in the Stripe Dashboard."
    echo
    echo "    Next step: Stripe Dashboard → Developers → Webhooks → Add/edit endpoint"
    echo "    Set URL to: $WEBHOOK_URL"
    echo "    Then send a test event and confirm the delivery log shows 200."
  else
    echo "⚠️  Unexpected HTTP $HTTP_CODE — no redirect but endpoint may not be reachable."
    echo "    Investigate before registering in Stripe."
  fi
  exit 0
fi
