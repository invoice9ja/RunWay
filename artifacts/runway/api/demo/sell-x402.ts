import { baseUrl, type Handler } from '../_lib/http.js';
import { config, formatUsdc } from '../_lib/config.js';

/**
 * Payment requirements, published without payment.
 *
 * A buyer needs to price a call before deciding to pay it. This is the same
 * challenge the seller returns on an unpaid request, so a client that reads this
 * and then pays cannot be surprised by the price.
 *
 * It lives at its own path rather than under /api/demo/sell because a Vercel
 * function is routed at exactly the file's path; subpaths do not reach it.
 */

const PRICE = 100_000n; // 0.1 USDC

const handler: Handler = async (req, res) => {
  const origin = baseUrl(req);

  // An authorization cost must not be cached: the buyer derives the payment
  // address, token, EIP-712 domain, and price from this response. Serving a
  // stale copy after a redeploy would make the page approve and sign against
  // addresses that are no longer live.
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    x402Version: 1,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'exact',
        network: config.network,
        maxAmountRequired: PRICE.toString(),
        resource: `${origin}/api/demo/sell`,
        description: 'Hosted Runway seller',
        mimeType: 'application/json',
        payTo: config.splitter,
        maxTimeoutSeconds: 300,
        asset: config.usdc,
        extra: { name: 'USDC', version: '2' },
      },
    ],
    seller: {
      address: config.splitter,
      explorer: `${config.explorer}/address/${config.splitter}`,
    },
    price: `${formatUsdc(PRICE)} USDC`,
  });
};

export default handler;