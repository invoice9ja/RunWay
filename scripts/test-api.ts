/**
 * Local harness for the Vercel serverless handlers in artifacts/runway/api.
 * Run with:  pnpm exec tsx scripts/test-api.ts
 *
 * It boots a throwaway HTTP server on localhost, points the handlers at it via
 * the standard x-forwarded-host / x-forwarded-proto headers, and exercises the
 * full x402 loop against the real Base Sepolia chain.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { config } from '../artifacts/runway/api/_lib/config';
import type { Handler, Req, Res } from '../artifacts/runway/api/_lib/http';

const routes: Record<string, Handler> = {
  '/api/status': (await import('../artifacts/runway/api/status')).default,
  '/api/keeper': (await import('../artifacts/runway/api/keeper')).default,
  '/api/x402/resource': (await import('../artifacts/runway/api/x402/resource')).default,
  '/api/demo/buy': (await import('../artifacts/runway/api/demo/buy')).default,
};

let boundPort = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404).end('no route');
    return;
  }

  const query: Record<string, string | string[] | undefined> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const authority = `127.0.0.1:${boundPort}`;

  const mockReq = {
    method: req.method,
    url: req.url,
    headers: {
      ...req.headers,
      'x-forwarded-proto': 'http',
      'x-forwarded-host': authority,
      host: authority,
    } as Record<string, string | string[] | undefined>,
    query,
  } as Req;

  const mockRes = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      res.writeHead(this.statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return this;
    },
    send(body: unknown) {
      res.writeHead(this.statusCode);
      res.end(String(body));
      return this;
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
      return this;
    },
    end() {
      res.end();
    },
  } as unknown as Res;

  Promise.resolve(handler(mockReq, mockRes)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ harnessError: String(error) }, null, 2));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
boundPort = port;
const origin = `http://127.0.0.1:${port}`;

console.log(`harness listening on ${origin}`);
console.log(`network: ${config.network} (chain ${config.chainId})`);
console.log(`splitter: ${config.splitter}`);
console.log(`signer configured: ${config.settlerKey ? 'yes' : 'no'}`);
console.log(`keeper secret configured: ${config.keeperSecret ? 'yes' : 'no'}`);

const target = process.argv[2] ?? '/api/status';
const authorized = process.argv.includes('--auth');
const headers: Record<string, string> = { accept: 'application/json' };
if (authorized) headers['x-keeper-secret'] = config.keeperSecret;

const response = await fetch(`${origin}${target}`, { headers });
console.log(`\nGET ${target} -> ${response.status} ${response.statusText}`);
for (const [key, value] of response.headers) {
  if (key === 'x-payment' || key === 'x-payment-response') {
    console.log(`  ${key}: <base64 ${String(value).length} chars>`);
  } else {
    console.log(`  ${key}: ${value}`);
  }
}
const text = await response.text();
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}

server.close();
