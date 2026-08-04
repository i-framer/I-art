---
name: CI pnpm version must match lockfile writer
description: Frozen installs in GitHub Actions fail if the pnpm major version differs from the one that wrote pnpm-lock.yaml
---

The workspace uses pnpm 10 locally (it writes pnpm-lock.yaml). GitHub Actions workflows must pin pnpm 10 in `pnpm/action-setup`, not 9.

**Why:** pnpm 9 and 10 normalize the `overrides` field differently, so `pnpm install --frozen-lockfile` under pnpm 9 fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` even though the lockfile is valid. This made the scheduled schema-drift check email a "failure" that was really an install error, not drift.

**How to apply:** When adding any new GitHub Actions workflow, set `pnpm/action-setup` `version: 10` (or match whatever pnpm major the workspace uses — check `pnpm --version` locally). A CI failure in the first seconds of a job is usually toolchain mismatch, not the check itself — read the run logs via the GitHub API before assuming the check's subject failed.
