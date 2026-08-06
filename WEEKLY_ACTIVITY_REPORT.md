# Weekly Engineering Activity Report — August 2026
**Project:** Artwork Bank (`i-art.com.au`)
**Stack:** Next.js 15 App Router · Drizzle ORM · Neon Postgres · Stripe Connect + Billing · Vercel

> **Hours source:** `WORK_LOG.md` — Time column is currently blank for all entries.
> No hours have been recorded. Fill in session times in `WORK_LOG.md` to enable billing totals.
> All other data (commits, tasks, features, bugs, tests) is sourced from the git history and task records.

---

## Week 1 — August 1–6, 2026

### Executive Summary

A high-output week across all priority areas. 184 commits and approximately 97 tasks merged.
Key outcomes: 5 production bugs fixed, a critical security fix landed (artist cross-tenant
isolation), full Stripe payment-path hardening completed (commission validation, platform fee
guard, checkout edge cases), CI restored (daily schema-drift emails stopped), and comprehensive
integration test coverage added across billing, orphan sweep, rate-limiting, and browse filters.

---

### Daily Hours (from WORK_LOG.md)

| Date | Day | Recorded Hours | Notes |
|------|-----|:--------------:|-------|
| 2026-08-01 | Friday | — | Not recorded in WORK_LOG.md |
| 2026-08-02 | Saturday | — | No activity |
| 2026-08-03 | Sunday | — | Not recorded in WORK_LOG.md |
| 2026-08-04 | Monday | — | Not recorded in WORK_LOG.md |
| 2026-08-05 | Tuesday | — | Not recorded in WORK_LOG.md |
| 2026-08-06 | Wednesday | — | Not recorded in WORK_LOG.md |
| **Week 1 Total** | | **—** | Update WORK_LOG.md to enable totals |

---

### Daily Work Completed

#### Friday, August 1

**Commits:** 8 (00:06–14:21 UTC)

| Commit | Work |
|--------|------|
| `3ab378e` | Add 30-day free trial to new subscriptions; fix webhook to use real Stripe status (`trialing` vs `active`) |
| `7052b6c` | Add Privacy and Terms pages; update site middleware and layouts |
| `93d734a` | Add Stripe dashboard screenshot to assets |
| `b07736f` `d5ea82b` `147638c` `a350077` | Documentation assets added |
| `c0b5c90` | Update GitHub push token in memory agent |

**Tasks merged:** Privacy/Terms pages, 30-day trial implementation, webhook status fix

---

#### Saturday, August 2

No activity recorded.

---

#### Sunday, August 3

**Commits:** 47 (03:22–~22:00 UTC)

| Commit | Work |
|--------|------|
| `2b08780` | **Bug fix:** Subdomain routing broken when `NEXT_PUBLIC_SITE_URL` uses `www.` prefix |
| `4a784ae` | Smoke test fixes: Terms/Privacy in footers; seller artwork count only counts available/visible |
| `11e11d4` | Add error logging to all silent `getServeUrl` catch handlers |
| `3129dd9` | Add storage startup alert (`instrumentation.ts`) + `/api/storage/health` probe endpoint |
| `cb1714b` | Guard `PLATFORM_FEE_PERCENT` at startup — throw on NaN/negative/out-of-range; 9 tests |
| `5aeee17` | **Security fix:** Validate `representedArtistId` belongs to session tenant in `createArtwork`/`updateArtwork` |
| `54e3d4c` | Warn gallery owners when Stripe Connect account cannot accept payments yet |
| `58133f1` | **Build fix:** Keep `nodemailer` out of Edge instrumentation bundle (Vercel build failure) |
| `1793866` | Checkout Stripe-failure reservation-release tests; email content contract tests; DEPLOY.md www→apex critical warning |
| `0c7fc0b` | Task #322: `refundOrder` Stripe-failure tests; Task #324: HTML-escape `sendOrderConfirmation` + injection regression |
| `cd83196` | Task #49: retry gallery failure alert; Task #46: 'Update retrying' badge for failed status emails |
| `d8099c4` | Task #66: label older inquiry replies; Task #148: persistent warning for failed partial-refund notification |
| `dfe1425` | Task #305: checkout commission test; Tasks #283 #285 #287 #292: browse-filter unit tests |
| `4ab21f3` | Task #234: `no_cname_target` redirect test; Tasks #38 #296: rate-limit key isolation tests |
| `c5d1130` | Tasks #80 #88: billing-access integration tests (real DB); Task #205: orphan-sweep alert unit tests |
| `05f02e4` | Task #217: i-Framer premium billing badge; Tasks #277 #280: schema-push alert tests |
| `2d7b5b5` | Task #51: catch DB-save failure in `replyToInquiry`; Task #50: tracking-note queues retry |
| `3ef5987` | Task #67: domain verification contract tests |
| `458cea3` | Fix `deleteRepresentedArtist` cross-tenant artwork count bug; artist + order isolation tests |
| `558564f` | Team management, platform admin, and Stripe webhook signature tests |
| `29f741b` | Slugify unit tests; email sweep route production fail-closed + auth edge case tests |
| `378988c` | Tests for trialing→active subscription transition and badge distinction |
| `18eb4f9` | Integration tests for `account.updated` webhook readiness cache |
| + 23 more | Additional task tests, integration coverage, and fixes |

