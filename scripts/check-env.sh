#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pre-deploy environment variable validator for Artwork Bank.
#
# Usage:
#   bash scripts/check-env.sh            # checks process environment
#   bash scripts/check-env.sh .env.local # sources a dotenv file first
#
# Exit codes:
#   0 — all required vars are set (warnings may still be printed)
#   1 — one or more required vars are missing
#
# This script is intentionally safe to run in CI and on Vercel preview
# branches. It never reads secret values — only checks existence.
# ---------------------------------------------------------------------------

set -euo pipefail

if [[ $# -ge 1 && -f "$1" ]]; then
  echo "📂  Sourcing $1 ..."
  # shellcheck disable=SC1090
  set -o allexport && source "$1" && set +o allexport
fi

ERRORS=0
WARNINGS=0
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

require_var() {
  local key="$1"
  local hint="${2:-}"
  if [[ -z "${!key:-}" ]]; then
    echo -e "${RED}✗  MISSING  ${key}${NC}${hint:+  — $hint}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "${GREEN}✓  SET      ${key}${NC}"
  fi
}

warn_if_missing() {
  local key="$1"
  local hint="${2:-}"
  if [[ -z "${!key:-}" ]]; then
    echo -e "${YELLOW}⚠  OPTIONAL ${key} is not set${NC}${hint:+  — $hint}"
    WARNINGS=$((WARNINGS + 1))
  else
    echo -e "${GREEN}✓  SET      ${key}${NC}"
  fi
}

warn_if_set() {
  local key="$1"
  local hint="${2:-}"
  if [[ -n "${!key:-}" ]]; then
    echo -e "${RED}✗  DANGER   ${key} is set${NC}${hint:+  — $hint}"
    ERRORS=$((ERRORS + 1))
  fi
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Artwork Bank — Production Environment Variable Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "── Database ─────────────────────────────────────────────────────────────"
require_var DATABASE_URL "Postgres connection string (Neon, Supabase, etc.)"

echo ""
echo "── Session ──────────────────────────────────────────────────────────────"
require_var SESSION_SECRET "Generate: openssl rand -base64 32  (min 32 chars)"

echo ""
echo "── Site routing ─────────────────────────────────────────────────────────"
require_var NEXT_PUBLIC_SITE_URL "Canonical apex URL, e.g. https://i-art.com.au  (NO trailing slash, NO www)"

echo ""
echo "── Cron / sweep endpoints ───────────────────────────────────────────────"
require_var CRON_SECRET "Generate: openssl rand -hex 32  (used by /api/email-sweep and /api/reservation-sweep)"

echo ""
echo "── Stripe ───────────────────────────────────────────────────────────────"
require_var STRIPE_SECRET_KEY "Stripe Dashboard → Developers → API keys (sk_live_...)"
require_var STRIPE_WEBHOOK_SECRET "Stripe Dashboard → Developers → Webhooks → endpoint signing secret (whsec_...)"
warn_if_missing NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY "Stripe publishable key for the checkout UI"
# Safety check: dev bypass must NOT be set in production
warn_if_set STRIPE_WEBHOOK_DEV_BYPASS "This disables webhook signature verification — remove immediately in production"

echo ""
echo "── Image storage ────────────────────────────────────────────────────────"
if [[ -z "${BLOB_READ_WRITE_TOKEN:-}" && -z "${PRIVATE_OBJECT_DIR:-}" ]]; then
  echo -e "${RED}✗  MISSING  Image storage is not configured${NC}"
  echo "            Set BLOB_READ_WRITE_TOKEN (Vercel Blob) or PRIVATE_OBJECT_DIR (local dev)"
  ERRORS=$((ERRORS + 1))
else
  if [[ -n "${BLOB_READ_WRITE_TOKEN:-}" ]]; then
    echo -e "${GREEN}✓  SET      BLOB_READ_WRITE_TOKEN (Vercel Blob)${NC}"
  fi
  if [[ -n "${PRIVATE_OBJECT_DIR:-}" ]]; then
    echo -e "${GREEN}✓  SET      PRIVATE_OBJECT_DIR (local storage)${NC}"
  fi
fi

echo ""
echo "── Email delivery ───────────────────────────────────────────────────────"
if [[ -z "${RESEND_API_KEY:-}" ]]; then
  # Fall back to SMTP
  warn_if_missing SMTP_HOST "Required for transactional email (alternatively set RESEND_API_KEY)"
  warn_if_missing SMTP_USER
  warn_if_missing SMTP_PASS
  warn_if_missing SMTP_FROM "Sender address for order confirmation emails"
else
  echo -e "${GREEN}✓  SET      RESEND_API_KEY${NC}"
  warn_if_missing RESEND_FROM_EMAIL "Sender address for Resend (e.g. orders@i-art.com.au)"
fi

echo ""
echo "── Custom domain auto-provisioning (optional) ───────────────────────────"
warn_if_missing CNAME_TARGET "Required for tenant custom-domain DNS verification (e.g. cname.vercel-dns.com)"
warn_if_missing VERCEL_API_TOKEN "Required for fully self-serve domain provisioning (see DEPLOY.md §4)"
warn_if_missing VERCEL_PROJECT_ID "Required alongside VERCEL_API_TOKEN"

echo ""
echo "── Slack notifications (optional) ───────────────────────────────────────"
warn_if_missing SLACK_WEBHOOK_URL "Schema-drift and orphan-image operator alerts"

echo ""
echo "── Platform fee ─────────────────────────────────────────────────────────"
if [[ -z "${PLATFORM_FEE_PERCENT:-}" ]]; then
  echo -e "${YELLOW}⚠  OPTIONAL PLATFORM_FEE_PERCENT is not set${NC}  — will default to 5%"
  WARNINGS=$((WARNINGS + 1))
else
  # Validate it's a number between 0 and 100
  if [[ "${PLATFORM_FEE_PERCENT}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    local_fee="${PLATFORM_FEE_PERCENT}"
    if (( $(echo "$local_fee > 100" | bc -l 2>/dev/null || echo 0) )); then
      echo -e "${RED}✗  INVALID  PLATFORM_FEE_PERCENT=${PLATFORM_FEE_PERCENT} (must be ≤ 100)${NC}"
      ERRORS=$((ERRORS + 1))
    else
      echo -e "${GREEN}✓  SET      PLATFORM_FEE_PERCENT=${PLATFORM_FEE_PERCENT}%${NC}"
    fi
  else
    echo -e "${RED}✗  INVALID  PLATFORM_FEE_PERCENT=\"${PLATFORM_FEE_PERCENT}\" is not a valid number${NC}"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $ERRORS -gt 0 ]]; then
  echo -e "${RED}  RESULT: $ERRORS error(s), $WARNINGS warning(s) — deployment may fail!${NC}"
  echo "  See DEPLOY.md for the full variable reference."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 1
else
  echo -e "${GREEN}  RESULT: All required variables are set${NC} ($WARNINGS optional warning(s))"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 0
fi
