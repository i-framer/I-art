---
name: Vercel deploy gotchas (i-art.com.au)
description: Why Vercel deployments fail instantly and why blob uploads 500 in production
---

## Instant "deployment error" = plan-level cron rejection
Sub-daily cron schedules in `vercel.json` (e.g. `*/5 * * * *`) require Vercel Pro.
On Hobby, every deployment fails in ~10 seconds with a generic
"deployment error; reach out to Vercel Help" — no build log, and Vercel re-reports
the same failed `dpl_...` id for every subsequent commit (GitHub statuses all point
to one deployment). Crons were switched to daily (`0 1 * * *`, `30 1 * * *`);
sweeps stay externally triggerable via POST with CRON_SECRET.
**How to apply:** if Vercel fails instantly with no log, check vercel.json crons vs plan first.

## Blob store is/was PRIVATE — uploads with access:"public" are rejected
The production Vercel Blob store was created with private access. `put(..., {access:"public"})`
throws "Cannot use public access on a private store" — this was the root cause of the
production upload 500. Reads (`list()`) still pass, so a read-only health check looks green.
**How to apply:** health checks on storage must probe writes, not just reads. The app's
architecture (stable public blob URLs via getServeUrl) requires a PUBLIC store; fixing it
is a Vercel dashboard action (create/connect a public store), not a code change.

## Stale-build false alarm (Aug 2026)
A "missing tables" drift-check failure in the Vercel dashboard turned out to be an old deployment that ran before the schema push — not a second database. Before hunting for a rogue DATABASE_URL, check the failing build's timestamp vs the schema-push time, and just redeploy. Note: workspace secret VERCEL_DATABASE_URL is byte-identical to PROD_DATABASE_URL (one Neon project, one branch).
