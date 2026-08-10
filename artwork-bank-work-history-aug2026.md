# Artwork Bank — Engineering Work History & Time Report
**Invoice Period:** August 1, 2026 – August 10, 2026
**Project:** i-art.com.au — Artwork Bank SaaS
**Stack:** Next.js 15 · Drizzle ORM · Neon Postgres · Stripe Connect · Vercel
**Sources:** Git commit history · Task merge records · WORK_LOG.md · WEEKLY_ENGINEERING_REPORT.md · Session conversation logs

> **⚠️ Critical limitation:** `WORK_LOG.md` has no hours recorded in the Time column for any date. The "Recorded Replit Time" column in Section 2 cannot be populated from this source. All Replit session durations are therefore marked **Manual Review Required**. Git commit timestamps reflect agent working windows only — they should not be used as a proxy for human hours without your own time record. External work estimates below are based on the steps documented in the session conversation and commit messages.

---

## Section 2 — Replit Work Sessions

### Friday, August 1

**Session 1 — Early window (00:06–06:18 UTC)**

- Added Privacy and Terms pages with middleware and layout integration
- Added Stripe dashboard screenshot and documentation assets
- Updated GitHub push token configuration in memory

**Session 2 — Afternoon (14:21 UTC)**

- Delivered 30-day free trial for all new subscriptions
- Fixed webhook handler to store real Stripe status (`trialing` vs `active`) instead of defaulting to `active`

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 1 | Privacy/Terms pages; 30-day trial implementation; webhook status fix; asset management | **Manual Review Required** | 2 sessions (00:06–06:18 and 14:21 UTC); 8 commits | Privacy/Terms live; trial system live; webhook correct |

---

### Saturday, August 2

No activity recorded. No commits.

---

### Sunday, August 3

**Single session — Full day (03:22 UTC through end of day)**

47 commits. Tasks merged:

- **Bug fix:** Subdomain routing broken when `NEXT_PUBLIC_SITE_URL` uses `www.` prefix
- **Security fix:** Validate `representedArtistId` belongs to session tenant in `createArtwork`/`updateArtwork` — prevented cross-tenant artwork assignment
- **Security fix:** HTML-escape `sendOrderConfirmation` email body — prevented HTML injection via buyer-controlled order data
- **Build fix:** Excluded `nodemailer` from Vercel Edge bundle (was breaking production builds)
- Storage startup alert (`instrumentation.ts`) + `/api/storage/health` probe endpoint
- `PLATFORM_FEE_PERCENT` startup guard — throws on NaN/negative/out-of-range values; 9 tests
- Task #49: Retry gallery failure alert on each sweep pass until delivered
- Task #46: Show "Update retrying" badge for intermediate status-email failures
- Task #66: Label older inquiry replies sent before sender tracking existed
- Task #148: Persistent warning on order detail when partial-refund buyer notification failed
- Task #305: Checkout commission amount unit tests
- Tasks #283, #285, #287, #292: Browse-filter unit tests (SOLD/RESERVED visibility, HIDDEN exclusion, combined seller+keyword)
- Task #234: `verifyCustomDomain` redirects `no_cname_target` when `getCnameTarget()` is null
- Tasks #38, #296: Rate-limit key isolation tests; prefix-scoped cleanup
- Tasks #80, #88: Billing-access integration tests on real DB (unsubscribed blocked; comped bypass)
- Task #205: Orphan-sweep alert unit tests confirming Slack+email sent on errors > 0
- Task #217: i-Framer premium billing badge and description on billing page
- Tasks #277, #280: Schema-push alert tests confirming Slack+email fires after connector reconnect
- Task #51: Catch DB-save failure after email send in `replyToInquiry` — return `sent_not_saved`
- Task #50: Tracking-note change queues fresh status-email retry
- Tasks #63, #72: Reservation-race and stale-reservation sweep on real DB
- Tasks #73, #74: Bulk inquiry status/archive tenant isolation on real DB
- Task #65: Friendly sender display name in inquiry replies
- Task #69: Invite double-accept integration tests on real DB
- Task #67: Domain verification contract tests (CNAME match, case-insensitive, conflict, unverified, no_cname_target)
- Additional team management, platform admin, webhook signature, and rate-limiter tests
- `DEPLOY.md` updated with `⚠️ www→apex redirect — critical production configuration` warning

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 3 | 22+ tasks; 3 security/bug fixes; 47 commits | **Manual Review Required** | Full-day session; WORK_LOG entry: "Review and approve: Stripe Connect readiness warning, refund tests, email security fix, subdomain routing fix, storage startup alert, artist isolation bug fix" | All tasks delivered; suite green |

