# Artwork Bank — Operator Runbook

This document covers maintenance procedures that require manual operator steps.
Run the smoke scripts after each procedure to confirm the system is healthy.

---

## Slack connector reconnect

**When to use:** The Replit Slack connector has been revoked, expired, or
reconnected via the Replit Integrations panel (e.g. after rotating workspace
credentials, after a Slack workspace admin revokes the app, or during routine
maintenance).

### Why this matters

Billing alerts are posted to Slack via the Replit connectors SDK
(`artifacts/artwork-bank/lib/slack.ts → sendBillingAlertSlackNotification`).
The SDK proxies calls through `connectors.replit.com` using an OAuth token
that is bound to this specific Repl. Revoking and re-granting access issues a
new token; the server must be restarted to pick it up, and the delivery path
must be verified end-to-end.

### Steps

#### 1 — Revoke the current token *(skip if the token is already revoked)*

1. Open the Replit workspace for this project.
2. Navigate to **Tools → Integrations** (or the Integrations side-panel).
3. Find the **Slack** connector and click **Disconnect** / **Revoke**.
4. Confirm the connector status changes to **"Not connected"**.

#### 2 — Re-grant access

1. In the same Integrations panel, click **Connect** on the Slack connector.
2. Complete the Slack OAuth flow in the popup (authorize the workspace and bot
   scopes).
3. Confirm the connector status returns to **"Connected"**.

#### 3 — Restart the server

Restart the Artwork Bank dev server so it picks up the refreshed credentials:

```bash
# Via Replit workflow restart button:
#   Replit UI → Workflows → "artifacts/artwork-bank: web" → Restart

# Or from the shell:
pnpm --filter @workspace/artwork-bank dev
```

#### 4 — Run the integration smoke test

**Option A — GitHub Actions (recommended after any reconnect):**

Trigger the `slack-reconnect-smoke` workflow from the GitHub Actions UI:

1. Open the repository on GitHub.
2. Navigate to **Actions → Slack reconnect smoke test**.
3. Click **Run workflow** (top right of the workflow list).
4. Optionally enter the deployed app URL if `ARTWORK_BANK_URL` is not set as a
   repository secret.
5. Click **Run workflow** to start the job.

The workflow calls `POST /api/slack-smoke` on the deployed app, which exercises
both `sendBillingAlertSlackNotification` and `sendIframerAccountSlackNotification`
against the live connector. Pass/fail is reported in the workflow run summary.

Required repository secrets (set once under **Settings → Secrets → Actions**):
- `ARTWORK_BANK_URL` — base URL of the deployed app (e.g. `https://your-app.vercel.app`)
- `SLACK_SMOKE_SECRET` — must match the `SLACK_SMOKE_SECRET` (or `CRON_SECRET`)
  env var set in the deployed app. Omit both if the endpoint is open (dev only).

The workflow also runs automatically every Monday at 07:00 UTC so silent
regressions between reconnects are caught without manual intervention.

**Option B — curl the probe endpoint directly:**

```bash
curl -sf -X POST \
  -H "Authorization: Bearer YOUR_SLACK_SMOKE_SECRET" \
  https://your-app.vercel.app/api/slack-smoke \
| jq .
```

Expected response on success: `{ "ok": true, "results": [...] }`

**Option C — vitest integration test (Replit shell only):**

The `sendBillingAlertSlackNotification` and `sendIframerAccountSlackNotification`
paths can also be verified via the vitest smoke test — but this requires the
Replit connectors SDK to be available, so it must run in the Replit workspace
shell (not in GitHub Actions):

```bash
SLACK_INTEGRATION_TEST=true \
SLACK_BILLING_ALERTS_CHANNEL=#your-channel \
  pnpm --filter @workspace/artwork-bank test -- --reporter=verbose slack-reconnect-smoke
```

Replace `#your-channel` with the channel name or ID stored in
`SLACK_BILLING_ALERTS_CHANNEL`. The test is skipped unless
`SLACK_INTEGRATION_TEST=true` is explicitly set, so it never runs in CI by
accident.

Alternatively, run the full end-to-end smoke script (fires a synthetic Stripe
webhook and checks the database, email, and Slack):

```bash
SLACK_BILLING_ALERTS_CHANNEL=#your-channel \
  pnpm --filter @workspace/artwork-bank smoke:billing-alert
```

#### 5 — Verify in Slack

Open the channel and look for a new message beginning with:

```
🚨 Unmatched Stripe billing event (customer.subscription.updated)
```

It should appear within a few seconds of the script completing.

#### 6 — Verify in the server logs

Check the workflow console (**Replit → workflow logs for artwork-bank**) for
the **absence** of `[Billing alert Slack] Post failed` lines. A successful
post produces no error output.

### Troubleshooting

| Error in logs | Likely cause | Fix |
|---|---|---|
| `Post failed … not_in_channel` | Bot was removed from the channel | `/invite @<bot-name>` in Slack |
| `Post failed … invalid_auth` | Token still expired / OAuth incomplete | Repeat Step 2 |
| `Post failed … channel_not_found` | Channel name/ID wrong or bot can't see it | Verify `SLACK_BILLING_ALERTS_CHANNEL` and bot membership |
| No Slack section in script output | `SLACK_BILLING_ALERTS_CHANNEL` not set | Export the variable before running (Step 4) |
| Message not in channel despite no errors | Bot posted to a different channel | Double-check the env var value matches the intended channel |

### Print the runbook from the smoke script

```bash
pnpm --filter @workspace/artwork-bank smoke:billing-alert -- --reconnect-runbook
```

This prints the reconnect steps and exits without running the smoke test.

---

## See also

- `artifacts/artwork-bank/scripts/smoke-billing-alert.ts` — full smoke-test
  entry point with the reconnect runbook embedded in its header comment.
- `artifacts/artwork-bank/lib/slack.ts` — `sendBillingAlertSlackNotification`
  and `resolveSlackChannel` implementation.
