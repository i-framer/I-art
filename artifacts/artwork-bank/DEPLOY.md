# Deploying Artwork Bank to Vercel

The app lives at `artifacts/artwork-bank/` inside a pnpm monorepo and is designed to
run at **i-art.com.au** on Vercel with plain environment variables — no
Replit-specific infrastructure. It continues to work unchanged in the Replit dev
environment (Replit sidecar object storage + Stripe connector are used there
automatically when their env vars are present).

## 1. Vercel project setup

1. Import the Git repository into Vercel.
2. Set **Root Directory** to `artifacts/artwork-bank` (enable "Include files outside
   the root directory" — the app depends on the workspace package `@workspace/db`
   at `lib/db`).
3. Framework preset: **Next.js**. Vercel detects pnpm from the lockfile; the default
   build command (`next build`) is correct. `next.config.ts` sets
   `outputFileTracingRoot` so monorepo dependencies are traced correctly.
4. Cron jobs are configured in `vercel.json` (email retry sweep every 10 min,
   reservation sweep every 5 min). They are picked up automatically on deploy —
   Vercel invokes them with `Authorization: Bearer $CRON_SECRET` (GET requests).

## 2. Environment variables

Set these in Vercel → Project → Settings → Environment Variables (Production; add
Preview too where noted).

### Required

| Variable | Description | Where to get it |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | Your Postgres provider (Neon recommended — create a project at neon.tech and copy the pooled connection string). Apply the schema with `DATABASE_URL=... pnpm --filter @workspace/db run push` from your machine. **Set in both Production and Preview** (see §7 for Preview options). |
| `SESSION_SECRET` | iron-session cookie encryption key (32+ chars) | Generate: `openssl rand -base64 32` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store token — enables the portable image-storage backend | Vercel → Storage → Create Blob store → connect to the project (token is injected automatically) |
| `NEXT_PUBLIC_SITE_URL` | Canonical production URL, e.g. `https://i-art.com.au` | You choose it. Also drives tenant-subdomain routing (`{slug}.i-art.com.au`). Production only — leave unset on previews so `VERCEL_URL` is used. |
| `STRIPE_SECRET_KEY` | Stripe platform account secret key (`sk_live_...`) | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the production webhook endpoint | Created in step 5 below |
| `SMTP_HOST` | Transactional email via your own mail server (SMTP). Works with Google Workspace (`smtp.gmail.com`), Office 365 (`smtp.office365.com`), or any domain-mail host. | Your email provider's SMTP settings. Also set `SMTP_PORT` (587 default, 465 for implicit TLS), `SMTP_USER`, `SMTP_PASS` (use an app password for Google/Microsoft). Optional `SMTP_SECURE=true/false`. |
| `RESEND_API_KEY` | Alternative email transport (Resend) — only used when `SMTP_HOST` is not set | resend.com → API Keys |
| `CRON_SECRET` | Protects the sweep endpoints invoked by Vercel cron | Generate: `openssl rand -hex 32`. Vercel automatically sends it on cron requests when set. |

### Recommended / optional

| Variable | Description |
| --- | --- |
| `EMAIL_SWEEP_SECRET` | Extra Bearer secret accepted by `POST/GET /api/email-sweep` for manual/external triggering (CRON_SECRET also works) |
| `RESERVATION_SWEEP_SECRET` | Same, for `/api/reservation-sweep` |
| `EMAIL_FROM`, `EMAIL_FROM_ORDERS`, `EMAIL_FROM_INQUIRIES` | From-addresses for outgoing email, e.g. `orders@i-art.com.au`. With SMTP they default to `SMTP_USER`; the domain must have valid SPF/DKIM (usually already set up by your mail provider). With Resend the domain must be Resend-verified. |
| `SUBSCRIPTION_PRICE_ID` | Pin the AUD $10/month subscription price; otherwise a price is auto-created with lookup key `artwork_bank_monthly_v1` |
| `PLATFORM_FEE_PERCENT` | Sales commission percent (default `5`) |
| `CNAME_TARGET` | DNS target shown to tenants for custom domains (set to `cname.vercel-dns.com` on Vercel) |
| `VERCEL_API_TOKEN` | Vercel API token for auto-provisioning tenant custom domains (Vercel → Account Settings → Tokens). Required together with `VERCEL_PROJECT_ID` for self-serve custom domains. |
| `VERCEL_PROJECT_ID` | Vercel project ID (Project → Settings → General) — target project for tenant custom domains |
| `VERCEL_TEAM_ID` | Vercel team ID, only if the project belongs to a team |
| `IFRAMER_API_BASE_URL`, `IFRAMER_API_KEY` | i-Framer integration for framing-fulfilment jobs |
| `STORAGE_PROVIDER` | Force `vercel-blob` or `replit` (normally auto-detected from `BLOB_READ_WRITE_TOKEN` / `PRIVATE_OBJECT_DIR`) |
| `BLOB_BASE_URL` | Blob store public base URL (skips a one-time lookup; normally unnecessary) |

