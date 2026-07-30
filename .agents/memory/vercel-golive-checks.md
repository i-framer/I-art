---
name: Vercel go-live checks
description: Auditing the i-art.com.au Vercel production deployment without Vercel dashboard/API access
---
No VERCEL_API_TOKEN is available in task envs, so Vercel env vars/logs can't be read directly. Instead, probe the live app: the API routes return explicit error messages that reveal which env vars are unset (e.g. email-sweep 403 names CRON_SECRET, webhook 400 names STRIPE_WEBHOOK_SECRET); app-wide SSR 500s indicate DATABASE_URL missing/broken.
**Why:** avoids guessing and lets a go-live audit produce concrete pass/fail without operator access.
**How to apply:** curl the apex + www + a tenant subdomain, /api/stripe/webhook (POST), /api/email-sweep, /api/reservation-sweep. Watch for Vercel domain-level 308s — as of Jul 2026 Vercel redirected apex→www while the app expects apex-canonical (NEXT_PUBLIC_SITE_URL), which silently breaks Stripe webhooks and crons pointed at the apex. Stripe live key (secret `stripe_secret_key`) works from task envs for webhook-endpoint CRUD.
