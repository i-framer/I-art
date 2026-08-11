#!/usr/bin/env bash
# Pre-push safeguard: block pushes that would publish credential screenshots
# or secret-looking strings to the remote.
#
# Installed as .git/hooks/pre-push (see scripts/install-git-hooks.sh).
# Can also be run manually before any push:
#   bash scripts/check-sensitive-assets.sh <remote-ref-to-compare>  (default: origin/main)
#
# Background: a screenshot of a GitHub personal access token was once
# auto-committed into attached_assets/ and nearly pushed to the public repo.
# This scan is the last line of defense; .gitignore patterns for
# attached_assets/*token*, *secret*, etc. are the first.

set -u

# Filename patterns (case-insensitive) that indicate a credential screenshot/file.
NAME_PATTERN='(token|secret|credential|password|api[-_]?key|access[-_]?key|\.env|\.pem|private[-_]?key)'

# Content patterns for well-known secret formats in text diffs.
CONTENT_PATTERN='(github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN[ A-Z]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{25,})'

fail=0

check_range() {
  local range="$1"

  # 1) Files added/modified in the outgoing range whose names look sensitive.
  local bad_names
  bad_names=$(git diff --name-only --diff-filter=AM "$range" -- 'attached_assets/' \
    | grep -iE "$NAME_PATTERN" || true)
  if [ -n "$bad_names" ]; then
    echo "BLOCKED: outgoing commits add files under attached_assets/ with credential-like names:" >&2
    echo "$bad_names" | sed 's/^/  - /' >&2
    fail=1
  fi

  # 2) Secret-looking strings in outgoing text diffs (excluding this script itself).
  local bad_content
  bad_content=$(git diff "$range" -- . ':(exclude)scripts/check-sensitive-assets.sh' \
    | grep -E '^\+' | grep -oE "$CONTENT_PATTERN" | sort -u || true)
  if [ -n "$bad_content" ]; then
    echo "BLOCKED: outgoing commits contain strings that look like live secrets:" >&2
    echo "$bad_content" | sed -E 's/^(.{12}).*/  - \1… (redacted)/' >&2
    fail=1
  fi
}

if [ -t 0 ] || [ -n "${1:-}" ]; then
  # Manual invocation: compare against a given ref (default origin/main).
  base="${1:-origin/main}"
  if git rev-parse --verify -q "$base" >/dev/null; then
    check_range "$base..HEAD"
  else
    echo "warning: ref '$base' not found; scanning last 50 commits" >&2
    check_range "HEAD~50..HEAD"
  fi
else
  # Hook invocation: git feeds "<local-ref> <local-sha> <remote-ref> <remote-sha>" on stdin.
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -z "${local_sha:-}" ] && continue
    if echo "$local_sha" | grep -q '^0*$'; then continue; fi # branch deletion
    if echo "${remote_sha:-}" | grep -q '^0*$'; then
      range="$local_sha --not --remotes" # new branch: scan commits not on any remote
      check_range "$range"
    else
      check_range "$remote_sha..$local_sha"
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'

Push aborted. Remove the sensitive file/string from the outgoing commits
(git rm + history rewrite if already committed), then push again.
If a real secret was exposed, rotate it.
EOF
  exit 1
fi

exit 0