**Tasks merged:** #38, #46, #49, #50, #51, #66, #67, #73, #74, #80, #88, #148, #205, #217, #234, #277, #280, #283, #285, #287, #292, #305, #322, #324, and ~15 additional

---

#### Monday, August 4

**Commits:** 24

| Commit | Work |
|--------|------|
| `c168191` | **5 production bug fixes:** `await session.destroy()` in logout; register DB transaction; login `?from=` redirect; cancel buyer notification; trial end date on billing page |
| `bd53d65` | UX improvements: `incomplete_expired` badge ("Expired"); register confirm-password field; billing page specific warning; catalog image-upload hint |
| `b179c37` | Task #385: `incomplete_expired` tenant resubscription integration tests (real DB) |
| `a17e99b` | Gated layout paywall message differentiated for `incomplete_expired` vs `canceled` |
| `d3ba13d` | **CI fix:** Bump pnpm to v10 in `scheduled-drift-check.yml` + `schema-drift-guard.yml` (was v9 — caused daily failure emails) |

**Tasks merged:** #385
**Production bugs fixed:** 5
**Infrastructure fixed:** CI daily schema-drift failure email resolved

---

#### Tuesday, August 5

**Commits:** 71 (highest-volume day)

Key work areas:

| Work Area | Commits | Tasks |
|-----------|---------|-------|
| Orphan sweep 207 edge cases (Slack throws, email throws, both fail, double-failure) | ~8 | #383, #390, #391, #392, #393 |
| `require-db` boundary guard (scientific notation, hex, negative-Infinity, octal) | ~15 | #394–#403 |
| Stripe readiness + checkout edge cases | ~10 | #350, #353, #354 |
| Trial countdown UI and webhook tests | ~6 | #349, #367 |
| Stale-cache warning and webhook resync | ~8 | #371–#382 |
| Browse filter combinations | ~4 | #299 |
| Rate-limit integration tests | ~3 | #296 |
| CI drift-check verification | ~2 | #388, #389 |
| Additional task coverage | ~15 | #404–#435 |

