# Artwork Bank / i-Art — Engineering Work History

**Coverage:** 1–20 August 2026
**Prepared:** 20 August 2026
**Project:** Artwork Bank / i-art.com.au
**Stack:** Next.js 15 · Drizzle ORM · PostgreSQL/Neon · Stripe Connect and Billing · Vercel Blob · GitHub Actions

## Purpose and evidence standard

This is an evidence-based engineering history, intended to support later review of
work scope and to provide a reliable source for weekly or monthly reports. It
groups related commits into engineering activities rather than treating every
commit as a separately completed task.

**It is not a record of human hours.** Git timestamps, task merges, automated
tests, agent activity, deployments, and prompt activity do not establish how long
a person worked. `WORK_LOG.md` has no recorded durations for August, so no
billable-hours total is calculated here.

### Evidence reviewed

- Git history for the August review period, including feature, fix, task-merge,
  test, documentation, and report commits.
- Existing work history: `artwork-bank-work-history-aug2026.md` and
  `artifacts/artwork-bank/public/work-history-aug2026.md`.
- Earlier reports: `WEEKLY_ACTIVITY_REPORT.md` and the previous
  `WEEKLY_ENGINEERING_REPORT.md`.
- Project and engineering logs: `WORK_LOG.md` and
  `artifacts/artwork-bank/docs/WORK_LOG.md`.
- Operational records: `LIVE_SERVER_TEST_CHECKLIST.md`, `GO-LIVE.md`, deployment
  notes, documented browser investigation, and production smoke-test results.
- Current task, merge, build, typecheck, lint, integration-test, and
  schema-drift evidence.

**Evidence limitations:** exact Replit session duration, Vercel dashboard
duration, Stripe dashboard duration, deployment wait time, and personal review
time are not available from the project record. They are deliberately not
reconstructed in this document.

---

## Executive summary

August 1–20 contained sustained work across payment readiness, storage uploads,
operational reliability, multi-tenant access control, inquiry-email recovery, and
large automated test expansions.

Major completed themes:

- Subscription trials, Stripe readiness, refund safeguards, payment-status
  handling, and i-Framer Premium billing support.
- Image-storage production hardening, including Vercel Blob configuration,
  private serving, streamed upload size/deadline protection, and gallery logos.
- Multi-tenant security and tenant-scoped data access across artwork, inquiry,
  image, staff, billing, and bulk-action paths.
- Resilient operational behaviour for Slack alerts, billing alerts, email sweeps,
  webhook probes, Cron compatibility, CI health checks, and retry/replay paths.
- Broad unit, browser/UI, HTTP-layer, real-database integration, build, and
  production smoke coverage.

The latest recorded production smoke test confirmed that the Create Artwork flow
loaded, created an artwork, uploaded an image, persisted it after reload,
prevented cross-tenant visibility, and allowed cleanup of the test artwork.

---

## Chronological engineering history

### Saturday, 1 August

**Git activity:** 8 commits
**Representative commits:** `7052b6c`, `3ab378e`

- Added Privacy and Terms pages with middleware and layout integration.
- Added supporting Stripe/dashboard and product-documentation assets.
- Implemented the 30-day subscription trial flow.
- Corrected subscription webhook state handling so the stored status reflects
  Stripe's actual value, including `trialing` rather than forcing `active`.

**Primary areas:** product delivery, billing/webhooks, documentation.

### Sunday, 2 August

No project activity was recorded in the reviewed Git history.

### Monday, 3 August

**Git activity:** 47 commits
**Representative commits:** `2b08780`, `5aeee17`, `77fb1e0`, `58133f1`,
`0c7fc0b`
**Selected task evidence:** #38, #46, #49, #50, #51, #63, #65–#67, #69,
#72–#74, #80, #88, #148, #205, #217, #234, #277, #280, #283, #285, #287,
#292, #305, #322, #324.

- Fixed subdomain routing when the configured site URL used a `www.` prefix.
- Added a tenant-ownership check for `representedArtistId` in artwork
  creation/update flows, closing a cross-tenant assignment risk.
