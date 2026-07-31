#!/bin/bash
set -e

pnpm install --frozen-lockfile

# Push schema to the dev database (DATABASE_URL)
pnpm --filter @workspace/db run push-force

# Also push to production Neon database when PROD_DATABASE_URL is set.
# Set this secret in the Replit workspace to keep production in sync automatically
# on every merge — no manual step required.
if [ -n "$PROD_DATABASE_URL" ]; then
  echo "Pushing schema to production database..."

  # Capture combined stdout+stderr so the error output can be included in the
  # operator alert. Use a temp file to avoid subshell variable-scoping issues.
  PUSH_OUTPUT_FILE=$(mktemp)

  # Temporarily disable set -e so we can detect the failure ourselves.
  set +e
  DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/db run push-force 2>&1 | tee "$PUSH_OUTPUT_FILE"
  PUSH_EXIT=${PIPESTATUS[0]}
  set -e

  if [ "$PUSH_EXIT" -ne 0 ]; then
    echo "ERROR: Production schema push failed (exit code $PUSH_EXIT)." >&2

    # Send a Slack alert (or prominent stderr banner) so the operator is notified
    # without having to dig through CI logs.
    SCHEMA_PUSH_ERROR=$(cat "$PUSH_OUTPUT_FILE") \
      pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-schema-push-failure.ts || true

    rm -f "$PUSH_OUTPUT_FILE"
    exit "$PUSH_EXIT"
  fi

  rm -f "$PUSH_OUTPUT_FILE"
  echo "Production schema push complete."
else
  echo "PROD_DATABASE_URL is not set — skipping production schema push."
  echo "See DEPLOY.md §8 to configure automatic production sync."
fi
