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
  DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/db run push-force
  echo "Production schema push complete."
else
  echo "PROD_DATABASE_URL is not set — skipping production schema push."
  echo "See DEPLOY.md §8 to configure automatic production sync."
fi