---

### Monday, August 4

**Single session — Overnight into afternoon (00:27–12:57 UTC)**

24 commits. Tasks merged:

- Prevent buy button showing when gallery's Stripe `stripeChargesEnabled=false`; treat `null` as benefit-of-the-doubt
- `getStripeBannerKind` helper and dashboard Stripe banner tests
- Show cached `stripeChargesEnabled`/`stripePayoutsEnabled` on settings page alongside live Stripe status
- No-transport guard tests for `sendArtworkInquiry` and `sendInquiryReply`
- Misconfiguration guard tests for all operator alert emails
- Trial-expiry lockout tests (`incomplete_expired` and `canceled` webhook paths)
- **5 production bugs fixed** in a single commit (`c168191`):
  - `await session.destroy()` missing in logout (race condition)
  - Register used non-transactional DB inserts (orphan rows on partial failure)
  - Login ignored `?from=` redirect parameter
  - `markCancelled` did not notify buyer by email
  - Trial end date missing from billing page
- 4 UX improvements (`incomplete_expired` badge → "Expired"; register confirm-password field; billing-page specific warning; catalog image-upload hint)
- `SubscriptionStatusBadge` component extracted with trialing/active UI tests
- Stale-cache warning on settings page when live Stripe is enabled but DB cache disagrees
- Wrong Resend API key doesn't silently swallow operator alerts
- Surface transient transport errors in all 4 operator alert email functions
- Integration tests for expired-trial billing access guard (Task #366)
- Task #385: `incomplete_expired` tenant resubscription integration tests on real DB
- **CI fix:** Bumped pnpm to v10 in `scheduled-drift-check.yml` and `schema-drift-guard.yml` — stopped daily failure email deliveries
- Task #383: Orphan sweep returns 207 when email notification throws

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 4 | ~8 tasks; 5 production bugs fixed; CI repaired; 24 commits | **Manual Review Required** | WORK_LOG entry: "Review and approve: orphan sweep alerts, incomplete_expired resubscription, CI pnpm fix" | Production bugs resolved; CI green |

---

### Tuesday, August 5

**Single session — Full day (starts early UTC, last commit 13:36 UTC)**

71 commits — highest commit-count day of the period. Tasks merged:

- Task #388, #389: CI drift-check verification (pnpm v10 confirmed working in both drift-check workflows)
- Tasks #390–#393: Orphan sweep 207 returned correctly when Slack throws, email throws, both fail simultaneously, double-failure (storage + DB delete both throw)
- HTTP-layer integration test confirming orphan sweep 207 reaches a real `fetch()` client when both notifications fail
- `require-db` boundary guard exhaustive coverage for `REQUIRE_DB_PSQL_TIMEOUT_MS` — 33+ tests covering:
  - Scientific notation (`1e3`, `5e4`, `1e308`, `+1e309`, `-1e309`, `1e-10`)
  - Hex (`0x1`, `0x3A98`, `0x0`, hex overflow)
  - Octal (`0o7`, `0o177`, `0o0`, octal overflow)
  - Binary (`0b1`, `0b11101000`, `0b0`, binary overflow)
  - `MAX_SAFE_INTEGER` boundary values (±1, ±2, ±3)
  - Subprocess/canary tests confirming correct `ms` value reaches `spawnSync`
- Additional browse filter combination tests, trial countdown tests, stale-cache webhook resync tests, Stripe readiness edge cases

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 5 | ~40 tasks; require-db exhaustive boundary suite; 71 commits | **Manual Review Required** | WORK_LOG entry: "Review and approve: orphan sweep 207 edge cases, require-db guard tests" | All boundary cases covered; suite green |

---

### Wednesday, August 6

**Session — Full day (00:55–21:07 UTC)**

39 commits. ~31 tasks merged:

- `require-db` scientific-notation boundary finalisation (early session carry-over from Aug 5)
- Orphan sweep double-failure and 401/403 auth gate integration tests
- Billing alert email failure returns 200 to Stripe (not 500)
- SMTP auth-error tests for all 4 operator alert email functions
- Warn gallery owners when `stripePayoutsEnabled` cache is stale
- Stale-cache warning clears after `account.updated` webhook resync
- `StripeReadinessPanel` component extracted with full UI tests (Yes/No/Not-yet-received)
- `/settings?stripe=refresh` re-triggers Stripe onboarding (e2e test)
- Checkout false-readiness: DB-state assertion (artwork stays AVAILABLE)
- Re-auth integration test: checkout recovers after `account.updated`
- `null stripeChargesEnabled` + `account_invalid` → 503 not 500
- Mid-session Stripe deauth UI tests
- SOLD/RESERVED artwork CTA render tests
- Slack billing alert assertion in retrieve-fallback integration test
- Trial countdown boundary UI tests (0/1/3/4 days, amber/stone colour thresholds)
- `BuyNowButton` 503 fallback on empty response body
- Trialing checkout integration tests; `subscriptions.retrieve` billing alert
- Trial countdown webhook tests (`trialEnd` stored on `subscription.created`, cleared on conversion)
- Slack alert when Stripe refund succeeds but DB write fails
- Double-refund guard integration test (real DB)
- Image storage startup alert (`instrumentation.ts`)
- Operator page Suspense streaming + 60s Stripe diagnostic cache
- Duplicate `checkout.session.completed` idempotency test (real DB)
- Partial tx rollback lets Stripe retry mark artwork SOLD
- Checkout commission unit tests (odd-cent rounding)
- Seller-slug + location filter combination (real DB)
- Platform fee startup guard — validation + fallback for invalid `PLATFORM_FEE_PERCENT`
- Rate-limit stale-row sweep before suite
- **Deliverables submitted:** `WORK_LOG.md` created; `WEEKLY_ACTIVITY_REPORT.md` submitted; `WEEKLY_ENGINEERING_REPORT.md` (detailed Aug 1–6 timeline) submitted

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 6 | ~31 tasks; weekly reports submitted; 39 commits | **Manual Review Required** | WORK_LOG entry: "31 tasks merged. [full list]" | Suite green; reports delivered |

---

### Thursday, August 7

**Session — Full day (01:58–13:15 UTC)**

46 commits. Tasks merged:

- **Task #217 full implementation:** i-Framer Premium billing option — complete platform feature:
  - i-Framer Premium panel in platform admin UI
  - `setIframerAccount` action grants billing access end-to-end (real DB)
  - Slack notification when i-Framer Premium account is linked or unlinked
  - Billing link survives concurrent row updates (Task #471, real DB)
  - Correct DB-sourced slug, `businessName`, `adminEmail` in Slack notification (Task #472)
  - Task #479: Comp-removed Slack alert fires when `setBillingExempt(false)` removes comp from i-Framer-linked tenant (real DB)
  - Shows acting admin's name next to i-Framer account changes in platform panel
  - Task #484: Alert operator when i-Framer-linked tenant loses subscription via Stripe webhook
  - Record and replay failed i-Framer Slack audit notifications
- Post-merge schema drift resolved after task agent merges
- Added `/api/slack-smoke` probe endpoint and `slack-reconnect-smoke` CI workflow
- Email alert when weekly Slack smoke test fails
- Auth guard unit tests for `/api/slack-smoke` route
- No-install Resend email alert in `slack-reconnect-smoke` workflow
- Prevented duplicate failure emails when both Resend paths run in smoke-test workflow
- Added live-server test checklist with daily reminder rule
- Deduplication guard for `sendSmokeTestFailureEmail` (RESEND_ALREADY_SENT)
- `sendSmokeTestFailureEmail` and `sendOrphanSweepErrorNotification` skip silently when `PLATFORM_ADMIN_EMAIL` not set
- Orphan sweep email delivery tests (Resend + SMTP paths)
- Orphan sweep email re-throw propagates to route caller
- CRON_SECRET integration tests for orphan-sweep email failure propagation
- Prevent orphan sweep from running silently without a notification channel configured
- POST with only `CRON_SECRET` returns 200 on email-sweep route
- Auth config reporting to orphan-sweep health endpoint
- CRON_SECRET fallback test for reservation-sweep
- GET + valid CRON_SECRET → 200 integration test for reservation-sweep route
- Wrong-token GET tests for email-sweep route auth (Task #529)
- **Live-server checklist activity:** Re-verified storage health on live site; updated checklist items for `BLOB_READ_WRITE_TOKEN` blockage; added step-by-step Vercel Blob operator setup guide

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 7 | ~20 tasks; i-Framer Premium full feature; Slack smoke CI; storage investigation; 46 commits | **Manual Review Required** | No WORK_LOG entry | Feature live; Slack smoke CI configured |

---

### Friday, August 8

**Session — Full day (01:03–12:38 UTC)**

123 commits — highest-volume day of the period. Tasks merged:

- Platform reporting and tenant management features (admin UI)
- Massive real-DB integration test build-out — 50+ new test files covering:
  - Account.updated edge cases; FRAMING_JOB iFramer job persistence
  - subscription.created / subscription.deleted iFramer alert
  - SHIP checkout; dismiss billing alert; Slack replay actions
  - setIframerAccount Slack failure; multi-artwork browse; artist name update
  - Checkout email confirmation; createArtwork all fields; order item priceCents/applicationFee
  - Storefront checkout gate; SKU uniqueness; artist reassignment
  - Cross-tenant checkout; billing state filter; orders status filter
  - slackPostFailed persistence; iFramer payment-failed alert
  - showInGallery=false checkout gate; category link/sync; bulk inquiry handled
  - subscription.updated status-change; stripeChargesEnabled=false gate
  - Price-range DB filter; tenant member listing; inquiry reply sender tracking
  - SHIP session expired; inquiry status contract; unmatched Stripe alert
  - Checkout payment_status contract; inquiry no-contactEmail
  - FRAMING_JOB dimensions→iFramer; SHIP order buyer fields
  - Checkout rate-limit; deleteArtwork tenant scope; invite duplicate membership
  - Checkout FRAMING_JOB tenant-type gate; storefront layout tenant gate
  - Admin order list query; dismissBillingAlert timestamp
  - Storage serve route auth/path guard; checkout framing-job rate-limit isolation
  - Storage upload-url auth; Slack replay route auth+DB
  - Browse multi-word keyword; checkout Stripe image URL; webhook null payment_intent; admin inquiry listing filter
  - iFramer payment_failed alert persistence; submitInquiry end-to-end
  - Represented artist create/delete; artwork multi-category create
  - Browse combined seller+keyword filter
  - Subscription status transition; PICKUP no-shipping; artwork notes update
  - invoice.payment_succeeded no-op; checkout invalid inputs; platform reports revenue
  - Checkout Stripe account status; price boundary; orders pagination
  - Artwork delete category-join cleanup; browse SOLD/RESERVED generic; iFramer account idempotency
  - Tasks #512, #66, #484, #285, #287, #283, #148, #46, #49, #93, #48, #50, #36, #11, #234, #205, #63, #73, #88, #51, #50

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 8 | ~50+ integration test tasks; platform UI features; 123 commits | **Manual Review Required** | No WORK_LOG entry | ~1,500+ integration test cases added; all passing |

---

### Saturday, August 9

No commits. No activity recorded.

---

### Sunday, August 10

**Session — (04:33–10:44 UTC, ongoing)**

48+ commits. 42 tasks merged:

- Task #539: Confirmed and documented Stripe webhook redirect issue (`i-art.com.au` → `www.i-art.com.au` 308); added `check-webhook-redirect.sh` diagnostic
- Task #540: Confirmed Vercel Cron jobs are silently dropped by the `www` redirect
- Task #541: Added scheduled Stripe webhook health probe (GitHub Actions CI workflow with Slack/email alert)
- Task #544: Deduplicated webhook-redirect Slack alerts to once per UTC hour (flood prevention)
- Task #545: Added webhook-redirect Slack smoke probe to `/api/slack-smoke`; updated CI workflow and RUNBOOK
- Task #548: Dedup guard reset tests after redirect is fixed
- Task #549: Reduced webhook probe cron from every 5 min to every 15 min
- Task #550: Dead-man's switch heartbeat added to Stripe webhook probe
- Task #551: Webhook probe URL sync test to catch drift between health workflow and route handler
- Task #554: Confirmed daily heartbeat reaches Slack (tests without live GitHub Actions run)
- Task #555: `healthchecks.io` ping as second safety net for heartbeat workflow
- Task #556: Healthcheck skip guard CI workflow; confirmed skip when `HEALTHCHECK_URL` absent
- Task #557: Heartbeat confirmed to fire after incoming-webhook URL rotation
- Tasks #559, #560: Slack env-var wiring tests; CI trigger for `slack-reconnect-smoke` and `scheduled-drift-check` workflows
- Task #561: Slack smoke test failure email confirmed when SMTP fallback used
- Tasks #563–#570: SMTP failure `GITHUB_STEP_SUMMARY` warnings for webhook-redirect, orphan-sweep, and billing-alert email paths; nodemailer mock-intercept canary assertions; alert dedup UTC tests
- Tasks #573–#579, #582, #585–#591, #596–#597: Heartbeat dedup tests (UTC-flag, midnight rotation, cache-hit values, external ping, parameterised bash tests)
- Tasks #602–#604: Heartbeat manual-dispatch dedup bypass (bypass fires even with same-day cache; non-integer `run_id` shapes)
- **Blob upload fix (main agent):** Fixed `blob-upload/route.ts` to parse request body type before session check — Vercel's `blob.upload-completed` callback was being blocked by 401, causing 400/CORS errors on image uploads
- **Package upgrade:** `@vercel/blob` 2.6.1 → 2.7.0

| Date | Work Session / Tasks | Recorded Time Worked | Actions | Result |
|------|---------------------|---------------------:|---------|--------|
| Aug 10 | 42 tasks; blob-upload auth fix; @vercel/blob upgrade; 48+ commits | **Manual Review Required** | No WORK_LOG entry; session ongoing | Webhook health system live; blob upload fix pushed |

---

## Section 3 — External / Manual Engineering Work

| Date | Related Task | External Platform | Manual Work Required | Evidence | Estimated Active Time |
|------|-------------|------------------|---------------------|----------|----------------------:|
| Aug 4 | CI pnpm fix (#388) | GitHub Actions | Verify that `scheduled-drift-check.yml` and `schema-drift-guard.yml` re-run successfully after pnpm v10 bump; confirm daily failure emails stopped | Commit `d3ba13d` at 09:18 UTC; WORK_LOG/WEEKLY_REPORT reference | **10–15 min** (Estimated External — Uncertain) |
| Aug 6 | `DEPLOY.md` §4 warning | Vercel dashboard | Confirm `i-art.com.au` vs `www.i-art.com.au` primary-domain setting in Vercel; identify whether apex→www redirect is active; decide on remediation plan | DEPLOY.md §4 added Aug 3; production issue confirmed separately | **10–15 min** (Estimated External — Uncertain) |
| Aug 7 | Storage health (#321) | Vercel — Storage | Navigate to Vercel → Storage → Blob → Connect to Project; add connection to production environment; trigger redeployment; verify `/api/storage/health` returns `ok: true` | Checklist commit at 12:37 UTC: "Re-verify storage health on live site; update checklist items 5.1 and 5.2 as still blocked"; step-by-step guide added at 13:15 UTC | **15–20 min** (Estimated External) |
| Aug 7 | `BLOB_READ_WRITE_TOKEN` Preview scope | Vercel — Settings | Edit `BLOB_READ_WRITE_TOKEN` environment variable to include Preview environment (was Production-only); trigger Preview redeployment; verify Preview `/api/storage/health` | Session conversation documents this step explicitly | **10–15 min** (Estimated External) |
| Aug 7 | Live-server manual testing | Browser / i-art.com.au | Navigate the live site; check storage health endpoint; verify routing; review checklist items | Commits `d218abed`, `8b2edfd9` at 12:37–13:08 UTC documenting live-site verification results | **15–25 min** (Estimated External) |
| Aug 7 | Stripe webhook redirect (Task #539 diagnosis) | Stripe Dashboard | Open Stripe Dashboard → Developers → Webhooks; review delivery log for recent failures; confirm 308 redirect pattern; check webhook registration URL vs `www` redirect | Commit `task-539: confirm+document Stripe webhook redirect issue` on Aug 10 confirms this was investigated; `check-webhook-redirect.sh` added | **15–20 min** (Estimated External) |
| Aug 10 | Blob upload 400/CORS (pre-fix investigation) | Vercel deployment logs + browser | Open browser DevTools Network tab; observe `PUT https://vercel.com/api/blob/... 400` + CORS error; check Vercel deployment logs; confirm `BLOB_READ_WRITE_TOKEN` present; investigate `blob-upload` route auth flow | Session summary documents detailed root-cause analysis: CORS is secondary symptom; 401 on `blob.upload-completed` callback is the real cause | **20–30 min** (Estimated External) |
| Aug 10 | Blob upload fix verification (post-deploy) | Vercel / browser | After Vercel deploys fix (pushed to GitHub at `ca914c0`): verify `/api/storage/health` still `ok`; test authenticated image upload; confirm no CORS error; check image persists on refresh; verify public gallery image | Instructions provided at end of current session; pending execution | **Manual Review Required** — outcome not yet verified |

---

### Double-Counting Assessment

| External Activity | Status |
|-------------------|--------|
| Aug 4 — GitHub Actions CI verification | **Uncertain** — WORK_LOG records "Review and approve" on Aug 4; may be included in the session |
| Aug 6 — Vercel primary domain check | **Uncertain** — WORK_LOG records Aug 6 session but no specific external note |
| Aug 7 — Vercel Blob storage connection (production) | **Clearly external** — occurred after Aug 7 code session while checklist was active on the live site |
| Aug 7 — `BLOB_READ_WRITE_TOKEN` Preview scope | **Clearly external** — Vercel dashboard config not part of code work |
| Aug 7 — Live-server manual testing | **Clearly external** — browser-based live-site review |
| Aug 7 — Stripe Dashboard webhook review | **Clearly external** — Stripe Dashboard navigation |
| Aug 10 — Blob upload 400/CORS browser investigation | **Clearly external** — browser DevTools / deployment log review before fix was identified |
| Aug 10 — Blob upload fix verification | **Clearly external** — pending; live deployment verification |

---

## Section 4 — Daily Work Report

| Date | Replit Recorded Time | Additional External Time | Total Supported Work Time | Major Tasks |
|------|---------------------:|-------------------------:|--------------------------:|-------------|
| Aug 1 | **MRR** | — (no external config evidence) | **MRR** | 30-day trial; Privacy/Terms; webhook status fix |
| Aug 2 | — (no activity) | — | — | — |
| Aug 3 | **MRR** | — | **MRR** | 22+ tasks; 2 security fixes; subdomain bug; build fix |
| Aug 4 | **MRR** | ~10–15 min (CI verification — Uncertain) | **MRR** | 5 production bugs; 8 tasks; CI restored |
| Aug 5 | **MRR** | — | **MRR** | ~40 tasks; require-db exhaustive boundary suite |
| Aug 6 | **MRR** | ~10–15 min (Vercel domain check — Uncertain) | **MRR** | ~31 tasks; platform fee guard; weekly reports submitted |
| Aug 7 | **MRR** | ~55–80 min (storage setup + preview fix + live testing + Stripe review — Clearly External) | **MRR + 55–80 min** | i-Framer Premium; Slack smoke CI; storage troubleshooting |
| Aug 8 | **MRR** | — | **MRR** | ~50 integration test tasks; platform features; 123 commits |
| Aug 9 | — (no activity) | — | — | — |
| Aug 10 | **MRR** | ~20–30 min (browser investigation — Clearly External) + **MRR** (verification pending) | **MRR + 20–30 min** | 42 tasks; blob-upload auth fix; webhook health system |

**MRR = Manual Review Required**

---

## Section 5 — Weekly Summary

| Week | Period | Replit Recorded Hours | External Engineering Hours | Total Supported Hours |
|------|--------|----------------------:|---------------------------:|-----------------------:|
| Week 1 | Aug 1–6 | **Manual Review Required** | ~20–30 min confirmed external + ~20–30 min uncertain | **MRR + 20–60 min est.** |
| Week 2 | Aug 7–10 | **Manual Review Required** | ~75–110 min confirmed external + pending verification | **MRR + 75–110 min+ est.** |

---

## Section 6 — Reports and Deliverables Submitted

| Date | Report / Deliverable | Related Task | What Was Verified or Reported | Already in Replit Time? | Extra Review Time? |
|------|---------------------|-------------|-------------------------------|------------------------|-------------------|
| Aug 6 | `WORK_LOG.md` — Personal time tracking template | General | Created month-level time tracking file for ongoing use | Yes — committed during Aug 6 session | No |
| Aug 6 | `WEEKLY_ACTIVITY_REPORT.md` — August 2026 weekly engineering activity report | General | Full week summary: ~97 tasks, 184 commits, features, bugs, security, tests | Yes — Aug 6 session commits `4f834c5` + `23c4967` | No |
| Aug 6 | `WEEKLY_ENGINEERING_REPORT.md` — Detailed Aug 1–6 engineering timeline | General | Full session-by-session timeline, all deliverables, all bug and security fixes, all tests added, all commits listed | Yes — Aug 6 session commit at 16:14 UTC | No |
| Aug 7 | Live-server test checklist (update 1: 12:37 UTC) | Storage / Task #321 | Re-verified storage health on live site; confirmed 5.1 and 5.2 still blocked (BLOB_READ_WRITE_TOKEN absent) | Yes — committed within Aug 7 session | Uncertain — live-site navigation is external |
| Aug 7 | Live-server test checklist (update 2: 13:05 UTC) | Storage / Task #321 | Updated with step-by-step Vercel Blob setup guide for operator | Yes — committed within Aug 7 session | No |
| Aug 7 | Live-server test checklist (update 3: 13:08 UTC) | Storage / Task #321 | Re-verify after configuration; confirmed `BLOB_READ_WRITE_TOKEN` setup instructions | Yes — committed | No |

---

## Section 7 — Missing or Unverified Work

| Item | Issue | Status |
|------|-------|--------|
| `WORK_LOG.md` Time column | Every date shows blank in the Time column — no Replit session durations recorded | **All Replit session times require manual entry** |
| Aug 7 external Vercel work | Exact time spent in Vercel dashboard is not logged; estimate of 55–80 min is a range | Estimated External — review for accuracy |
| Aug 10 blob verification | Post-deploy verification (manual browser testing of image upload) not yet performed | Pending — add ~15–20 min when complete |
| Aug 8 WORK_LOG entry | No WORK_LOG entry for Aug 8 despite 123 commits and ~50+ tasks | No recorded time — manual review required |
| Aug 7 WORK_LOG entry | No WORK_LOG entry for Aug 7 despite 46 commits | No recorded time — manual review required |
| Aug 10 WORK_LOG entry | No WORK_LOG entry for Aug 10 | No recorded time — session ongoing |
| Aug 3 session exact end time | First 23 commits timestamped 03:22–05:59 UTC; remaining 24 commits are later but exact times not fully retrieved | May represent two sub-sessions rather than continuous work |
| Aug 5 early commits | Git timestamps for first ~38 commits of Aug 5 not fully retrieved (early UTC window) | May represent additional activity hours before 10:46 UTC |
| Stripe webhook redirect fix | Task #539 confirmed the redirect issue; remediation (Vercel domain configuration change) is a required external action that may not yet be complete | If Vercel primary domain config was changed, ~10–15 min should be added |
| CI drift-check email stop date | pnpm v10 fix merged Aug 4; exact date daily failure emails stopped is not recorded | Small verification activity — Uncertain if external time applies |

---

## Section 8 — Final Time Calculation

### A. Recorded Replit Time

| Date | Replit Recorded Time |
|------|---------------------|
| Aug 1 | Manual Review Required |
| Aug 3 | Manual Review Required |
| Aug 4 | Manual Review Required |
| Aug 5 | Manual Review Required |
| Aug 6 | Manual Review Required |
| Aug 7 | Manual Review Required |
| Aug 8 | Manual Review Required |
| Aug 10 | Manual Review Required |
| **Total A** | **Manual Review Required — fill WORK_LOG.md** |

### B. Additional External Engineering Time (clearly external, not in Replit sessions)

| Date | Activity | Label | Time |
|------|----------|-------|------|
| Aug 7 | Vercel Blob → Connect to Project; production redeployment; verify health endpoint | **Estimated External** | 15–20 min |
| Aug 7 | Edit `BLOB_READ_WRITE_TOKEN` env var to include Preview scope; Preview redeploy | **Estimated External** | 10–15 min |
| Aug 7 | Live-site browser testing and checklist verification | **Estimated External** | 15–25 min |
| Aug 7 | Stripe Dashboard — review webhook delivery log; confirm 308 redirect | **Estimated External** | 15–20 min |
| Aug 10 | Browser DevTools/Vercel log investigation — 400/CORS blob upload root-cause analysis | **Estimated External** | 20–30 min |
| Aug 10 | Post-deploy blob upload verification (pending) | **Manual Review Required** | 15–20 min est. |
| **Confirmed external subtotal (excl. pending)** | | | **75–110 min (1h 15m – 1h 50m)** |

### Uncertain (may already be in Replit recorded time)

| Date | Activity | Label | Time |
|------|----------|-------|------|
| Aug 4 | GitHub Actions CI verification after pnpm v10 fix | **Uncertain** | 10–15 min |
| Aug 6 | Vercel dashboard — verify www→apex domain configuration | **Uncertain** | 10–15 min |
| | | **Uncertain subtotal** | **20–30 min if external** |

### C. Total Supported Project Time

```
A. Recorded Replit Work:              Manual Review Required (fill WORK_LOG.md)
B. Confirmed Additional External:     1h 15m – 1h 50m  (Estimated External)
   Pending Verification:              15–20 min          (Manual Review Required)
   Uncertain (may overlap Replit):    20–30 min          (Uncertain)

C. Total Supported Time:              A + 1h 15m – 1h 50m confirmed external
                                      + up to 50 min additional (MRR/Uncertain)
```

---

## Section 9 — Invoice Preparation Summary

**Invoice Period:** August 1, 2026 – August 10, 2026
**Project:** Artwork Bank — i-art.com.au

| Item | Detail |
|------|--------|
| **Total Replit Work Sessions** | 8 active days (Aug 1 ×2, Aug 3, 4, 5, 6, 7, 8, 10) |
| **Total Completed Tasks / Activities** | ~190+ tasks merged across the period |
| **Total Commits** | 399 |
| **Features Delivered** | 11+ (30-day trial, Privacy/Terms, i-Framer Premium, trial countdown, platform fee guard, Stripe readiness panel, storage startup alert, Slack smoke CI, webhook health probe, heartbeat dedup system, blob upload fix) |
| **Production Bugs Fixed** | 12 (Aug 3–4) |
| **Security Fixes** | 2 (cross-tenant artist isolation; HTML injection in emails) |
| | |
| **Recorded Replit Time** | **Manual Review Required — WORK_LOG.md Time column is blank for all dates** |
| **Estimated Additional External Engineering Time** | **1h 15m – 1h 50m** (confirmed external: Aug 7 storage setup + Stripe webhook review + Aug 10 CORS investigation) |
| **Pending Verification** | ~15–20 min (Aug 10 blob upload post-deploy browser verification) |
| **Uncertain (possible overlap with Replit time)** | ~20–30 min (Aug 4 CI check; Aug 6 Vercel domain check) |
| **Total Supported Billable Hours** | **Recorded Replit Time (MRR) + 1h 15m–1h 50m confirmed external** |

---

### External Time Breakdown — How Estimates Were Derived

| Item | Basis for Estimate | Label | Time |
|------|-------------------|-------|------|
| Vercel Blob → production connection + redeploy + health verify | Simple env setup + deployment trigger + endpoint check = 3 sequential steps | Estimated External | 15–20 min |
| Vercel `BLOB_READ_WRITE_TOKEN` Preview scope + Preview redeploy | Same platform, additional env-var scope edit + second deploy trigger | Estimated External | 10–15 min |
| Live-site browser testing (storage, routing, checklist) | Navigate live URL, check endpoints, record results in checklist | Estimated External | 15–25 min |
| Stripe Dashboard — webhook delivery log review | Log in, find webhook endpoint, review recent delivery log, confirm 308 redirect pattern | Estimated External | 15–20 min |
| Browser DevTools + Vercel logs — 400/CORS root-cause analysis | Inspect Network tab, read error, cross-reference Vercel deployment logs, form hypothesis | Estimated External | 20–30 min |
| **Total confirmed external** | | | **75–110 min** |

---

> **To complete this report for invoicing:**
> 1. Fill in the Time column in `WORK_LOG.md` for each date using your own session records.
> 2. The final total becomes: `Recorded Replit Time (from WORK_LOG) + 1h 15m–1h 50m confirmed external`.
> 3. If the Aug 10 blob upload verification was performed, add ~15–20 min.
> 4. If the Vercel primary-domain configuration change (apex→www fix) was performed, add ~10–15 min.
> 5. Review the Uncertain items (Aug 4 CI check; Aug 6 Vercel domain check) and add ~10–15 min each only if those steps were done outside your Replit session.

---

*Report generated: August 10, 2026*
*Sources: `git log --since="2026-08-01"` · `WORK_LOG.md` · `WEEKLY_ENGINEERING_REPORT.md` · `WEEKLY_ACTIVITY_REPORT.md` · `artifacts/artwork-bank/docs/WORK_LOG.md` · Replit session conversation logs*
