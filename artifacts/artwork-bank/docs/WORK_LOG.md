# Artwork Bank — Engineering Work Log

Work completed by the AI engineering assistant. Each entry covers what changed,
why, and any decisions worth preserving.

---

## 2026-08-03 (continued — second engineering session)

### Block G — Test coverage: Task #49 gallery-alert two-pass retry
- Added `__tests__/gallery-alert-retry.test.ts` — explicitly exercises the
  retryable design of `sweepUnsentGalleryAlerts`:
  - Pass 1: `sendConfirmationFailureNotice` throws → failed count=1,
    `emailFailureNotifiedAt` stays `null` (order stays selectable for next sweep)
  - Pass 2: send succeeds → sent count=1, `emailFailureNotifiedAt` stamped with
    the sweep timestamp
  - Two-order partial-success scenario across both passes
  - Timestamp written on successful retry matches the `NOW` argument

---

### Block H — Stripe Connect account-not-ready error handling
- **Problem:** When a gallery's Connect account has incomplete onboarding or is
  restricted, `stripe.checkout.sessions.create` throws a `StripeInvalidRequestError`
  (code `account_invalid` / `account_closed` / `account_not_found`, or a message
  mentioning "charges" or "connected account"). The checkout route caught this as a
  generic 500, giving buyers a confusing message and leaving the artwork RESERVED.
- **Fix:** Added a targeted inner try-catch around `sessions.create` in
  `app/api/stripe/checkout/route.ts`. Detected codes + message patterns are caught,
  the reservation is released, and a 503 is returned with a clear message:
  *"This gallery is not yet ready to accept payments…"*.
- **Unrelated Stripe errors** (e.g. `rate_limit`) still propagate as before.
- **Tests:** `__tests__/checkout-connect-account-not-ready.test.ts` — 7 cases
  covering all three account-not-ready codes, both message patterns, one unrelated
  error (stays ≠ 503), and the happy path (200, no release).
- **Commit:** `95e625e`

---

### Block I — Security: HTML injection in `sendOrderConfirmation` (Task #324)
- **Problem:** `sendOrderConfirmation` in `lib/email.ts` interpolated `buyerName`,
  `artworkTitle`, `tenantName`, `orderRef`, and `orderLookupUrl` directly into the
  HTML template without escaping. Every other email function in the same file
  already defines and uses a local `escapeHtml` helper; this one was missed.
- **Fix:** Added `escapeHtml` to `sendOrderConfirmation` and applied it to all
  five interpolated values, including the `href` in the order-lookup link.
- **Tests:** Extended `__tests__/email-content-contract.test.ts` with a new
  describe block — "HTML injection prevention (Task #324)" — covering `<script>`,
  `<img onerror>`, `</p><b>` tag injection, `&` in order ref, `'` in buyer name,
  and `javascript:` href injection via `orderLookupUrl`.

---

### Block J — Test coverage: `refundOrder` Stripe failure paths (Task #322)
- **New file:** `__tests__/order-refund-stripe-failure.test.ts`
- Covers what the existing `order-refund.test.ts` left untested:
  - `getStripeClient()` throws `StripeNotConfiguredError` → friendly redirect,
    no DB update, no email
  - `stripe.refunds.create()` throws Stripe API error → error redirect, no DB
    update, no email
  - Generic `Error` from `getStripeClient` → no Stripe call attempted
  - PENDING order rejected before any Stripe call
  - CANCELLED order rejected before any Stripe call
  - No-`stripePaymentIntentId` order rejected before any Stripe call
- Result: ensures `refundedAmountCents` can never be incremented unless Stripe
  confirms the refund.

---

## 2026-08-03

### Block A — TypeScript error fix
- **Problem:** `webhook-payment-intent.test.ts` referenced `sendGalleryNewOrderAlert`
  which had been renamed to `sendBillingAlertNotification`.
- **Fix:** Updated the import and the mock in that test file.
- **Result:** Typecheck green; 1040 passing tests.

---

### Block B — Security: cross-tenant `representedArtistId` validation
- **Problem:** `createArtwork` and `updateArtwork` in `app/(admin)/(gated)/catalog/actions.ts`
  accepted a `representedArtistId` from form data and stored it without verifying
  the artist belonged to the session tenant. A logged-in gallery owner could
  supply an `id` from a different gallery's artist table — a horizontal privilege
  escalation.
- **Fix:** Added a tenant-scoped `db.query.representedArtistsTable.findFirst` lookup
  before the insert/update. Returns `{ error: "Artist not found." }` if the artist
  id is absent or belongs to a different tenant.
- **Tests updated:** `artwork-artist-isolation.test.ts` — extended from a baseline
  (documenting the old vulnerable behaviour) to a full regression suite asserting
  rejection of foreign-tenant ids and acceptance of same-tenant ids.
- **Commit:** `5aeee17`

---

