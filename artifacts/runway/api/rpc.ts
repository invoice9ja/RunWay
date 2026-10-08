import { config } from './_lib/config.js';
import type { Handler } from './_lib/http.js';

/**
 * Same-origin RPC passthrough.
 *
 * The browser wallet connection used to hold a publicClient that POSTed straight
 * to the Arc RPC. That endpoint is blocked for cross-origin web pages, so every
 * read failed with viem's "Failed to fetch". This relay lets the page stay on
 * its origin and does the RPC call server-side, which is not subject to page
 * CORS. It is deliberately thin: a POST is forwarded, the JSON-RPC response is
 * returned, and everything is `no-store`.
 */
const handler: Handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  let body = req.body;
  if (body === undefined || body === null || body === '') {
    res.status(400).json({ error: 'empty body' });
    return;
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);

  try {
    const upstream = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity',
      },
      body: payload,
      cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    });
    const text = await upstream.text();
    try {
      res.status(upstream.status).json(JSON.parse(text));
    } catch {
      res.status(upstream.status).send(text);
    }
  } catch (error) {
    res.status(502).json({ error: `rpc unreachable: ${(error as Error).message}` });
  }
};

export default handler;