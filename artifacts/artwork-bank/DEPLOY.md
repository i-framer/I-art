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
| `DATABASE_URL` | Postgres connection string | Your Postgres provider (Neon recommended — create a project at neon.tech and copy the pooled connection string). Apply the schema with `DATABASE_URL=... pnpm --filter @workspace/db run push` from your machine. |
| `SESSION_SECRET` | iron-session cookie encryption key (32+ chars) | Generate: `openssl rand -base64 32` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store token — enables the portable image-storage backend | Vercel → Storage → Create Blob store → connect to the project (token is injected automatically) |
| `NEXT_PUBLIC_SITE_URL` | Canonical production URL, e.g. `https://i-art.com.au` | You choose it. Also drives tenant-subdomain routing (`{slug}.i-art.com.au`). Production only — leave unset on previews so `VERCEL_URL` is used. |
| `STRIPE_SECRET_KEY` | Stripe platform account secret key (`sk_live_...`) | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the production webhook endpoint | Created in step 5 below |
| `RESEND_API_KEY` | Transactional email (Resend) | resend.com → API Keys |
| `CRON_SECRET` | Protects the sweep endpoints invoked by Vercel cron | Generate: `openssl rand -hex 32`. Vercel automatically sends it on cron requests when set. |

### Recommended / optional

| Variable | Description |
| --- | --- |
| `EMAIL_SWEEP_SECRET` | Extra Bearer secret accepted by `POST/GET /api/email-sweep` for manual/external triggering (CRON_SECRET also works) |
| `RESERVATION_SWEEP_SECRET` | Same, for `/api/reservation-sweep` |
| `EMAIL_FROM`, `EMAIL_FROM_ORDERS`, `EMAIL_FROM_INQUIRIES` | From-addresses for outgoing email (must be on a Resend-verified domain, e.g. `orders@i-art.com.au`) |
| `SUBSCRIPTION_PRICE_ID` | Pin the AUD $10/month subscription price; otherwise a price is auto-created with lookup key `artwork_bank_monthly_v1` |
| `PLATFORM_FEE_PERCENT` | Sales commission percent (default `5`) |
| `CNAME_TARGET` | DNS target shown to tenants for custom domains (set to `cname.vercel-dns.com` on Vercel) |
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
   `CNAME_TARGET`, and the domain must also be added to the Vercel project
   (Settings → Domains) so Vercel serves it. Automatic provisioning via the Vercel
   API is a separate planned task.

## 5. Stripe webhook

1. Stripe Dashboard → Developers → Webhooks → Add endpoint:
   `https://i-art.com.au/api/stripe/webhook`
2. Events: `checkout.session.completed`, `checkout.session.expired`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
3. Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Ensure `STRIPE_WEBHOOK_DEV_BYPASS` is **not** set in production.

Sales use Stripe Connect (Express): tenants onboard from Settings → Billing and are
paid into their own Stripe accounts; the platform takes the application fee.

## 6. Verify after deploy

- `pnpm run build` succeeds locally from `artifacts/artwork-bank/` (same build Vercel runs).
- Log in, upload an artwork image, confirm it renders on the storefront, delete it.
- `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://i-art.com.au/api/email-sweep`
  returns JSON (and Vercel → Crons shows successful runs).
- A test checkout completes and the webhook creates the order.