- Escaped buyer-controlled values in order-confirmation email HTML and added
  regression coverage against HTML injection.
- Fixed Vercel Edge build behaviour by keeping Node-only mail functionality out
  of Edge instrumentation.
- Added storage startup warnings and a storage health probe.
- Added payment, refund, reservation, browse-filter, inquiry, domain, rate-limit,
  billing-access, webhook-signature, and tenant-isolation coverage.
- Documented the critical apex-versus-`www` redirect risk for Stripe webhooks and
  Vercel Cron routes.

**Primary areas:** security, routing/build reliability, Stripe, storage,
multi-tenant testing.

### Tuesday, 4 August

**Git activity:** 24 commits
**Representative commits:** `c168191`, `bd53d65`, `b179c37`, `d3ba13d`,
`683552d`
**Selected task evidence:** #366, #383, #385.

- Improved Stripe readiness UX, checkout gating, cached/live status visibility,
  and expired-trial treatment.
- Fixed five production defects in a single review set: logout session teardown,
  transactional registration, post-login redirect handling, cancellation email
  handling, and trial-end display.
- Added billing-access and resubscription real-database coverage for
  `incomplete_expired` subscription states.
- Made email transport failures visible rather than silently swallowed.
- Corrected the CI pnpm major-version mismatch in drift workflows.
- Verified that orphan-sweep HTTP responses retain the correct result when a
  notification attempt fails.

**Primary areas:** production fixes, billing, CI, email/alert reliability.

### Wednesday, 5 August

**Git activity:** 71 commits
**Representative commits:** `8a84f52`, `d2d8b13`
**Selected task evidence:** #388–#393 and related require-database boundary work.

- Expanded orphan-sweep coverage across Slack failure, email failure, combined
  failure, storage/database failure, HTTP response, and authorization paths.
- Built exhaustive `REQUIRE_DB_PSQL_TIMEOUT_MS` validation coverage: decimal and
  scientific notation, binary/octal/hex input, zero, overflow, Infinity, safe
  integer boundaries, whitespace, and subprocess propagation.
- Continued checkout, Stripe readiness, trial countdown, stale-cache, browse,
  and rate-limit regression work.

**Primary areas:** reliability testing, environment validation, real-HTTP paths.

### Thursday, 6 August

**Git activity:** 39 commits
**Representative commits:** `4b2da11`, `178d350`, `512df42`, `604b4bb`,
`23c4967`

- Finalised Stripe readiness/onboarding and stale-cache recovery paths, including
  the extracted readiness panel, onboarding refresh, and account reauthorization
  coverage.
- Added checkout protection for false readiness, deauthorization, duplicate
  completion, partial transaction rollback, odd-cent commission calculations,
  and retryable payment state.
- Added refund safeguards, including a real-database double-refund guard and an
  alert when Stripe succeeds but the database write fails.
- Added image-storage startup diagnostics and operator-page streaming/caching.
- Added SMTP/alert error handling and continued orphan-sweep security coverage.
- Created and expanded the project work-log and early engineering report records.

**Primary areas:** Stripe, payment integrity, operational diagnostics, testing.

### Friday, 7 August

**Git activity:** 46 commits
**Representative commits:** i-Framer Premium implementation and Slack smoke
workflow changes
**Selected task evidence:** #217, #471–#484, #529.

- Delivered the i-Framer Premium account-linking and billing-access path,
  including operator audit context, concurrent-update protection, comp-removal
  and subscription-loss alerts, and failure/replay handling for Slack audit
  notifications.
- Added `/api/slack-smoke`, a reconnect smoke workflow, fallback email controls,
  and route/secret verification tests.
- Strengthened Cron authorization and orphan-sweep notification-channel
  behaviour.
- Added and updated the live-server test checklist, including storage-health and
  Vercel Blob setup guidance.

**Primary areas:** i-Framer Premium, Slack reliability, CI/Cron controls,
operational documentation.

### Saturday, 8 August

