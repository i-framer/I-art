---
name: GitHub push via token
description: How to push this workspace to github.com/i-framer/I-art when Replit's GitHub connection is unavailable
---
Replit's built-in GitHub connection (`gitPush`) returns NO_CREDENTIALS in this workspace, so pushes use the `GITHUB_PUSH_TOKEN` secret (fine-grained PAT, i-framer/I-art, Contents RW).

**How to apply:** temporary GIT_ASKPASS script echoing `$GITHUB_PUSH_TOKEN`, then `git push https://x-access-token@github.com/i-framer/I-art.git main`. Never put the token in the remote URL or command line. `origin` remote is set to the plain https URL.

**Why:** user's Git pane showed no "Connect to GitHub" option; token flow was the working fallback (July 2026).
