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

  res.setHeader('Cache-Control', 'public, max-age=60');
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