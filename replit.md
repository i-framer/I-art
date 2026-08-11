# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `PLATFORM_ADMIN_EMAILS` — comma-separated allowlist of platform-owner emails; grants access to `/platform` (tenant billing comp page) in Artwork Bank. Unset = nobody has access (fails closed)
- Optional env: `SLACK_BILLING_ALERTS_CHANNEL` — channel name (e.g. `#billing-alerts`) or Slack channel ID (e.g. `C0123456789`) for billing-alert Slack messages; unset = Slack alerts silently disabled. Requires the Slack OAuth connector wired via Replit Integrations.
- Optional env: `UPLOAD_READ_TIMEOUT_MS` — per-chunk stall deadline for `POST /api/storage/upload`, in milliseconds (default `30000` = 30 s). If a single stream read does not complete within this window the upload is aborted with HTTP 408. Tighten to defend against slow-loris clients; relax for high-latency hosts. Integration tests set this to `2000`.
- See `artifacts/artwork-bank/.env.example` for the full list of env vars with descriptions

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

- **Never estimate or state human developer hours** (owner instruction, Aug 2026). Commit timestamps, task counts, and session windows measure agent working time only — starting/applying a task is a single click and the system does not record who clicked or how long they spent. When reporting activity: list agent time and deliverables, and attribute human involvement only as "requests/planning made by conversation" (what a user actually asked for), never as time estimates. Human hours come solely from a person's own log (`WORK_LOG.md`).

- **Live-server test checklist reminder** (owner instruction, Aug 2026): `LIVE_SERVER_TEST_CHECKLIST.md` (repo root) tracks manual production tests. On the FIRST interaction of each day with info11925 or ggodin, show the outstanding (unchecked) items as a reminder — until all are complete. When a new feature or fix ships that needs live verification, add a test item to that file in the same change. Update checkboxes when the user reports results in chat.

## Gotchas

- **Never commit credential screenshots.** Uploaded screenshots land in `attached_assets/` and get auto-committed. `.gitignore` blocks filenames containing token/secret/credential/password/api-key patterns, and `scripts/check-sensitive-assets.sh` (installed as a pre-push hook via `bash scripts/install-git-hooks.sh`) scans outgoing commits for credential-like asset filenames and secret-looking strings. **Always run `bash scripts/check-sensitive-assets.sh origin/main` before any manual push to GitHub.** After a fresh clone/workspace, re-run `bash scripts/install-git-hooks.sh` (`.git/hooks` is not versioned). If a screenshot of a live credential was ever committed, rewrite local history to remove the blob before pushing and rotate the credential.

## Pointers

- `HANDOVER.md` (repo root) — developer handover: goal, stack, what's built, pricing model, hosting plan, getting started
- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
