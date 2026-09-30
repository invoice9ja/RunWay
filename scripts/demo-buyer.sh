#!/bin/bash

# Demo Buyer - Generates x402 payments to the splitter
# Run: ./demo-buyer.sh

set -e

# Never hardcode a key. Load it from the environment or an untracked .env.
if [ -z "${RUNWAY_PRIVATE_KEY:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
  set -a; . "$(dirname "$0")/../.env"; set +a
fi
: "${RUNWAY_PRIVATE_KEY:?Set RUNWAY_PRIVATE_KEY (or add it to .env) before running this script}"

RPC_URL="https://sepolia.base.org"
PRIVATE_KEY="${RUNWAY_PRIVATE_KEY:-}"
SPLITTER_ADDRESS="0x96030e714e14b848445b40dfc327d828a3f474f6"
USDC_ADDRESS="0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYMENT_AMOUNT=100000  # 0.1 USDC (6 decimals)
INTERVAL=60  # seconds between payments

echo "Starting Demo Buyer"
echo "Splitter: $SPLITTER_ADDRESS"
echo "Payment amount: $PAYMENT_AMOUNT USDC (6 decimals) = $(echo "scale=6; $PAYMENT_AMOUNT / 1000000" | bc) USDC"
echo "Interval: ${INTERVAL}s"
echo ""

# Check USDC balance
BALANCE_RAW=$(cast call $USDC_ADDRESS "balanceOf(address)" $SPLITTER_ADDRESS --rpc-url https://sepolia.base.org 2>/dev/null)
BALANCE=$(cast --to-dec $BALANCE_RAW)
echo "Splitter USDC balance: $(echo "scale=6; $BALANCE / 1000000" | bc) USDC"

# Check buyer USDC balance
BUYER_BALANCE_RAW=$(cast call $USDC_ADDRESS "balanceOf(address)" 0xe81e8078f2D284C92D6d97B5d4769af81e0cA11C --rpc-url https://sepolia.base.org 2>/dev/null)
BUYER_BALANCE=$(cast --to-dec $BUYER_BALANCE_RAW)
echo "Buyer USDC balance: $(echo "scale=6; $BUYER_BALANCE / 1000000" | bc) USDC"

# Approve USDC for direct transfer (if needed)
# For demo, we just transfer USDC directly to splitter
# In real x402, the facilitator handles this

make_payment() {
  echo ""
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Making payment of $PAYMENT_AMOUNT USDC to splitter..."
  
  # Transfer USDC to splitter (simulating facilitator payment)
  TX_HASH=$(cast send $USDC_ADDRESS "transfer(address,uint256)" $SPLITTER_ADDRESS $PAYMENT_AMOUNT --private-key $PRIVATE_KEY --rpc-url https://sepolia.base.org 2>&1 | grep "transactionHash" | head -1)
  
  if [ -n "$TX_HASH" ]; then
    echo "✓ Payment sent: $TX_HASH"
    
    # Check splitter balance after payment
    BALANCE_RAW=$(cast call $USDC_ADDRESS "balanceOf(address)" $SPLITTER_ADDRESS --rpc-url https://sepolia.base.org 2>/dev/null)
    BALANCE=$(cast --to-dec $BALANCE_RAW)
    echo "Splitter balance: $(echo "scale=6; $BALANCE / 1000000" | bc) USDC"
  else
    echo "✗ Payment failed"
  fi
}

# Run immediately
make_payment

# Then run on interval
while true; do
  sleep 60
  make_payment
done