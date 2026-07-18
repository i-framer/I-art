---
name: Stripe testing in isolated task environments
description: How to verify Stripe checkout/webhook flows when connector credentials are withheld
---

In isolated task environments, the Replit Stripe connector API (`/api/v2/connection?include_secrets=true`) can return 0 items even though the connection shows `added` — credentials are withheld, for both the sandbox and the running dev server. Live Stripe API calls (creating checkout sessions, connected accounts) will fail with "Stripe integration not connected".

**How to apply:** Verify what you can without credentials:
- Routing: hitting the endpoint should return an app-level 400/500 JSON error, not a 404 from another service.
- Webhook pipeline: set `STRIPE_WEBHOOK_DEV_BYPASS=true` (development env) and POST a synthetic `checkout.session.completed` event with real DB metadata; confirm order/artwork mutations in the DB. Delete the env var and test rows afterwards.
- Leave live end-to-end payment verification to the main workspace where credentials resolve.

**Why:** Avoids burning attempts on credential fetches that can never succeed in this context.
