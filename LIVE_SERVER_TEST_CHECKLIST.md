# Live Server Test Checklist — i-art.com.au

> **Manual verification on the PRODUCTION server.** Automated tests cover dev; these
> items must be confirmed by a human on the live site because they involve real
> Stripe money movement, real Slack/email delivery, real DNS, or real Vercel infra.
>
> **How to use:** change `[ ]` to `[x]` when a test passes on the live server, and add
> your initials + date, e.g. `[x] (GG 2026-08-09)`. If a test FAILS, mark it `[!]` and
> tell the agent so a fix task can be raised.
>
> **Agent instructions (do not remove):**
> - On the FIRST interaction of each day with info11925 or ggodin, show the outstanding
>   (unchecked) items from this file as a reminder — until every item is checked.
> - When a new feature or fix ships that needs live verification, ADD a test item here
>   in the matching section (or a new section) in the same commit.
> - When the user reports a result in chat, update the checkbox for them.

_Last updated: 2026-08-07 (agent)_

---

## 1. Core buyer flow (real Stripe — use a cheap test artwork)

- [ ] 1.1 Visit a gallery storefront (`{slug}.i-art.com.au`) — loads with correct branding
- [ ] 1.2 Open an artwork page — images, price, and details render correctly
- [ ] 1.3 Buy an artwork with a real card — Stripe Checkout completes and redirects to the success page
- [ ] 1.4 Artwork shows as SOLD immediately after purchase (webhook processed)
- [ ] 1.5 Buyer receives the order confirmation email
- [ ] 1.6 Gallery receives the sale notification (email / dashboard order appears)
- [ ] 1.7 Refund the test purchase from Stripe dashboard — order status updates, partial-refund notification behaves

## 2. Gallery paywall & subscriptions

- [ ] 2.1 A tenant with an ACTIVE subscription can access the dashboard normally
- [ ] 2.2 A tenant with NO subscription is blocked from admin actions and sent to billing
- [ ] 2.3 A comped tenant (`billingExempt=true`) skips the paywall entirely (Task #88)
- [ ] 2.4 Subscribe flow: new tenant → Stripe Billing checkout → subscription becomes active

## 3. i-Framer Premium linking (platform admin panel)

- [ ] 3.1 Link an i-Framer account ID to a tenant — comp applies, paywall opens for that tenant
- [ ] 3.2 The acting admin's email + timestamp appear next to the change (Task #473)
- [ ] 3.3 Unlink the account — the comp survives unlink (billing stays exempt until manually removed)
- [ ] 3.4 Slack `#operations` receives the link AND unlink audit notifications
- [ ] 3.5 Remove the comp (`billingExempt=false`) on an i-Framer-linked tenant — the **comp-removed** Slack alert arrives (Tasks #474/#479)
- [ ] 3.6 An i-Framer-linked tenant whose subscription lapses triggers the **billing-loss** Slack alert (Tasks #478/#484)

## 4. Slack alerting reliability

- [ ] 4.1 A failed Slack post is recorded on the tenant and visible in the platform panel (Task #477)
- [ ] 4.2 The failed-alert replay sends the original payload and clears the failure marker
- [ ] 4.3 `/api/slack-replay` rejects a request without the correct secret (401/403) (Task #175)
- [ ] 4.4 Weekly Slack smoke test posts to the ops channel (check Monday run in GitHub Actions)
- [ ] 4.5 When the smoke test fails, exactly ONE fallback email arrives via Resend — not two (Tasks #488/#493)

## 5. Storage & sweeps

- [ ] 5.1 Upload artwork images on the live site — they display via `/api/storage/serve`
- [ ] 5.2 Delete an artwork — its images are removed from object storage
- [ ] 5.3 Orphan sweep cron runs and posts its result; operator alert arrives on errors (Task #205)
- [ ] 5.4 `/api/storage/orphan-sweep` rejects calls without the Bearer secret

## 6. Domains & routing

- [ ] 6.1 `{slug}.i-art.com.au` subdomain routing resolves to the right tenant
- [ ] 6.2 An unknown subdomain shows the unknown-domain page (no crash, no wrong tenant data)
- [ ] 6.3 A tenant custom domain (if configured) serves the right storefront over HTTPS

## 7. Browse & discovery

- [ ] 7.1 `/browse` filters: seller slug + keyword (`q=`) combined return correct results (Task #287)
- [ ] 7.2 SOLD / RESERVED artworks still appear under the artist filter; HIDDEN never does (Tasks #283/#285)
- [ ] 7.3 Sitemap and robots.txt respond for both the apex and a tenant subdomain

## 8. Inquiries & email

- [ ] 8.1 Send a buyer inquiry from a storefront — the gallery receives it
- [ ] 8.2 Reply from the dashboard — the buyer receives the reply email with correct sender
- [ ] 8.3 Bulk mark-as-handled only touches the current gallery's inquiries (Task #73)

---

## Completed rounds

_(Move fully-checked sections here with the date and tester, then reset the boxes above when a new release needs re-testing.)_
