# Artwork Bank — Engineering Work Log

Work completed by the AI engineering assistant. Each entry covers what changed,
why, and any decisions worth preserving.

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