### Block C — Production reliability: startup env-var health checks
- **Added to `instrumentation.ts`:**
  - Production-only check for `DATABASE_URL`, `SESSION_SECRET`, `NEXT_PUBLIC_SITE_URL`,
    `CRON_SECRET` — logs a clear ⚠️ error with fix instructions if any are missing.
  - Safety check: logs a `SECURITY RISK` error if `STRIPE_WEBHOOK_DEV_BYPASS` is
    set in production (this disables signature verification).
  - Warning when `NEXT_PUBLIC_SITE_URL` uses `www` but `CNAME_TARGET` is not set
    (custom-domain verification would silently fail).
  - Email transport check via `isEmailTransportConfigured()` — warns operators if
    no SMTP/Resend config is present so they know emails won't be sent.
- **All checks are non-blocking** — they log and continue; the app starts regardless
  so a misconfigured optional variable doesn't take down the whole service.
- **Commit:** `77fb1e0`

---

### Block D — Test coverage: closing proposed task backlog

#### Custom-domain input validation (`custom-domain-save.test.ts`)
- Auth gate (unauthenticated → redirect `/login`)
- Empty / whitespace-only domain → error, no DB update
- `localhost` / no-TLD strings → error
- Valid `www.example.com`, `example.com.au` → success
- Whitespace stripped and lowercased before save
- Domain owned by a different tenant → "already in use" error
- Domain already set on the same tenant (re-save) → success

#### Checkout — invalid inputs (`checkout-invalid-inputs.test.ts`)
- Missing `artworkId`, `slug`, `fulfillmentType` → 400
- Invalid `fulfillmentType` value → 400
- Unknown/disabled tenant → 400
- Tenant without `stripeAccountId` → 400
- `FRAMING_JOB` on a non-FRAMER tenant → 400
- Artwork not available (UPDATE matches 0 rows) → 400
- Rate limit exceeded → 429

#### Checkout — Stripe failure + reservation release (`checkout-stripe-failure.test.ts`)
- `StripeNotConfiguredError` → reservation released, 503
- Generic Stripe client error → reservation released ≥ once, 5xx
- `checkout.sessions.create` throws → reservation released, 4xx/5xx
- Artwork with no price → reservation released, 400
- Successful path → reservation stays RESERVED, returns URL

#### Email content contract (`email-content-contract.test.ts`)
- `isEmailTransportConfigured` returns a boolean
- `sendOrderConfirmation` throws `EmailSendError` when transport is not configured
- With SMTP config: recipient, subject (includes artwork title), buyer name,
  tenant name, order reference all present in HTML body
- `orderLookupUrl` included when provided
- `buyerName: null` → "Hi there" fallback

#### Platform fee guard (`platform-fee-guard.test.ts`) — Tasks #305, #306
- `calcApplicationFee` arithmetic: 5% default, rounding, proportionality, 0% and 100% edge cases
- `parsePlatformFeePercent` validation: defaults to 5% when unset, accepts 0–100,
  throws `RangeError` for non-numeric strings, `>100`, negatives, `Infinity`, `NaN`
- Combined contract: valid fee + correct arithmetic; invalid fee throws before any
  commission is calculated

---

### Block E — Deploy tooling

#### `DEPLOY.md` — www → apex redirect warning section
Added a clear `⚠️ Apex vs www redirect — critical production configuration` section
under §4 explaining:
- Vercel's default redirects apex → www, which **breaks Stripe webhooks** (Stripe
  doesn't follow 3xx redirects on delivery) and **silently drops Vercel cron jobs**.
- Two fix options: (A) set `i-art.com.au` as the Vercel primary domain; (B) remove
  the `www` entry entirely.
- Post-fix verification step (send a test event from Stripe Dashboard, confirm 200).

#### `scripts/check-env.sh` — pre-deploy validator
A Bash script that checks all required and recommended env vars before a deployment:
- **Required** (exits 1 if missing): `DATABASE_URL`, `SESSION_SECRET`,
  `NEXT_PUBLIC_SITE_URL`, `CRON_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  image storage (`BLOB_READ_WRITE_TOKEN` or `PRIVATE_OBJECT_DIR`)
- **Safety check** (exits 1 if set): `STRIPE_WEBHOOK_DEV_BYPASS` in production
- **Optional warnings**: email transport, `CNAME_TARGET`, `VERCEL_API_TOKEN`,
  `SLACK_WEBHOOK_URL`, `PLATFORM_FEE_PERCENT` (with numeric validation)
- Can source a `.env.local` file: `bash scripts/check-env.sh .env.local`

---

### End-of-day state

| Metric | Start | End |
|---|---|---|
| Test files | 97 | 101 |
| Passing tests | 1040 | 1090 |
| Skipped tests | 3 | 3 |
| TypeCheck | ✅ green | ✅ green |

### Operator action still required (not code — cannot be fixed here)

| Issue | Fix |
|---|---|
| Vercel redirects apex → www | Set `i-art.com.au` as primary domain in Vercel (see DEPLOY.md §4) |
| Missing Vercel env vars | Run `bash scripts/check-env.sh` against production env; set all 🔴 items |
| Stripe webhook URL | Re-register as `https://i-art.com.au/api/stripe/webhook` after apex→canonical fix |
| `i-art.au` redirect | Point at Vercel from registrar (already in DEPLOY.md §4) |

---

*This log is maintained by the AI engineering assistant. One entry per working session.*