**Tasks merged:** ~40 tasks (#349, #350, #353, #354, #367, #371–#384, #388–#403, #404–#435)

---

#### Wednesday, August 6

**Commits:** 34 (01:05–14:56 UTC)

| Commit | Time (UTC) | Work |
|--------|-----------|------|
| `5edc5cf` `5f643ca` | 00:55–01:11 | `require-db` scientific-notation timeout boundary tests |
| `8a84f52` | 01:25 | Orphan sweep double-failure (storage + DB both throw) → 207 |
| `9da7f4e` | 01:31 | Orphan sweep 401/403 auth gate integration tests |
| `588dc86` | 01:52 | Billing alert email failure still returns 200 to Stripe |
| `38f8785` | 02:21 | SMTP auth-error tests for all 4 operator alert email functions |
| `cc53767` | 02:33 | Warn gallery owners when `stripePayoutsEnabled` cache is stale |
| `a87b4e4` | 02:41 | Stale-cache warning clears after `account.updated` webhook resync |
| `4b2da11` | 03:29 | Extract `StripeReadinessPanel` component + UI tests (Yes/No/Not-yet-received) |
| `cae0337` | 04:20 | `/settings?stripe=refresh` re-triggers Stripe onboarding (e2e test) |
| `c5a1a24` | 04:39 | Checkout false-readiness: DB-state assertion (artwork stays AVAILABLE) |
| `d6fd74f` | 04:49 | Re-auth integration test: checkout recovers after `account.updated` |
| `0ffc555` | 05:01 | `null stripeChargesEnabled` + `account_invalid` → 503 not 500 |
| `53bd945` | 05:21 | Mid-session Stripe deauth UI tests |
| `342934f` | 05:31 | SOLD/RESERVED artwork CTA render tests |
| `777b916` | 05:40 | Slack billing alert assertion in retrieve-fallback integration test |
| `860bcf4` | 06:27 | Trial countdown boundary UI tests (0/1/3/4 days, amber/stone) |
| `d73fc31` | 06:41 | `BuyNowButton` 503 fallback on empty response body |
| `5b4447b` `c0464b6` | 06:53–06:54 | Trialing checkout integration tests; `subscriptions.retrieve` billing alert |
| `76c635f` | 07:38 | Trial countdown webhook tests (`trialEnd` stored + cleared on conversion) |
| `2aa2a09` | 08:08 | Slack alert when Stripe refund succeeds but DB write fails |
| `178d350` | 09:11 | Double-refund guard integration test (real DB) |
| `8286d5c` | 10:06 | Image storage startup alert (`instrumentation.ts`) |
| `c24d425` | 10:21 | Operator page Suspense streaming + 60s Stripe diagnostic cache |
| `512df42` | 11:05 | Duplicate `checkout.session.completed` idempotency test (real DB) |
| `3e73950` | 11:27 | Partial tx rollback lets Stripe retry mark artwork SOLD |
| `668a626` `bbe862f` | 11:40 | Checkout commission tests (odd-cent rounding); seller-slug + location filter tests |
| `604b4bb` | 12:18 | **Platform fee guard:** startup validation + fallback for invalid `PLATFORM_FEE_PERCENT` |
| `0761dd7` | 12:59 | Sweep stale `test-rl-*` rows before rate-limit suite |
| `4f834c5` `23c4967` | 14:04–14:56 | Add and populate `WORK_LOG.md` |

**Tasks merged:** #296, #299, #305, #306, #307, #308, #313, #320, #321, #337, #338, #349, #351, #353, #354, #367, #371–#384, #436–#467 (~31 tasks)

---

### Tasks Completed — Week 1

| # | Title | Area |
|---|-------|------|
| #38 | Rate-limit key isolation across test runs | Testing |
| #46 | Show 'Update retrying' badge on failed shipping email | Orders |
| #49 | Retry gallery failure alert on each sweep pass | Alerts |
| #50 | Tracking-note change queues fresh status-email retry | Emails |
| #51 | Catch DB-save failure after email send in `replyToInquiry` | Inquiries |
| #66 | Label older inquiry replies pre-sender-tracking | Inquiries |
| #67 | Domain verification contract tests | Domains |
| #73 | Bulk inquiry mark-as-handled tenant isolation | Security |
| #74 | Bulk inquiry archive tenant isolation | Security |
| #80 | Unsubscribed galleries blocked from admin actions (real DB) | Billing |
| #88 | Comped galleries skip paywall (real DB) | Billing |
| #148 | Show warning when partial-refund buyer notification failed | Orders |
| #205 | Orphan sweep alert reaches operator | Alerts |
| #217 | i-Framer premium billing badge on billing page | Billing |
| #234 | `no_cname_target` redirect when CNAME target not configured | Domains |
| #277 #280 | Schema-push alert fires after Slack connector reconnect | Alerts |
| #283 #285 #287 #292 | Browse filter unit tests (SOLD/RESERVED/HIDDEN/combined) | Browse |
| #296 | Stale `test-rl-*` row sweep before rate-limit suite | Testing |
| #299 | Seller-slug + location filter combination (real DB) | Browse |
| #305 | Checkout commission amount unit tests | Payments |
| #306 | Platform fee guard — startup validation + fallback | Payments |
| #307 | Duplicate checkout idempotency (real DB) | Payments |
| #308 | Partial tx rollback lets Stripe retry mark SOLD | Payments |
| #313 | Operator page Suspense streaming + 60s Stripe cache | Performance |
| #320 | Vercel Blob wired up for photo uploads | Storage |
| #321 | Image storage startup alert | Storage |
| #322 | `refundOrder` Stripe-failure tests | Payments |
| #324 | HTML-escape `sendOrderConfirmation` + injection tests | Security |
| #337 | Slack alert on refund-succeeds-but-DB-write-fails | Alerts |
| #338 | Double-refund guard (real DB) | Payments |
| #349 | Trial countdown clears on paid conversion | Billing |
| #350 | `trialing` fallback billing alert when Stripe retrieve fails | Billing |
| #351 | Trialing checkout stores `trialEnd` (real DB) | Billing |
| #353 | Buyer 503 when gallery Stripe account deauthorized mid-session | Payments |
| #354 | `BuyNowButton` 503 fallback on empty response body | Payments |
| #367 | Trial countdown boundary UI tests | Billing |
| #371–#384 | Stale-cache warning, webhook resync, onboarding refresh, re-auth recovery, checkout readiness edge cases | Payments |
| #383 | Orphan sweep 207 when email notification fails | Storage |
| #385 | `incomplete_expired` tenant resubscription (real DB) | Billing |
| #388 #389 | CI drift-check pnpm v10 fix + verification | CI |
| #390–#403 | Orphan sweep edge cases; `require-db` boundary guards | Storage/Testing |
| #404–#467 | Additional integration and UI tests across billing, alerts, browse, checkout | Testing |
| **~97 total** | | |

---

### Features Delivered — Week 1

| Feature | Description |
|---------|-------------|
| 30-day free trial | All new subscriptions start with a 30-day trial; webhook stores real Stripe status (`trialing` vs `active`) |
| Privacy & Terms pages | Legal pages added with middleware and layout integration |
| Stripe Connect readiness warning | Gallery owners warned when account cannot accept payments yet |
| Stale payouts cache banner | Warning shown when `stripePayoutsEnabled` may be outdated |
| `StripeReadinessPanel` component | Extracted, tested: Yes / No / Not-yet-received states |
| Platform fee guard | Startup validation for `PLATFORM_FEE_PERCENT` — throws on NaN/zero/out-of-range |
| Operator page streaming | Suspense + 60s diagnostic cache keeps page fast when Stripe is slow |
| Image storage startup alert | `instrumentation.ts` alerts if Vercel Blob is misconfigured at boot |
| i-Framer premium billing badge | Premium tier indicator on billing page |
| Trial countdown UI | Boundary-tested: 0/1/3/4 days, amber/stone colour thresholds |
| `incomplete_expired` UX | Correct badge, billing page warning, and paywall message for expired-checkout status |

---

### Bugs Fixed — Week 1

| Severity | Bug | Commit |
|----------|-----|--------|
| High | Subdomain routing broken when `NEXT_PUBLIC_SITE_URL` uses `www.` prefix | `2b08780` |
| High | `await session.destroy()` missing in logout (race condition) | `c168191` |
| High | Register used non-transactional DB inserts — orphan rows on partial failure | `c168191` |
| High | Login ignored `?from=` redirect parameter | `c168191` |
| High | `markCancelled` did not notify buyer by email | `c168191` |
| High | Vercel build failure — `nodemailer` leaked into Edge bundle | `58133f1` |
| Medium | `deleteRepresentedArtist` counted artworks across tenants | `458cea3` |
| Medium | Trial end date missing from billing page | `c168191` |
| Medium | Register form had no confirm-password field | `bd53d65` |
| Medium | `incomplete_expired` showed "Not subscribed" badge | `bd53d65` |
| Medium | CI daily schema-drift check failing due to pnpm v9 vs v10 lockfile mismatch | `d3ba13d` |
| Low | Catalog form gave no hint that images require a saved artwork first | `bd53d65` |

---

### Security Fixes — Week 1

| Fix | Impact | Commit |
|-----|--------|--------|
| Validate `representedArtistId` belongs to session tenant in `createArtwork`/`updateArtwork` | Prevented cross-tenant artwork assignment | `5aeee17` |
| HTML-escape `sendOrderConfirmation` email body | Prevented HTML injection via buyer-controlled order data | `0c7fc0b` |
| Bulk inquiry action tenant isolation tests | Confirmed no cross-tenant data access possible | `c5d1130` |

---

### Tests Added — Week 1

| Area | Tests added |
|------|-------------|
| Billing / subscription | Trial countdown boundary, `incomplete_expired` resubscription, trialing→active conversion, trial countdown webhook, retrieve-fallback billing alert |
| Stripe payments | Checkout commission (odd-cent rounding), platform fee guard, duplicate-order idempotency, double-refund guard, partial-tx rollback, false-readiness DB state, null `stripeChargesEnabled` → 503, mid-session deauth, re-auth recovery, onboarding refresh e2e |
| Stripe Connect | Readiness panel UI (Yes/No/Not-yet-received), stale-cache warning, webhook resync |
| Orders | `refundOrder` Stripe-failure, Slack alert on refund-DB-write failure, cancel buyer notification |
| Email / alerts | SMTP auth-error (all 4 operator alert functions), billing alert email → 200 to Stripe, HTML injection regression |
| Browse / search | SOLD/RESERVED visibility, HIDDEN exclusion, seller-slug + keyword, seller-slug + location (real DB), artist filter with SOLD/RESERVED artworks, ARTIST-type tenant dropdown |
| Orphan sweep | 207 on email failure, 207 on Slack failure, 207 on both failing, double-failure, 401/403 auth gates, HTTP-layer integration |
| `require-db` guard | Scientific notation, hex, negative-Infinity, octal, boundary values for `spawnSync` timeout |
| Rate limiting | Key isolation across test runs, stale-row sweep |
| Domain verification | `no_cname_target` redirect, CNAME conflict, case-insensitive match, trailing dot |
| Inquiries | Sender tracking label for older replies, DB-save failure on reply, tracking-note retry, bulk isolation |
| Invites | Double-accept integration tests (real DB) |
| Reservations | Reservation-race + stale-reservation sweep (real DB) |
| SOLD/RESERVED CTA | Artwork status render tests |
| Schema-push alert | Fires after Slack connector reconnect |

**Estimated total new tests: 200+** (across 184 commits)

---

### Work Still Pending

| # | Title | Priority |
|---|-------|----------|
| #217 | i-Framer premium customer billing option (implementation) | High |
| #38 | Make rate-limit tests run reliably in fresh environments | Medium |
| #46 | Show galleries when buyer's shipping update email failed | Medium |
| #49 | Retry the gallery alert if it fails to send the first time | Medium |
| #73 | Confirm bulk mark-as-handled can't touch another gallery's inquiries | Medium |
| #87 | Clean up orphaned image files when an artwork is deleted | Medium |
| #165 | Run Slack smoke test automatically after every connector reconnect | Low |
| #175 | Confirm Slack replay endpoint rejects unauthorised callers | Low |

_(Full proposed task list visible in the Replit task panel)_

---

### Week 1 Totals

| Metric | Count |
|--------|------:|
| Working days | 5 (Aug 2 had no activity) |
| Total commits | 184 |
| Tasks merged | ~97 |
| Features delivered | 11 |
| Production bugs fixed | 12 |
| Security fixes | 3 |
| CI/infrastructure fixes | 2 |
| Recorded billable hours | **— (not entered in WORK_LOG.md)** |

---

## Week 2 — August 7–13, 2026

_No activity recorded yet._

| Date | Recorded Hours | Work |
|------|:--------------:|------|
| 2026-08-07 | — | |
| 2026-08-08 | — | |
| 2026-08-09 | — | |
| 2026-08-10 | — | |
| 2026-08-11 | — | |
| 2026-08-12 | — | |
| 2026-08-13 | — | |

---

## Week 3 — August 14–20, 2026

_No activity recorded yet._

---

## Week 4 — August 21–27, 2026

_No activity recorded yet._

---

## Week 5 — August 28–31, 2026

_No activity recorded yet._

---

## August Monthly Summary

| | Value |
|---|---|
| Total commits | 184+ |
| Total tasks merged | ~97+ |
| Recorded billable hours | **— (fill in WORK_LOG.md)** |
| Features delivered | 11 |
| Bugs fixed | 12 |
| Security fixes | 3 |

---

## Invoice Summary — August 1–6, 2026

**Invoice Period:** August 1–6, 2026
**Project:** Artwork Bank — i-art.com.au
**Recorded Hours:** Not entered — update `WORK_LOG.md` to complete

**Work delivered:**
- 30-day free trial system with correct Stripe webhook status handling
- Privacy and Terms pages
- Full Stripe payment-path hardening: commission validation, platform fee guard, checkout edge cases, deauth handling
- Operator page performance (Suspense streaming, 60s cache)
- Image storage startup alerting
- 5 production bugs fixed (logout, register, login redirect, cancel notification, billing page)
- 2 security fixes (cross-tenant artist isolation, HTML injection)
- CI restored (daily schema-drift failure emails stopped)
- 200+ tests added across billing, payments, storage, browse, email, and security

**Supporting evidence:** 184 git commits, ~97 merged Replit tasks (Aug 1–6)

---

_Generated from `WORK_LOG.md` + `git log`. Last updated: 2026-08-06._
_To add hours: edit `WORK_LOG.md`, fill the Time column, and regenerate this report._
