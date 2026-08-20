# Artwork Bank / i-Art

## August 2026 Estimated Time Report

**Invoice period:** 1–20 August 2026 (Asia/Manila working dates)  
**Project:** i-art.com.au / Artwork Bank  
**Prepared:** 20 August 2026  
**Scope:** Work evidenced to date; no future-August time included.

## Executive summary

The estimated active project time through 20 August 2026 is **105.0 hours**.

This report is a conservative professional estimate, not a claim of clocked time. The project work log does not contain start/end durations. Related commits, task merges, build/test runs, and manual-production activities have therefore been grouped into working sessions to prevent double counting. Passive deployment waits, DNS propagation, personal breaks, and unverified external activity are excluded.

The Git query records **828 commits** in the August-period review. Six commits display as 31 July in UTC but fall within 1 August in the project's Asia/Manila working date; they are treated as early-August activity. Commit count supports scope only and is not converted directly into hours.

## Time allocation by primary work category

Categories are mutually exclusive. For example, a production smoke test is allocated to testing/debugging rather than also being added to external-platform work.

| Category | What is included | Estimated active time |
|---|---|---:|
| Development / coding | Product features, server actions, route changes, reliability fixes, data-model work, safety controls, and UI changes. | 35.0 h |
| Testing / debugging | Unit, integration, real-database and browser smoke coverage; failure investigation; regression reproduction and fixes. | 45.5 h |
| CI / build / deployment | Typecheck, lint, production-build, test-suite and schema-drift monitoring; workflow and deployment troubleshooting. | 7.0 h |
| Production / configuration | Environment validation, security guardrails, release readiness, storage and operational configuration work. | 6.0 h |
| External platform work | Active Vercel, Stripe, Neon, GitHub Actions and live-browser verification documented in checklists/session records. | 6.5 h |
| Technical coordination | Task investigation notes, go-live/checklist updates, engineering reports and implementation coordination tied to delivery. | 5.0 h |
| **Total estimated August activity through 20 August** |  | **105.0 h** |

## Detailed work sessions

Each row represents a correlated work block. Representative commits and task numbers are evidence references, not separate billable line items.

