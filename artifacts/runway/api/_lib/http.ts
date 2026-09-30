export type Req = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query: Record<string, string | string[] | undefined>;
};

export type Res = {
  status(code: number): Res;
  json(body: unknown): Res;
  send(body: unknown): Res;
  setHeader(name: string, value: string): Res;
  end(): void;
};

export type Handler = (req: Req, res: Res) => Promise<void> | void;

export function header(req: Req, name: string): string {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

export function baseUrl(req: Req): string {
  const host = header(req, 'x-forwarded-host') || header(req, 'host');
  const proto = header(req, 'x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}