**Git activity:** 123 commits
**Representative evidence:** broad real-database integration test expansion
**Selected task evidence:** #512, #66, #484, #285, #287, #283, #148, #46,
#49, #93, #48, #50, #36, #11, #234, #205, #63, #73, #88, #51.

- Expanded platform reporting and tenant administration.
- Added a broad real-database integration suite across checkout, orders, storage,
  billing, inquiry handling, Slack replay, i-Framer work, catalog operations,
  search/filtering, rate limiting, fulfillment, and tenant isolation.
- Covered important failure and idempotency cases, including disabled Stripe
  accounts, failed alert delivery, duplicate membership, image serving, and
  cross-tenant operations.

**Primary areas:** integration coverage, platform administration, tenant safety.

### Sunday, 9 August

No project activity was recorded in the reviewed Git history.

### Monday, 10 August

**Git activity:** 51 commits
**Representative commits:** webhook-health and Blob-upload remediation changes
**Selected task evidence:** #539–#604.

- Diagnosed the apex-to-`www` redirect impact on Stripe webhooks and Vercel Cron
  delivery, and added a redirect diagnostic.
- Added scheduled webhook health probing, Slack/email escalation, alert
  deduplication, heartbeat/dead-man safeguards, and probe URL drift coverage.
- Added configuration guards for Healthchecks and workflow dispatch controls.
- Fixed the Vercel Blob callback path so callback-body parsing occurs before the
  session check; this addressed the callback authorization failure behind the
  production upload/CORS symptom.
- Upgraded `@vercel/blob` from 2.6.1 to 2.7.0.

**Primary areas:** production diagnosis, webhook reliability, storage uploads,
CI monitoring.

### Tuesday, 11 August

**Git activity:** 59 commits
**Representative commits:** `d408b99`, `03fa86b`, `0ee33df`, `0d54814`,
`d1ca540`, `d595bbd`
**Selected task evidence:** #642, #657, #662 and probe/cache guard work.

- Added multipart upload support with streaming size enforcement and safe handling
  for valid under-limit forms.
- Hardened raw and multipart upload routes against zero-byte inputs, forged
  content lengths, multi-chunk over-limit uploads, slow drips, stalled reads,
  unclosed streams, and per-request counter interference.
- Enforced per-read and total wall-clock deadlines so gap-based slow-drip uploads
  return a timeout instead of exhausting resources.
- Added HTTP-layer verification that the timeout reaches the client as HTTP 408.
- Added a dedicated slow-test workflow, a Next.js cold-start/stall probe, cache
  reuse, timing-budget warnings, and cache-sentinel guard/meta-tests.

**Primary areas:** upload security, denial-of-service resistance, CI reliability.

### Wednesday, 12 August

**Git activity:** 69 commits
**Representative evidence:** probe-cache, CI sentinel, Slack replay, and
concurrent-sweep regression suites.

- Continued probe-cache sentinel lifecycle work, including mtime tolerance,
  fractional threshold, zero-tolerance override, cache-age, and guard-workflow
  tests.
- Continued failure-safe Slack replay and billing-alert delivery work.
- Expanded concurrent sweep and retry-path verification to ensure failed
  notifications are retained, retried safely, and do not silently vanish.

**Primary areas:** CI verification, cache correctness, alert replay reliability.

### Thursday, 13 August

**Git activity:** 58 commits
**Representative commits:** `9f43071`, `275e172`, `a80312c`, `e1b3cbc`,
`a77d243`, `a347d1b`
**Selected task evidence:** #217 follow-up, #735, #760.

- Re-registered the Stripe webhook endpoint at the currently canonical `www`
  URL and updated the health probe/runbook record to match.
- Added durable billing-alert persistence and replay coverage for failed or
  mismatched checkout/webhook paths.
- Added the visible **Slack missed** billing-alert state plus real-database
  replay, dismissal, and idempotency coverage.
- Completed i-Framer Premium self-service billing verification and related
  commission/poller tests.