| Date | Work performed | Representative evidence | Primary category | Estimated active time | Evidence basis |
|---|---|---|---|---:|---|
| Aug 1 | Implemented Privacy/Terms pages, 30-day subscription trial flow, and correct Stripe webhook subscription-status handling; reviewed Stripe/dashboard assets and repository setup. | `7052b6c`, `3ab378e`; Stripe dashboard assets | Development / coordination | 4.0 h | Git/Replit evidence |
| Aug 3 | Addressed subdomain routing, cross-tenant artist assignment, email HTML injection, storage health visibility, platform-fee validation, billing/inquiry/retry reliability, and deployment guardrails. | 47 commits; `5aeee17`, `77fb1e0`; Tasks #38, #46, #49, #50, #51, #63, #65–69, #72–74, #80, #88, #148, #205, #217 | Development / testing | 7.5 h | Git, task merges, engineering log |
| Aug 4 | Improved Stripe readiness and checkout gating, handled email transport failures, fixed five production defects, refined billing UX, and repaired the CI pnpm-version mismatch. | 24 commits; `c168191`; Tasks #366, #383, #385; CI workflow changes | Development / testing / CI | 6.0 h | Git, work log, CI records |
| Aug 5 | Hardened orphan-sweep outcomes and real-HTTP behavior; built exhaustive database preflight timeout/boundary coverage; stabilized integration-test isolation. | 71 commits; Tasks #388–#393, #412 and related require-db/orphan-sweep tests | Testing / debugging | 7.0 h | Git, task merges |
| Aug 6 | Completed Stripe readiness/onboarding and trial reliability coverage, SMTP error handling, refund safeguards, operator diagnostics, and engineering activity reporting. | 39 commits; StripeReadinessPanel, `account.updated`, checkout/retry and SMTP suites | Development / testing | 7.0 h | Git, work log |
| Aug 7 | Delivered i-Framer Premium account linking/audit flow, Slack smoke/replay reliability, Cron authorization coverage, and live storage/routing checklist work. | 46 commits; Task #217 implementation; `/api/slack-smoke`; live checklist updates | Development / CI / external platform | 6.5 h | Git, checklist, documented manual verification |
| Aug 8 | Expanded platform reporting and tenant administration; built a broad real-database integration suite across checkout, order, storage, billing, inquiry and multi-tenant isolation behavior. | 123 commits; 50+ integration-test files; 1,500+ cases documented at the time | Testing / debugging | 7.5 h | Git, task merge history |
| Aug 10 | Diagnosed the `www` redirect impact on Stripe webhooks/Vercel Cron, added webhook health/heartbeat protections, and fixed Vercel Blob upload-callback authorization. | Tasks #539–#604; blob-upload route fix; `@vercel/blob` upgrade | Development / external platform | 7.0 h | Git, deployment/runbook records, documented browser investigation |
| Aug 11 | Fixed production image uploads through a server-side proxy; hardened streaming upload limits, slow-drip/stall handling, content safety, and upload→serve→delete persistence testing. | 51 commits; storage upload/serve integration suites; live server checklist | Development / testing | 6.0 h | Git, checklist |
| Aug 12 | Improved CI probe-cache sentinel lifecycle and environment overrides; continued failure-safe Slack replay testing and concurrent-sweep behavior. | 69 commits; probe-cache and i-Framer Slack replay suites | Testing / CI | 7.0 h | Git, task merge history |
| Aug 13 | Worked through Slack billing-alert replay/idempotency paths, failure-payload preservation, storage and production verification, and webhook operational safeguards. | 58 commits; Slack replay integration tests; go-live record updated with `www` webhook registration | Testing / debugging / production | 7.0 h | Git, `GO-LIVE.md` |
| Aug 14 | Finished recovery/replay behavior for billing-alert delivery failures and verified correct tenant-level state updates under exceptions and concurrent sweeps. | 45 commits; Slack replay UI and real-DB integration coverage | Testing / debugging | 6.5 h | Git, task merge history |
| Aug 15 | Hardened inquiry email sweep behavior for missing contact data, deleted/cross-tenant records, permanent failures, and recovery after gallery settings changes. | 25 commits; inquiry sweep and settings/requeue integration tests | Development / testing | 4.5 h | Git, task merge history |
| Aug 16 | Corrected settings-field clearing semantics so optional gallery values persist as `null` rather than invalid empty strings; added regression coverage. | 3 commits; location/about/theme-color persistence fixes | Development / testing | 1.0 h | Git |
| Aug 17 | Extended tenant-settings recovery behavior, inquiry requeue safety and data round-trip coverage; continued email failure-state handling. | 69 commits; Tasks #989 onward; contact-email and gallery-settings integration tests | Testing / debugging | 7.0 h | Git, task merge history |
| Aug 18 | Resolved inquiry bulk-action and cross-tenant edge cases; implemented gallery logo upload/storage serving; investigated and then live-tested the complete Create Artwork/image-upload workflow. | `95c7093`; Tasks #996–#1053; production test of create, upload, reload, isolation and cleanup | Development / testing / external platform | 8.0 h | Git, task history, documented production smoke test |
| Aug 19 | Completed bulk inquiry interaction/accessibility regressions and reply sender-display handling, then kept the fast suite within CI time limits. | Tasks #1034, #1045–#1082; sender-display and BulkActionBar suites | Testing / debugging | 4.5 h | Git, task merge history |
| Aug 20 | Stabilized status-email retry backoff boundary coverage; ran consolidated tests, typecheck, lint, production build and schema-drift verification. | `c95df34`; 2,293 fast tests, 1,938 integration tests, typecheck/build/drift checks | Testing / CI | 1.0 h | Git, current workflow results |
| **Total estimated active project time** |  |  |  | **105.0 h** | Evidence-based estimate |

