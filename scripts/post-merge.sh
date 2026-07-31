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

  # Verify the push actually took effect — catches cases where push-force
  # succeeded but the live database is still behind (e.g. a partial push or a
  # connection to the wrong database).
  echo "Verifying production schema after push..."
  set +e
  DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/db run check-drift
  DRIFT_EXIT=$?
  set -e

  if [ "$DRIFT_EXIT" -ne 0 ]; then
    echo "ERROR: Production schema drift check failed after push (exit code $DRIFT_EXIT)." >&2
    echo "       The push appeared to succeed but the live schema still does not match." >&2
    echo "       Check the output above, verify PROD_DATABASE_URL points to the correct" >&2
    echo "       database, and redeploy." >&2
    exit "$DRIFT_EXIT"
  fi

  echo "Production schema push complete."
else
  # PROD_DATABASE_URL is absent — this is an operator configuration gap.
  # Emit a prominent stderr banner so it is visible in CI logs, then attempt
  # a Slack alert so the operator is notified even if they are not watching logs.
  {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "OPERATOR ACTION REQUIRED: PROD_DATABASE_URL is not set."
    echo "Production schema push and drift check were SKIPPED after this merge."
    echo "The live database may fall out of sync with the current schema."
    echo "See DEPLOY.md §8 to configure automatic production sync."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  } >&2

  SCHEMA_PUSH_ERROR="PROD_DATABASE_URL is not configured in the Replit workspace secrets.\n\nProduction schema push and drift check were SKIPPED for this merge.\nThe live database may fall out of sync with the deployed schema.\n\nTo fix: add PROD_DATABASE_URL to the workspace secrets.\nSee DEPLOY.md §8 for full instructions." \
    pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-schema-push-failure.ts || true
fi
