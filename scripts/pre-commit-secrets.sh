#!/bin/sh
# Block commits that would publish a secret.
#
# Inspects the staged content, so it catches anything about to enter the index.
# Run `node scripts/scan-secrets.mjs` to audit the whole tree and history.
#
# This copy lives at .git/hooks/pre-commit, which git does not version control.
# To restore it after a fresh clone:
#   cp scripts/pre-commit-secrets.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
SCANNER="$REPO_ROOT/scripts/scan-secrets.mjs"

if [ ! -f "$SCANNER" ]; then
  echo "pre-commit: scanner missing at $SCANNER, skipping secret check" >&2
  exit 0
fi

if [ -z "$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)" ]; then
  exit 0
fi

if node "$SCANNER" --staged; then
  exit 0
fi

echo "" >&2
echo "Commit blocked: a secret was detected in the staged content." >&2
echo "Put it in .env (already gitignored) or in Vercel env vars instead." >&2
echo "Bypass only if you are certain it is a false positive:" >&2
echo "  git commit --no-verify" >&2
exit 1