## Weekly subtotals

| Week | Dates covered | Focus | Estimated active time |
|---|---|---|---:|
| Week 1 | Aug 1–2 | Subscription trials, webhooks, legal pages and project setup. | 4.0 h |
| Week 2 | Aug 3–9 | Security, reliability, Stripe readiness, i-Framer Premium, CI and broad integration coverage. | 41.5 h |
| Week 3 | Aug 10–16 | Webhook/cron diagnostics, Blob upload recovery, storage hardening, Slack replay safety and inquiry email recovery. | 39.0 h |
| Week 4 (partial) | Aug 17–20 | Tenant settings/inquiry recovery, production Create Artwork smoke test, logo upload and bulk-action regressions. | 20.5 h |
| **Total through 20 August** |  |  | **105.0 h** |

## External platform and production work included

The following active work was included only where it is recorded in a checklist, work-history report, session summary, deployment/runbook record, commit message, or final production verification. It is grouped into the daily estimates above rather than added again here.

- **Vercel:** Blob connection/environment review, preview/production deployment checks, live storage health checks, upload investigation, domain/redirect diagnosis, and serverless deployment verification.
- **Stripe:** Connect-readiness investigation, webhook endpoint/redirect analysis, checkout test-mode verification, trial/subscription behavior, and payment-related smoke work.
- **Neon/Postgres:** Real-database integration tests, schema drift checks, production database verification and recovery-path investigation.
- **GitHub Actions:** pnpm/lockfile CI correction, drift/smoke/heartbeat workflow monitoring and webhook-health safeguards.
- **Live browser testing:** Confirmed storefront, Checkout, SOLD state, `/catalog/new`, artwork creation, image upload, persistence after reload, cross-tenant isolation, and test-artwork cleanup.

No allowance has been made for genuine unattended deployment/build time, DNS propagation, or activity that cannot be reasonably tied to a project record.

## Major accomplishments

- Improved multi-tenant security and authorization across artwork, inquiry, image, order and staff-related paths, with real-database regression coverage.
- Strengthened Stripe Connect/Billing operation: trial subscriptions, readiness gating, webhooks, subscription-state handling, invoice/refund safeguards and i-Framer Premium support.
- Made storage production-ready: Vercel Blob diagnostics and proxy upload path, strict stream-size/stall protections, safe public/private serving, image persistence tests, and gallery logo support.
- Raised operational reliability through sweep/retry recovery, alert replay/idempotency behavior, Slack/email error handling, health probes, CI smoke checks and deployment documentation.
- Expanded automated quality coverage substantially, including tenant isolation, payment lifecycle, inquiry-email recovery, storage, webhook, CI and UI accessibility/interaction regressions.
- Completed an end-to-end production Create Artwork smoke test: form render, creation, image upload, reload persistence, cross-tenant isolation and cleanup all passed.

## Evidence reviewed

- Git history for the August-period review: 828 commits, including feature, fix, task-merge and test commits.
- Project work logs: `WORK_LOG.md`, `artifacts/artwork-bank/docs/WORK_LOG.md`, and the earlier August work-history report.
- Operational records: `LIVE_SERVER_TEST_CHECKLIST.md`, `GO-LIVE.md`, deployment/runbook references and task merge updates.
- Latest validation evidence on 20 August:
  - Fast suite: 2,293 tests, 2 skipped.
  - Real-database integration suite: 1,936 tests, 2 skipped.
  - Typecheck passed.
  - Production build passed.
  - Schema drift verification passed against all 26 tables.

## Invoice review note

This report is designed as a conservative estimate for review. The **105.0-hour** total represents supported active work through 20 August 2026, not a replacement for a contemporaneous stopwatch or calendar record. If a personal time record identifies a materially different duration for any session, that first-party record should take precedence and the relevant daily row can be adjusted without changing the underlying scope/evidence list.

---

*Artwork Bank / i-Art — August 2026 Estimated Time Report*  
*Coverage ends 20 August 2026 · Prepared from available project evidence.*