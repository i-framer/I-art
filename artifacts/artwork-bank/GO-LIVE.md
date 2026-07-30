# Go-Live Checklist Report — i-art.com.au

**Date:** 30 July 2026 (checked from an automated environment against the live domain and Stripe API)
**Runbook:** `artifacts/artwork-bank/DEPLOY.md`

## Summary

DNS, certificates, and deployment routing are **live and correct**. The Vercel
deployment itself is **not yet healthy**: every database-backed page returns
HTTP 500 and the sweep endpoint reports its secret is unset, which strongly
indicates the required production environment variables (at minimum
`DATABASE_URL`, `CRON_SECRET`, `STRIPE_WEBHOOK_SECRET`) are missing in Vercel.
A live Stripe webhook endpoint has been created; its signing secret must be
copied into Vercel before it will work. One config mismatch was found: Vercel
redirects the apex to **www**, while the app is configured for apex-canonical.

| # | Item | Result |
|---|---|---|
| 1a | Nameservers point to Vercel (`ns1/ns2.vercel-dns.com`) | ✅ PASS |
| 1b | Apex `i-art.com.au` resolves + valid HTTPS cert (Let's Encrypt, valid to 28 Oct 2026) | ✅ PASS |
| 1c | Wildcard cert `*.i-art.com.au` issued; `jane.i-art.com.au` serves HTTPS | ✅ PASS |
| 1d | Tenant subdomain opens the correct storefront | ❌ FAIL — page returns 500 (app-wide failure, see item 2) |
| 1e | `i-art.au` redirect domain | ❌ FAIL — `i-art.au` has no A record and nameservers still point at `name-servers.net.au`; not added/propagated to Vercel |
| 1f | Apex/www redirect direction | ⚠️ MISMATCH — Vercel 308-redirects `i-art.com.au` → `www.i-art.com.au`, but `NEXT_PUBLIC_SITE_URL` and the runbook expect the **apex** as canonical. This also breaks the webhook and cron URLs on the apex (Stripe/cron won't follow redirects). |
| 2 | Production env vars set in Vercel | ❌ FAIL (inferred — no Vercel API access from this environment): all SSR pages return 500 (`DATABASE_URL` likely missing/broken); `/api/email-sweep` returns *"EMAIL_SWEEP_SECRET (or CRON_SECRET) must be set in production"* → `CRON_SECRET` **not set**; webhook route returns *"Configure STRIPE_WEBHOOK_SECRET…"* → `STRIPE_WEBHOOK_SECRET` **not set**. `STRIPE_WEBHOOK_DEV_BYPASS` shows no sign of being active (signature is enforced) — ✅. |
| 3a | Live Stripe webhook endpoint exists | ✅ DONE — created `we_1TymEuErHGiDuwvxwsMw2NWC` → `https://i-art.com.au/api/stripe/webhook` with all six required events (`checkout.session.completed/expired`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed`) |
| 3b | Signing secret set in Vercel + dashboard test event returns 200 | ❌ PENDING — operator must copy the signing secret (Stripe Dashboard → Webhooks → this endpoint → Reveal) into `STRIPE_WEBHOOK_SECRET` in Vercel, then send a test event. Currently a test event would fail: the apex URL 308-redirects to www (item 1f) and the secret is unset. |
| 4a | Cron sweeps run authorized (email 10 min, reservation 5 min) | ❌ FAIL — `CRON_SECRET` unset (see item 2); `/api/reservation-sweep` returns 500 "Sweep failed" (DB unreachable). Vercel cron logs not accessible from this environment. |
| 4b | Test transactional email + SPF/DKIM | ❌ PENDING — no evidence SMTP/Resend vars are set; cannot send until env vars are configured. Run §6b/§6c of DEPLOY.md after configuring. |

## Operator actions required (in order)

1. **Fix domain redirect direction** — Vercel → Settings → Domains: make
   `i-art.com.au` the primary domain and set `www.i-art.com.au` to redirect to
   it (currently reversed). Without this, the Stripe webhook and Vercel cron
   requests to the apex get a 308 and fail.
2. **Set required production env vars** (Vercel → Settings → Environment
   Variables, per the Required table in DEPLOY.md §2): `DATABASE_URL`,
   `SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`,
   `NEXT_PUBLIC_SITE_URL=https://i-art.com.au`, `STRIPE_SECRET_KEY` (live),
   `STRIPE_WEBHOOK_SECRET` (from the endpoint created above), `SMTP_*` **or**
   `RESEND_API_KEY`, `CRON_SECRET`. Confirm `STRIPE_WEBHOOK_DEV_BYPASS` is
   absent. Redeploy.
3. **Apply the DB schema** to the production database if not yet done:
   `DATABASE_URL=... pnpm --filter @workspace/db run push`.
4. **Verify webhook**: Stripe Dashboard → Webhooks → send a test event
   (`customer.subscription.created`) → expect `200 {"received":true}`.
5. **Verify crons**: Vercel → Crons shows successful runs of
   `/api/email-sweep` (every 10 min) and `/api/reservation-sweep` (every 5
   min); or `curl -H "Authorization: Bearer $CRON_SECRET" https://i-art.com.au/api/email-sweep`.
6. **Email smoke test** per DEPLOY.md §6b/§6c (mail-tester.com: SPF, DKIM,
   DMARC all pass; inquiry + order-confirmation emails delivered).
7. **`i-art.au`**: add the domain to the Vercel project as a redirect to
   `i-art.com.au` and switch its nameservers/DNS at the registrar.
8. Re-check item 1d (tenant subdomain storefront) once the app is healthy.

## Follow-ups already tracked elsewhere

- Migrating existing artwork images to Vercel Blob (Task #85)
- Automated tenant-subdomain routing tests (Task #86), DNS-instruction verification (Task #67)
- Tenant custom-domain self-serve provisioning (`VERCEL_API_TOKEN` flow) — not configured; verify only after go-live.