Replit-only vars (`PRIVATE_OBJECT_DIR`, `REPLIT_*`, `REPL_IDENTITY`, `WEB_REPL_RENEWAL`)
are **not** needed on Vercel.

## 3. Storage backend

Image upload/serving/deletion goes through `lib/object-storage.ts`, which selects a
backend automatically:

- **Vercel Blob** when `BLOB_READ_WRITE_TOKEN` is set (uploads go browser → Blob via
  `/api/storage/blob-upload` token exchange, so large images bypass the 4.5 MB
  serverless body limit; images are stored publicly at stable URLs).
- **Replit App Storage** when `PRIVATE_OBJECT_DIR` is set (Replit dev only).

The database stores portable `/objects/uploads/<uuid>` paths either way. Note:
images uploaded in the Replit environment live in Replit storage and won't resolve
on Vercel — re-upload any artwork images you want in production (seed/demo data).

## 4. Domains & DNS

1. Vercel → Project → Settings → Domains: add `i-art.com.au`, `*.i-art.com.au`
   (wildcard needs the domain's nameservers pointed at Vercel), and `i-art.au`
   (configured to redirect to `i-art.com.au`).
2. At your registrar, switch `i-art.com.au` nameservers to the ones Vercel shows
   (required for the wildcard certificate).
3. Tenant storefronts then resolve automatically: `{slug}.i-art.com.au` is rewritten
   to `/t/{slug}` by the middleware (driven by `NEXT_PUBLIC_SITE_URL`).
4. Tenant **custom domains** (e.g. `www.janeart.com`): the tenant CNAMEs to
   `CNAME_TARGET`, and the domain must also be added to the Vercel project so
   Vercel serves it. If `VERCEL_API_TOKEN` and `VERCEL_PROJECT_ID` are set, the
   app adds the domain automatically when the tenant's CNAME check passes
   (fully self-serve). Otherwise, add it manually under Settings → Domains.

### ⚠️ Apex vs www redirect — critical production configuration

Vercel's default for a domain it doesn't recognise as primary is to redirect
`i-art.com.au` (apex) → `www.i-art.com.au`. This **breaks** two critical systems:

| System | Why it breaks |
|---|---|
| Stripe webhook | Stripe signs the payload for the exact URL you register. A 308 redirect changes the URL and Stripe does **not** follow redirects — it returns a 4xx delivery failure. |
| Vercel Cron | The cron runner hits the registered path exactly. A redirect causes the job to be silently dropped. |

**Fix — choose ONE approach:**

**Option A (recommended): Set `i-art.com.au` as the primary domain in Vercel**

1. Vercel → Project → Settings → Domains.
2. Click the `⋮` menu next to `i-art.com.au` → **Set as primary**.
3. Vercel will now redirect `www.i-art.com.au` → `i-art.com.au` (the correct direction).
4. Ensure `NEXT_PUBLIC_SITE_URL=https://i-art.com.au` (no `www`).
5. Re-register the Stripe webhook URL as `https://i-art.com.au/api/stripe/webhook`.

**Option B: Remove the `www` entry entirely**

1. Remove `www.i-art.com.au` from Vercel → Domains.
2. The apex domain is then served directly with no redirect in either direction.
3. Ensure `NEXT_PUBLIC_SITE_URL=https://i-art.com.au`.

> After changing the primary domain, send a test Stripe webhook event from the
> Stripe Dashboard and confirm it returns `200` (not `3xx`) in the webhook delivery log.

## 5. Stripe webhook

1. Stripe Dashboard → Developers → Webhooks → Add endpoint.
   - **Before DNS cutover** use the Vercel-assigned URL:
     `https://<your-project>.vercel.app/api/stripe/webhook`
   - **After DNS points to Vercel** update (or add a second endpoint) for:
     `https://i-art.com.au/api/stripe/webhook`
2. Events to subscribe to — select all six:
   `checkout.session.completed`, `checkout.session.expired`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
3. Copy the endpoint's **Signing secret** into `STRIPE_WEBHOOK_SECRET`
   (Vercel → Project → Settings → Environment Variables).
4. Ensure `STRIPE_WEBHOOK_DEV_BYPASS` is **not** set in production.
5. Send a test event from the Stripe Dashboard (e.g. `customer.subscription.created`)
   and confirm the endpoint returns `200 {"received":true}` in the webhook log.

Sales use Stripe Connect (Express): tenants onboard from Settings → Billing and are
paid into their own Stripe accounts; the platform takes the application fee.

## 6. Email delivery (SMTP)

The app uses `SMTP_HOST` for transactional email when set, and falls back to Resend
(`RESEND_API_KEY`) otherwise. For production on a real domain, SMTP via your own mail
server is strongly preferred — it lets SPF/DKIM pass automatically because the sending
domain matches your MX records.

### 6a. Provider-specific settings

**Google Workspace (smtp.gmail.com)**

| Variable | Value |
| --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` (STARTTLS on port 587) |
| `SMTP_USER` | Full Gmail/Workspace address, e.g. `orders@i-art.com.au` |
| `SMTP_PASS` | **App password** — not your account password. Generate one at Google Account → Security → 2-Step Verification → App passwords. |

SPF/DKIM: Google Workspace automatically signs outgoing mail with DKIM using your domain
once you enable it (Admin Console → Apps → Google Workspace → Gmail → Authenticate email).
SPF is set up automatically when you add Google's MX records. No extra DNS changes needed.

**Microsoft 365 / Office 365 (smtp.office365.com)**

| Variable | Value |
| --- | --- |
| `SMTP_HOST` | `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` (STARTTLS on port 587) |
| `SMTP_USER` | Full Microsoft 365 address, e.g. `orders@i-art.com.au` |
| `SMTP_PASS` | Account password, or an app password if MFA is enabled. |

SPF/DKIM: Microsoft 365 signs with DKIM by default once you publish the two CNAME records
shown in Microsoft 365 admin → Security → Email authentication.

**Domain host / generic SMTP (cPanel, Zoho, Mailgun SMTP, etc.)**

Use the SMTP credentials from your hosting panel. Port 587 + STARTTLS is standard; port
465 + TLS is also fine — set `SMTP_PORT=465` and `SMTP_SECURE=true`.
SPF/DKIM records are usually created automatically when you enable the mailbox; check your
provider's documentation.

### 6b. SPF & DKIM checklist (run before go-live)

After configuring `EMAIL_FROM` / `EMAIL_FROM_ORDERS` / `EMAIL_FROM_INQUIRIES`, send a
test message and verify alignment with a free tool such as
[mail-tester.com](https://www.mail-tester.com) or
[MXToolbox Email Health](https://mxtoolbox.com/emailhealth/):

- [ ] SPF: **pass** — the sending IP is listed in the domain's SPF record.
- [ ] DKIM: **pass** — the message is signed with a key that matches a DNS TXT record.
- [ ] DMARC: **pass** (SPF or DKIM must be aligned with the `From:` domain).
- [ ] Spam score ≤ 1 / 10 on mail-tester.com.

If SPF or DKIM fails, the email will land in spam. Fix the DNS records before go-live —
do not proceed until both checks are green.

### 6c. Test real email delivery

Set the SMTP variables in the Vercel production environment (or locally with a `.env`
file), then send a real test message for each email type:

**Order-confirmation (inquiry) email**
1. Open the live storefront (e.g. `https://jane.i-art.com.au/artwork/<slug>`).
2. Submit the contact/inquiry form with your real email address.
3. Confirm the inquiry email arrives in the gallery's inbox (not spam) and the
   `Reply-To:` header is the buyer's address.

**Order-confirmation email**
1. Complete a test checkout (use a Stripe test card, e.g. `4242 4242 4242 4242`).
2. Confirm the buyer receives the order-confirmation email in their inbox (not spam).
3. In the admin panel, mark the order as Fulfilled and add a tracking note.
4. Confirm the order-status update email arrives.

Both tests must succeed before go-live. If delivery fails, check Vercel logs for the
`SMTP error:` prefix and compare against the settings in §6a above.

## 7. Schema-drift check at build time

Every Vercel build runs `pnpm --filter @workspace/db run check-drift` **before**
`next build` (see the `build` script in `artifacts/artwork-bank/package.json`).
The check compares the Drizzle TypeScript schema against the live database and
aborts the build with a clear error if any table or column is missing.

> **⚠️ The drift check only works when `DATABASE_URL` is set in Vercel.**
> If `DATABASE_URL` is absent the check script exits 1 immediately and the
> build fails — Vercel will surface this as a build error and will not
> deploy the new code. This is intentional: a missing secret is treated as
> a hard failure, not a silent pass.

### Preview deployments and `DATABASE_URL`

Vercel creates a Preview deployment for every pull-request branch. Because the
drift check runs unconditionally, Preview deploys behave one of two ways
depending on how you configure `DATABASE_URL`:

**Option A — Skip `DATABASE_URL` on Preview (simpler, intentional failures)**

Leave `DATABASE_URL` unset in the Preview environment. Every Preview build will
fail the drift check with:

```
❌  DATABASE_URL is not set — cannot check schema drift.
    Set DATABASE_URL to the production database connection string.
```

This is **expected and intentional** — not a bug. It means no Preview build can
accidentally ship code against an unchecked database. The failure is
self-explanatory in the Vercel build log. Choose this option if you do not need
running Preview deployments (e.g. you review PRs locally or via the dev
environment in Replit).

**Option B — Dedicated Preview database (recommended for team review)**

Create a second Neon project (or a Neon branch off the main project) to act as
your Preview database. Then:

1. Apply the schema once:
   ```bash
   DATABASE_URL="<preview-neon-url>" pnpm --filter @workspace/db run push
   ```
2. In Vercel → Project → Settings → Environment Variables, add `DATABASE_URL`
   scoped to **Preview** with the preview database URL.
3. (Optional) Add `SESSION_SECRET`, `STRIPE_SECRET_KEY`, and other required vars
   scoped to Preview if you want the full app to work in Preview deploys.

Preview builds will then run the drift check against the dedicated preview
database. Because that database is never shared with production, there is no
risk of a Preview deploy affecting live data.

> **Keeping the preview database in sync:** after any PR that adds schema
> changes, run:
> ```bash
> DATABASE_URL="<preview-neon-url>" pnpm --filter @workspace/db run push
> ```
> before merging, or the next Preview build will report drift on the preview
> database just as it would on production.

### What to verify before the first deploy

- [ ] `DATABASE_URL` is set under **Vercel → Project → Settings → Environment
      Variables → Production**.
- [ ] Decide on Option A or Option B above for Preview, and configure (or
      intentionally leave unset) `DATABASE_URL` under the **Preview** scope.
- [ ] The schema has been applied to the production database:
      `DATABASE_URL=<prod-url> pnpm --filter @workspace/db run push`
- [ ] A test deploy succeeds and the build log shows
      `✅  Schema OK — N tables verified against the database.`

### CI enforcement

A GitHub Actions workflow (`.github/workflows/schema-drift-guard.yml`) runs on
every change to `package.json`, `check-drift.ts`, or the workflow file itself.
It:

1. **Asserts the build script still chains `check-drift` before `next build`** —
   fails if someone silently removes the gate.
2. **Runs `check-drift` without `DATABASE_URL` and asserts it exits 1** —
   proves the guard fires correctly when the secret is misconfigured.

No live database is needed for this CI job.

## 8. Keeping the production database schema in sync

Every code merge runs `scripts/post-merge.sh` automatically. That script already
pushes the Drizzle schema to the **dev** database. To keep the **production** Neon
database in sync with zero manual steps, add one more secret to the Replit workspace:

| Secret name | Value |
| --- | --- |
| `PROD_DATABASE_URL` | The pooled Neon connection string for production (the same value you set in Vercel's `DATABASE_URL` environment variable) |

Once set, every post-merge run will push the schema to production immediately after
pushing to dev — no extra manual step, no risk of a missing column on the live site.

### If PROD_DATABASE_URL is not set (manual path)

When `PROD_DATABASE_URL` is absent the post-merge script prints a reminder and skips
the production push. In that case you must run it manually from your local machine
(or the Replit shell with the correct var set) before each deploy that adds columns
or tables:

```bash
DATABASE_URL="<production-neon-url>" pnpm --filter @workspace/db run push-force
```

### Why `push-force`?

`drizzle-kit push` prompts for confirmation in interactive terminals, which causes
the post-merge script to fail immediately (stdin is closed). `push-force` suppresses
the prompt and applies changes unconditionally — safe because Drizzle only ever adds
columns and tables, never drops them.

### Verifying the sync

After a merge that adds schema, confirm the production database was updated:

```bash
# From Neon console or any Postgres client pointed at the production DATABASE_URL:
SELECT column_name FROM information_schema.columns
  WHERE table_name = '<changed_table>';
```

The new columns must appear. If they do not, run the manual command above and
investigate why `PROD_DATABASE_URL` is not reaching the post-merge script.

## 9. Verify after deploy

- `pnpm run build` succeeds locally from `artifacts/artwork-bank/` (same build Vercel runs).
- Log in, upload an artwork image, confirm it renders on the storefront, delete it.
- Real inquiry email delivered to gallery inbox — see §6c above.
- Real order-confirmation email delivered to buyer inbox — see §6c above.
- SPF + DKIM both **pass** on mail-tester.com for the `EMAIL_FROM` domain — see §6b above.
- `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://i-art.com.au/api/email-sweep`
  returns JSON (and Vercel → Crons shows successful runs).
- A test checkout completes and the webhook creates the order.
