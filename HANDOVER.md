# Artwork Bank — Developer Handover

_Written 21 July 2026 for the developer joining over the weekend._

## What this is

**Artwork Bank** is a multi-tenant SaaS marketplace where **artists, galleries, and framers** (tenant types `ARTIST` and `FRAMER`) sell original artwork online. Each tenant gets their own storefront at `{slug}.i-art.com.au` (or a verified custom domain). It is a standalone product that integrates with the owner's existing **i-Framer** product (framing costing/visualisation): framing-fulfilment orders automatically create i-Framer jobs.

The full product spec lives in `attached_assets/` (see the "Artwork Bank" pasted text file).

## Tech stack

- **Monorepo**: pnpm workspaces, Node.js 24, TypeScript 5.9. The app is `artifacts/artwork-bank/`.
- **App**: Next.js 15 (App Router, server actions), Tailwind CSS v4
- **DB**: PostgreSQL + Drizzle ORM — shared schema package at `lib/db` (`@workspace/db`)
- **Auth**: iron-session (cookie `artwork_bank_session`), multi-tenant sessions carry `userId` + `tenantId` + `role`
- **Payments**: Stripe
  - **Sales**: Stripe Connect (Express) — buyers pay into **each tenant's own Stripe account**; the platform takes a **5% commission** as a Stripe application fee (`PLATFORM_FEE_PERCENT`, `lib/stripe.ts`)
  - **Subscriptions**: billed by the **platform account** directly (not Connect) — see Pricing below
- **Email**: transactional email with persisted retry state (order confirmations, status updates, gallery alerts)
- **Tests**: Vitest (`artifacts/artwork-bank/__tests__/`), ~150 tests

## What's built and working

- Multi-tenant storefronts (`/t/[slug]`) with theming, about pages, custom-domain resolution via middleware + CNAME verification
- Admin app (sidebar layout): dashboard, catalog (artworks, images via object storage, categories, represented artists), orders, inquiries (with replies + bulk actions), settings (general, team invites, billing)
- Checkout: Stripe Checkout with artwork reservation (RESERVED → SOLD / expiry release), idempotent webhook order creation in a single DB transaction, buyer order lookup
- Commission: 5% application fee on every sale, persisted on the order (`applicationFeeCents`) and shown on admin order detail
- Subscription billing (see Pricing): paywall on admin pages for unsubscribed tenants (`app/(admin)/(gated)/layout.tsx`), Billing tab in settings (subscribe via Checkout, manage/cancel via Stripe customer portal), webhook status sync, `billing_exempt` comp flag; **public storefronts are never gated**
- iFramer job creation for `FRAMING_JOB` orders (tenants with `iframerAccountId`)
- Email retry sweep endpoint, rate limiting on checkout/inquiries, extensive tenant-isolation tests

### Test galleries & logins (development)

Three tenants exist in the dev database, all comped (`billing_exempt = true`) so the subscription paywall doesn't block admin access. Admin login is at `/login`; storefronts are at `/t/{slug}`.

| Gallery | Type | Slug | Admin login | Password |
|---|---|---|---|---|
| Jane Smith Studio | ARTIST | `jane-smith-studio` | `jane@janesmith.studio` | `password123` |
| Frame Works Sydney | FRAMER | `frame-works-sydney` | `admin@frameworks.com.au` | `password123` |
| Anokah | ARTIST | `anokah` | `mark@anokah.com.au` | (Mark's own account — ask him, or use a seeded login) |

The first two are created/repaired by the seed script (`pnpm --filter @workspace/artwork-bank run db:seed` — safe to re-run; it also re-comps them). Anokah is Mark's manually created test gallery — he'll be assisting with testing and advising during handover.

## Pricing model (agreed)

- **AUD $10/month subscription** per tenant for access to the admin app (Stripe Billing, platform account; price auto-created with lookup key `artwork_bank_monthly_v1`, override with `SUBSCRIPTION_PRICE_ID`)
- **5% commission** on each sale (Stripe application fee into the platform account; tenant keeps the rest in their own Stripe account)
- Planned: **free-with-i-Framer-premium bundle** — the `tenant.billing_exempt` flag is the placeholder hook

## Hosting plan

- Domains registered: **i-art.com.au** and **i-art.au** (redirect `i-art.au` → `i-art.com.au`)
- Recommendation: **Vercel** for the Next.js app — first-class wildcard subdomains (`*.i-art.com.au`) plus a domains API for tenants' custom domains — with a managed Postgres provider. AWS is viable but more ops overhead.
- **The app is Vercel-ready** — see `artifacts/artwork-bank/DEPLOY.md` for the full guide (env vars, Blob storage, DNS/wildcard setup, cron config, Stripe webhook). Storage, base URLs, Stripe credentials, and the sweeps all work from plain env vars; Replit-specific infra is only used when its env vars are present.
- Production Stripe setup needed at launch: register the webhook endpoint (checkout + subscription events), set `STRIPE_WEBHOOK_SECRET`, optionally pin `SUBSCRIPTION_PRICE_ID`.

## Getting started

```bash
pnpm install
pnpm --filter @workspace/db run push        # apply DB schema (dev)
pnpm --filter @workspace/artwork-bank run db:seed   # seed demo tenants/artworks
pnpm --filter @workspace/artwork-bank run dev       # dev server (uses $PORT)
```

Checks (also available as workflows in Replit): `pnpm -r --if-present run test`, `pnpm run typecheck`, `pnpm run lint`.

Key places:
- `artifacts/artwork-bank/` — the app (App Router; admin under `app/(admin)/`, gated sections under `(gated)/`; storefront under `app/t/[slug]/`)
- `lib/db/src/schema/` — source of truth for the DB schema
- `artifacts/artwork-bank/lib/` — Stripe, billing, auth, email, iFramer client, base-URL helpers
- `artifacts/artwork-bank/middleware.ts` — custom-domain rewrites + admin session pre-check
- `attached_assets/` — original product spec
- `replit.md` — living project notes

## Open work

See the project task list (Replit) for the queue. Highlights: refunds from order detail, automatic Vercel domain provisioning, iFramer job status sync into Artwork Bank, live inquiry badge updates, production subscription-billing setup, platform-owner comp tooling, and several "verify on a real database" hardening tasks.

### Planned major additions (specs transferred 22 July 2026)

Three new tenant-scoped admin sections are planned as project tasks — full specs live in the task descriptions (Tasks #81–#83) and the original pasted spec in `attached_assets/`:

1. **Exhibition & Show Planner** — plan gallery shows: rooms/walls, 2D floor plan with drag-and-drop artwork placement and hang heights, printable hang lists, guest/RSVP tracking, milestone timeline.
2. **Consignment & Commission Tracker** — consignment agreements per represented artist (split %, dates), link catalog artworks, record sales with auto-calculated artist/gallery splits (linking storefront orders where applicable), artist statements, payments dashboard.
3. **Certificates of Authenticity & Labelling** — issue COAs with unique certificate numbers, branded COA + wall/backing-board label PDFs, QR codes linking to the artwork's public storefront page, extended brand settings.

Adaptation notes vs. the original spec: everything must be tenant-scoped and behind the subscription paywall; "artists" map to the existing represented-artists records (no new artists table); the marketplace core the spec assumed ("Task #5") is already built here. The new developer should review these tasks and decide sequencing.

Dev notes: the Stripe webhook accepts unsigned events only when `STRIPE_WEBHOOK_DEV_BYPASS=true` outside production; Stripe credentials come from the Replit connector (or `STRIPE_SECRET_KEY` fallback).