- Corrected Vercel Blob private-access writes and private blob fetching.
- Adjusted Vercel Cron cadence for the documented Hobby-plan constraint.
- Fixed Next.js build issues blocking the Vercel deployment path and added a
  sensitive-content CI guard.

**Primary areas:** Stripe/webhooks, Vercel/Blob, billing alert reliability,
deployment safeguards.

### Friday, 14 August

**Git activity:** 45 commits
**Representative commits:** `64df05c`, `fe5d805`, `23b5439`, `9aebb96`,
`505d6db`
**Selected task evidence:** #769, #794 and Slack replay test groups.

- Added a tenant-ownership guard for storage serving, preventing cross-tenant
  image disclosure.
- Added atomic claim protection to inquiry email sweeps to prevent concurrent
  duplicate sends.
- Added Stripe `charge.refunded` synchronisation and an optimistic locking guard
  against concurrent refund-total corruption.
- Added stale-state guards around fulfillment/cancellation actions.
- Extended the billing-alert **Slack missed** and i-Framer Slack replay suites
  across success, failure, malformed payload, partial success, and database
  exception paths.
- Added gallery-owner notification when buyer inquiry email delivery fails.

**Primary areas:** tenant security, inquiry delivery, refund integrity, replay
reliability.

### Saturday, 15 August

**Git activity:** 25 commits
**Representative commits:** `498f9de`, `f2c7208`, `c153e57`, `b6ab4ff`,
`b00d42e`
**Selected task evidence:** #862 and inquiry-sweep recovery work.

- Added exponential backoff for failed inquiry-notification email delivery.
- Prevented inquiries with missing contact data, deleted artwork, missing tenant
  records, or permanent cross-tenant mismatches from looping forever.
- Added tenant-scoped sweep guards and real-database coverage.
- Added gallery UI warnings for missing contact email and permanently failed
  inquiry notifications.
- Requeued blocked inquiry work after gallery settings restore/contact-email
  changes, with integration coverage for the recovery path.

**Primary areas:** inquiry email recovery, data consistency, tenant isolation.

### Sunday, 16 August

**Git activity:** 3 commits
**Representative commits:** `f52d391`, `c572dbe`, `4cb1515`, `81608b4`

- Corrected settings clearing so optional theme colour, about text, location, and
  contact email persist as database `null` values rather than invalid empty
  strings.
- Added clear-then-read integration coverage for each affected setting.

**Primary areas:** settings data integrity, regression tests.

### Monday, 17 August

**Git activity:** 69 commits
**Representative commits:** `f40f192`, `3956c5e`, `d943a7f`, `8008a79`,
`b3cd65e`, `41f3a88`
**Selected task evidence:** #917, #930, #937, #946, #948, #953, #954, #960.

- Added an owner-only action and UI affordance to retry stuck inquiry
  notifications.
- Ensured SMTP-error retries, no-contact-email requeues, exhausted queues, and
  backoff resets remain tenant-scoped, idempotent, and safe under concurrent
  sweeps.
- Kept error metadata intact where a downstream sweep needs it to reselect and
  deliver the inquiry.
- Aligned Settings retry counts with the Inquiries banner and added coverage for
  live banner clearing/restoration.
- Added owner-role restrictions for custom domain changes, Stripe onboarding,
  billing portal, and subscription checkout actions.
- Added settings round-trip and storefront theme-colour verification.

**Primary areas:** inquiry recovery, role authorization, tenant settings.

### Tuesday, 18 August

**Git activity:** 51 commits
**Representative commits:** `95c7093`, `215385f`, `62bcd0f`, `5077e86`,
`1159ff8`, `99797cd`
**Selected task evidence:** #989 onward, #993, #995–#997, #1010–#1017,
#1020–#1025, #1030, #1033, #1040, #1042.

- Added an operator way to identify and clear a crashed-worker inquiry nonce,
  with retry safety, revalidation, and tenant-scoped real-database tests.
- Expanded cross-tenant isolation coverage for individual and bulk inquiry
  actions, archive/unarchive, status changes, reply access, reply-thread loading,
  email-failure badges, and mixed own/foreign ID arrays.
