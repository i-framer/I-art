# Artwork Bank — Developer Handover

**Last updated:** 13 August 2026

---

## What is this?

**Artwork Bank** is a multi-tenant SaaS platform for Australian artists, galleries, and framers to manage and sell artwork online. Each tenant gets their own admin panel, storefront subdomain (`slug.i-art.com.au`), and optionally a custom domain.

Key integrations:
- **Stripe Connect** — galleries connect their own Stripe account; the platform takes a 5 % commission via application fees, and $10 AUD/month subscription via the platform's Stripe account
- **i-Framer** — professional framing service; framing orders arrive via webhook; galleries that subscribe to i-Framer's premium tier get Artwork Bank free (billing exemption flag)

Live domain: **i-art.com.au** (also registered: i-art.au → will redirect)

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 App Router (React 19, RSC) |
| Runtime | Node.js 24, TypeScript 5.9 |
| Package manager | pnpm workspaces (monorepo) |
| Database | PostgreSQL via [Neon](https://neon.tech) (managed, serverless-compatible) |
| ORM | Drizzle ORM + drizzle-zod |
| Payments | Stripe Connect (application fees) + Stripe Subscriptions |
| File storage | Vercel Blob (`BLOB_READ_WRITE_TOKEN`) |
| Email | SMTP (configurable) or Resend (`RESEND_API_KEY`) |
| Auth | Iron-session (cookie-based, no OAuth) |
| Deployment | Vercel — Next.js app; pnpm workspace `@workspace/artwork-bank` |
| Tests | Vitest — fast unit + integration + UI (happy-dom) |

---

## Monorepo layout

```
/
├── artifacts/
│   └── artwork-bank/          ← the Next.js app (primary package)
│       ├── app/               ← Next.js App Router
│       │   ├── (admin)/       ← admin panel (auth-gated)
│       │   ├── api/           ← route handlers (Stripe webhook, sweep crons, upload, etc.)
│       │   └── t/[slug]/      ← public tenant storefront (SSR per tenant)
│       ├── lib/               ← shared logic (billing, email, slack, stripe, db queries)
│       ├── scripts/           ← seed, smoke tests, notifiers, CI helpers
│       ├── __tests__/         ← 293 test files (unit + integration + UI)
│       ├── DEPLOY.md          ← authoritative deployment runbook
│       ├── GO-LIVE.md         ← go-live checklist report (last verified Aug 2026)
│       └── RUNBOOK.md         ← operational runbook (alerts, crons, Stripe probe)
├── packages/
│   └── db/                    ← Drizzle schema + migrations (shared DB package)
├── .github/
│   └── workflows/
│       └── stripe-webhook-health.yml  ← 15-min health probe for the Stripe webhook
├── HANDOVER.md                ← this file
├── GO-LIVE.md                 → see artifacts/artwork-bank/GO-LIVE.md
└── replit.md                  ← Replit environment notes + user preferences
```

The spec / planning assets live in `attached_assets/` (Replit workspace uploads; not committed to git).

---

## What's built and working

### Core platform
- **Multi-tenancy** — every resource (artwork, order, inquiry, team member, setting) is scoped to a `tenant_id`; wildcard subdomain routing serves each gallery's storefront
- **Artwork catalog** — CRUD with images (Vercel Blob), categories, artists, SKU, edition tracking, status (Available / Sold / Reserved)
- **Public storefront** — per-tenant SSR pages: gallery browse, artwork detail, inquiry form, buy button
- **Checkout & payments** — Stripe Checkout sessions via Connect; artwork reserved on session creation, released on expiry; order created on `checkout.session.completed`
- **Subscription billing** — $10 AUD/month via platform Stripe; billing guard on admin actions; trial period; billing alert emails + Slack alerts; dedup to prevent alert spam
- **Orders** — order list + detail, shipping updates, refunds (full and partial), order notifications to buyer + gallery
- **Team management** — invite by email, role (ADMIN / MEMBER), tenant-scoped
- **Inquiries** — buyer → gallery message thread with reply tracking and sender display name
- **Custom domains** — galleries can add their own domain; CNAME verification + Vercel API provisioning
- **i-Framer integration** — FRAMING_JOB orders arrive via signed webhook; poller component refreshes the order page until the job resolves; billing exemption for i-Framer Premium accounts
- **Platform admin** — `/platform` (PLATFORM_ADMIN_EMAILS) — comp galleries, view billing status

### Operational
- **Stripe webhook health probe** — GitHub Actions checks `https://www.i-art.com.au/api/stripe/webhook` every 15 min; fires Slack + email alert on redirect or error *(webhook registered at www URL as of Aug 2026)*
- **Email sweep cron** — `/api/email-sweep` (Vercel Cron, every 10 min) — retries unsent order emails
- **Reservation sweep cron** — `/api/reservation-sweep` (every 5 min) — releases expired Stripe Checkout reservations
- **Orphan sweep** — cleans up storage objects not linked to any artwork
- **Upload** — multipart image upload with stall-guard (30 s per-chunk / 120 s total), 25 MiB cap, image-only filter

---

## Pricing model

| Customer type | Subscription | Commission |
|---|---|---|
| Standard gallery | $10 AUD / month | 5 % via Stripe application fee |
| i-Framer Premium gallery | Free (billing exempt) | 5 % via Stripe application fee |
| Comped gallery | Free (platform admin override) | 5 % via Stripe application fee |

---

## Open tasks (post-launch roadmap)

| # | Task | Notes |
|---|---|---|
| #81 | Exhibition & Show Planner | New feature — not started |
| #82 | Consignment & Commission Tracker | New feature — not started |
| #83 | Certificates of Authenticity & Labelling | Schema + PDF generation; spec in `attached_assets/` |
| #85 | Move existing artwork images to Vercel Blob | One-time go-live migration; needs `BLOB_READ_WRITE_TOKEN` |
| #86 | Verify tenant subdomains route correctly end-to-end | Needs live DNS propagation |
| #92 | Partial refund support improvements | Polish pass |

Priority report: `.local/tasks/slack-priority-report.md`

---

## Hosting plan

- **App:** Vercel — Next.js app (`@workspace/artwork-bank`), connected to the `i-framer/I-art` GitHub repo, auto-deploys from `main`
- **Database:** Neon PostgreSQL — connection string in `DATABASE_URL` (Vercel env var)
- **Storage:** Vercel Blob — `BLOB_READ_WRITE_TOKEN` (Vercel env var)
- **Domains:**
  - `i-art.com.au` — primary (apex). Vercel currently routes apex → www (reversed); operator must set apex as primary in Vercel → Settings → Domains. See `DEPLOY.md §4`.
  - `www.i-art.com.au` — should redirect to apex once above is fixed
  - `*.i-art.com.au` — wildcard for tenant subdomains (wildcard cert issued)
  - `i-art.au` — not yet pointed at Vercel; to redirect to `i-art.com.au`

Production status: DNS and certs live; app returns 500 pending `DATABASE_URL` and other env vars being set in Vercel. See `artifacts/artwork-bank/GO-LIVE.md` for the full checklist.

---

## Getting started

### 1. Install

```bash
pnpm install
```

### 2. Environment

Copy and fill in:

```bash
cp artifacts/artwork-bank/.env.example artifacts/artwork-bank/.env.local
```

Minimum for local dev:
```
DATABASE_URL=postgresql://...
SESSION_SECRET=any-long-random-string
```

For Stripe features add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (or set `STRIPE_WEBHOOK_DEV_BYPASS=1` to skip signature checking locally).

### 3. Database

```bash
# Push schema to dev database (Drizzle push — no migration files)
pnpm --filter @workspace/db run push

# Seed sample data
pnpm --filter @workspace/artwork-bank run db:seed
```

### 4. Run

```bash
# Dev server (reads PORT env var; Replit sets it automatically)
pnpm --filter @workspace/artwork-bank run dev

# Or via Replit workflow: "artifacts/artwork-bank: web"
```

### 5. Test

```bash
# Fast unit + UI tests (293 files, ~3 500 tests)
pnpm --filter @workspace/artwork-bank run test

# Integration tests (requires DATABASE_URL)
pnpm --filter @workspace/artwork-bank run test:integration

# Typecheck
pnpm run typecheck

# Lint
pnpm run lint

# Build (no DB required — used in CI)
pnpm --filter @workspace/artwork-bank run build:no-db
```

### 6. Key files

| File | Purpose |
|---|---|
| `packages/db/src/schema/` | Drizzle table definitions — source of truth for the DB shape |
| `artifacts/artwork-bank/lib/billing.ts` | Subscription guard, billing status helpers |
| `artifacts/artwork-bank/lib/email.ts` | All transactional emails |
| `artifacts/artwork-bank/lib/stripe.ts` | Stripe client, Connect helpers |
| `artifacts/artwork-bank/app/api/stripe/webhook/route.ts` | Stripe webhook handler |
| `artifacts/artwork-bank/DEPLOY.md` | Production deployment runbook |
| `artifacts/artwork-bank/RUNBOOK.md` | Operational runbook (alerts, crons) |
| `artifacts/artwork-bank/GO-LIVE.md` | Go-live checklist report |

---

## Architecture decisions

- **No migration files** — Drizzle `push` is used (dev and prod). Production schema changes go through `DATABASE_URL=... pnpm --filter @workspace/db run push` run manually or via CI. The `check-drift` workflow alerts if prod schema drifts from code.
- **Iron-session, not JWT/OAuth** — simple cookie session; no third-party auth provider. Session secret in `SESSION_SECRET`.
- **Stripe application fees, not transfers** — 5 % taken at charge time via `application_fee_amount` on the Checkout session. Galleries receive net; platform receives fee automatically.
- **Billing guard is in the DB query layer** — `lib/billing.ts` gates reads and writes so galleries without an active subscription cannot access admin features even if they navigate directly.
- **Apex-canonical URL** — `NEXT_PUBLIC_SITE_URL=https://i-art.com.au` (no www). The www hostname should redirect to apex. The Stripe webhook is currently registered at www (see RUNBOOK.md) as a temporary measure until Vercel's primary-domain setting is corrected.
