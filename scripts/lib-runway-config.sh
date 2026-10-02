#!/usr/bin/env bash
# Shared configuration for the demo and keeper scripts.
#
# Addresses come from deployed-testnet.json, never from a literal in a script.
# These scripts previously hardcoded Base Sepolia plus a splitter from an
# abandoned deployment, so they silently read the wrong chain and swallowed
# every error with 2>/dev/null. Anything reading config resolves it here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "No .env found. Copy .env.example to .env first." >&2
  exit 1
fi

if [ -f .env ]; then
  set -a; . "$REPO_ROOT/.env"; set +a
fi

MANIFEST="${RUNWAY_MANIFEST:-$REPO_ROOT/deployed-testnet.json}"

if [ ! -f "$MANIFEST" ]; then
  echo "Deployment manifest not found: $MANIFEST" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  _j() { jq -r "$1" "$MANIFEST"; }
else
  # Minimal fallback so the scripts work without jq installed.
  _j() {
    python3 - "$MANIFEST" "$1" <<'PY'
import json, re, sys
path, expr = sys.argv[1], sys.argv[2]
key = expr.strip()
m = re.match(r'^\.(\w+)$', key)
with open(path) as fh:
    data = json.load(fh)
if m:
    print(data[m.group(1)])
else:
    raise SystemExit(f'unsupported key: {expr}')
PY
  }
fi

NETWORK="${RUNWAY_NETWORK:-$(_j .network)}"
CHAIN_ID="${RUNWAY_CHAIN_ID:-$(_j .chainId)}"
RPC_URL="${ARC_TESTNET_RPC:?ARC_TESTNET_RPC is not set}"
USDC="$(_j .usdc)"
VAULT="$(_j .vault)"
FACTORY="$(_j .factory)"
SPLITTER="$(_j .splitter)"
EXPLORER="${RUNWAY_EXPLORER_URL:-$(_j .explorer)}"

# Base URL of the hosted dashboard, for the x402 flows.
RUNWAY_URL="${RUNWAY_URL:-https://runwaay-ivory.vercel.app}"

require_key() {
  local var="$1" hint="$2"
  if [ -z "${!var:-}" ]; then
    echo "$var is not set. $hint" >&2
    exit 1
  fi
}

# `cast call` is inconsistent about how it prints integers. Small values come
# back as decimal with a human annotation ("100000 [1e5]"), larger ones as hex
# ("0x0000...030d40"). It also switches between the two for the same value
# depending on the function, so normalise rather than assume either form.
#
# Getting this wrong is not obvious: parsing "100000" as hex yields 1048576,
# which is a plausible-looking but wrong USDC amount, and parsing hex as decimal
# yields zero.
strip() { sed 's/ *\[[^]]*\]//g' | tr -d '[:space:]'; }

# Normalise a cast value to a plain decimal integer.
to_dec() {
  python3 -c "
v = '$1'.strip()
print(int(v, 16) if v.lower().startswith('0x') else int(v))
" 2>/dev/null || echo 0
}

usdc_fmt() { python3 -c "print(f'{$(to_dec "$1")/10**6:.6f}')" 2>/dev/null || echo "?"; }

# Compare a cast value against a threshold. Returns 0 (true) when value >= threshold.
gte() {
  python3 -c "import sys; sys.exit(0 if $(to_dec "$1") >= $(to_dec "$2") else 1)"
}

banner() {
  echo "  network   $NETWORK (chain $CHAIN_ID)"
  echo "  rpc       $RPC_URL"
  echo "  vault     $VAULT"
  echo "  factory   $FACTORY"
  echo "  splitter  $SPLITTER"
  echo "  usdc      $USDC"
  echo "  app       $RUNWAY_URL"
  echo
}