#!/usr/bin/env bash
# Install repo git hooks. Run once per fresh clone/workspace:
#   bash scripts/install-git-hooks.sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .git/hooks
cat > .git/hooks/pre-push <<'EOF'
#!/usr/bin/env bash
exec bash "$(git rev-parse --show-toplevel)/scripts/check-sensitive-assets.sh"
EOF
chmod +x .git/hooks/pre-push scripts/check-sensitive-assets.sh
echo "pre-push hook installed (runs scripts/check-sensitive-assets.sh)"