- Added a gallery-logo upload setting and public logo-serving route for the
  storefront, About page, and sellers presentation.
- Investigated a reported production server error on the new-artwork route.
  Subsequent authenticated production testing loaded the route successfully.
- Completed a production Create Artwork smoke test: form render, artwork
  creation, image upload, persistence after reload, cross-tenant isolation, and
  removal of the test record all passed.

**Primary areas:** security, inquiry operations, storage/UI, live production
verification.

### Wednesday, 19 August

**Git activity:** 32 commits
**Representative commits:** `db920ba`, `010b287`, `507565c`, `591df87`,
`4134ef5`, `e9b158f`

- Hardened bulk inquiry actions against empty/foreign ID arrays and preserved
  valid selections through refreshes and mid-flight state changes.
- Added accessibility coverage for action errors, alert roles, status feedback,
  disabled controls, pending labels, retries, and mixed select-all flows.
- Kept the fast test suite within CI time limits.
- Extracted and expanded sender-display-name handling, including quoted,
  numeric, plus-tag, separator, case, and staff-reply scenarios.

**Primary areas:** bulk-action UX/accessibility, query safety, CI performance.

### Thursday, 20 August

**Git activity:** report and regression-stabilisation commits
**Representative commits:** `c95df34`, `8044b68`

- Stabilised status-email retry backoff boundary coverage.
- Added sender display-name regressions for quoted local parts, plus tags,
  numeric/hyphen names, and separators.
- Consolidated current engineering history and time-report evidence.
- Ran the available consolidated validation set:
  - Fast suite: **2,293 passed, 2 skipped**
  - Real-database integration suite: **1,936 passed, 2 skipped**
  - Typecheck: passed
  - Lint: passed, with one unrelated unused-disable warning
  - Production no-database build: passed
  - Production schema-drift check: passed against **26 tables**

**Primary areas:** regression stability, documentation, release validation.

---

## Documented external and production work

The table below distinguishes work documented as external to Git/Replit from work
that is only inferred or remains unverified. It is a work-history record, not an
external-time estimate.

### Confirmed external work

| Date | Activity | Evidence |
|---|---|---|
| Aug 7 | Vercel Blob connection/environment review, deployment/redeployment steps, storage-health checks, and live browser checklist review. | Existing Aug 1–10 work history and live checklist updates. |
| Aug 10 | Browser DevTools and Vercel-log investigation of the Blob upload 400/CORS symptom before callback authorization was fixed. | Documented production investigation and upload-route remediation. |
| Aug 13 | Stripe webhook endpoint re-registered at the `www` URL; health probe/runbook updated. | `9f43071`, `275e172`, `GO-LIVE.md`. |
| Aug 18 | Authenticated live-browser/production smoke testing of catalog creation and image upload, including reload persistence, tenant isolation, and cleanup. | Session production-test record and checklist updates. |

### Uncertain or potentially overlapping external work

| Date | Activity | Reason for classification |
|---|---|---|
| Aug 4 | GitHub Actions verification after the pnpm v10 CI fix. | The code and workflow changes are documented, but a separately timed dashboard review is not. |
| Aug 6 | Vercel primary-domain review. | The redirect issue is documented, but the project record does not prove a distinct manual dashboard session. |

### Pending or unverified external work

- The live checklist still requires direct confirmation for refund behaviour,
  subscription/paywall paths, i-Framer Premium actions and Slack delivery, full
  Slack smoke delivery, orphan sweep/storage deletion, custom-domain behaviour,
  logo upload/removal UI, and inquiry email delivery.
- Buyer and gallery notification email checks failed/partially failed on
  18 August because email was not received. SMTP/Resend production configuration
  remains necessary before these flows can be considered complete.
- The historical `GO-LIVE.md` contains earlier environment findings. Later
  checklist and production-smoke evidence should be consulted for the current
  state of the specific route or feature being reviewed.

---

## Major accomplishments

### Payments, billing, and Stripe

- Trial subscriptions now preserve Stripe's real status and trial end date.
- Checkout and Connect readiness handling now covers deauthorization,
  stale-state recovery, invalid account states, retryability, and buyer-facing
  error behaviour.
- Added refund idempotency/concurrency safeguards and a `charge.refunded`
  synchronization path.
- Completed i-Framer Premium linking, permissions, audit/event alerts, replay
  behaviour, and self-service billing verification.
- Hardened webhook health monitoring and documented the canonical URL risk.

### Security and multi-tenancy

- Prevented cross-tenant artwork-to-artist assignment.
- Prevented email HTML injection from buyer-controlled values.
- Protected private storage serving against cross-tenant disclosure.
- Added owner-role authorization to sensitive domain and billing actions.
- Expanded real-database tenant-isolation coverage across inquiries, images,
  replies, status changes, archival, batch actions, and error counts.

### Storage and uploads

- Added startup/storage health diagnostics and production Blob configuration
  checks.
- Fixed Blob callback authorization and private access behaviour.
- Added streamed multipart uploads with size, timeout, stall, slow-drip, and
  forged-header defenses.
- Added gallery logo upload and public logo serving.
- Completed the full production Create Artwork/image-upload persistence and
  cleanup smoke path.

### Operational resilience

- Added Slack smoke checks, replay controls, deduplication, persisted failure
  states, and clear operator-facing **Slack missed** indicators.
- Added webhook health checks, dead-man/heartbeat monitoring, alert
  deduplication, and URL drift coverage.
- Made inquiry notification delivery recoverable after contact-email changes,
  exhausted retries, transient SMTP failures, and worker crashes.
- Restored CI compatibility with the lockfile's pnpm version and added slow-test,
  probe-cache, and timing-budget safeguards.

---

## Testing and verification summary

Testing added or expanded during the period included:

- Unit and component coverage for billing UI, sender-display logic, role guards,
  retry state, alert state, and accessibility.
- Real-database integration coverage for multi-tenancy, billing, checkout,
  refunds, inquiry sweeps, replay, storage, settings, and bulk actions.
- HTTP-layer coverage for storage upload size limits, slow-drip timeouts,
  multipart parsing, authorization, and error status propagation.
- CI/meta-test coverage for workflow drift, cache sentinels, timing budgets,
  mtime tolerance, cold starts, and slow-test enforcement.
- Production checks for domain/webhook configuration, storage health, checkout
  test mode, catalog creation, artwork upload, persistence, and isolation.

The latest consolidated validation outcomes are recorded in the 20 August entry.
They show the available automated suites, typecheck, build, and schema validation
were passing at that point. The manual checks listed as pending above remain
separate from automated validation.

---

## Outstanding verification and operational follow-up

1. Configure and verify production SMTP/Resend delivery, then re-run buyer,
   gallery, and inquiry-email checks.
2. Complete the remaining checklist-confirmed live tests for refunds,
   subscriptions, i-Framer Premium, Slack delivery, storage deletion/orphan
   sweeping, custom domains, logo removal, and inquiry email.
3. Resolve the apex-to-`www` redirect/Cron configuration as required by the
   current deployment topology, then confirm webhook and Cron targets match the
   chosen canonical domain.
4. Continue treating reported production incidents as requiring a fresh
   authenticated live reproduction, because historical route failures may have
   been transient and some operational records predate later fixes.

---

## Overall engineering activity summary

From August 1 through August 20, the project moved from early subscription,
legal, and routing work into a heavily tested production-hardening phase. The
record shows meaningful delivery across payments, storage, operational alerts,
CI, tenant isolation, and inquiry recovery. The work is strongly supported by
commit, task, test, checklist, and production-verification evidence.

For invoice preparation, use this report to identify the supported scope of work
and use a contemporaneous personal time record to determine hours. Do not derive
hours by multiplying commits, task counts, test counts, or automated-agent
activity.

---

*Prepared from available project evidence on 20 August 2026. This report records
engineering history and verification status; it does not replace a personal time
log.*