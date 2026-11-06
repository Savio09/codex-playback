import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resumeCommand } from './commands.js';
import { handoffCommand } from './chatgpt.js';
import { errorCode, errorMessage } from '../shared/values.js';
import type { HistoryStore } from './history.js';
import type { ListResponse, SessionResponse, Shell } from '../shared/types.js';

export interface RequestLike {
  headers: IncomingHttpHeaders;
  url?: string | undefined;
  method?: string | undefined;
  resume(): unknown;
}
export interface ResponseLike {
  setHeader(name: string, value: string): unknown;
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string | Buffer): unknown;
}
interface HandlerOptions {
  store: HistoryStore;
  token: string;
  origin: string;
  demo?: boolean;
}

const assets = new Map<string, readonly [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/render.js', ['render.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['/floating-resume.js', ['floating-resume.js', 'text/javascript; charset=utf-8']],
  ['/shared/values.js', ['../shared/values.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/fonts/Inter-Regular.ttf', ['fonts/Inter-Regular.ttf', 'font/ttf']],
  ['/fonts/Inter-Medium.ttf', ['fonts/Inter-Medium.ttf', 'font/ttf']],
  ['/fonts/OFL.txt', ['fonts/OFL.txt', 'text/plain; charset=utf-8']],
]);
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
function equalToken(value: unknown, token: string): boolean {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token))
  );
}
function integer(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const value = params.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max || (name === 'limit' && Number(value) === 0))
    throw new Error(`Invalid ${name}`);
  return Number(value);
}

export function createHandler({ store, token, origin, demo = false }: HandlerOptions) {
  const cookieName = `playback_${new URL(origin).port}`;
  return async (req: RequestLike, res: ResponseLike): Promise<void> => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        return json(403, { error: 'This app only accepts requests from its local browser page.' });
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/api/unlock' && req.method === 'POST') {
        req.resume();
        if (!equalToken(req.headers.authorization?.replace(/^Bearer /, ''), token))
          return json(401, { error: 'Open the access link printed in your terminal.' });
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json(200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        const cookie = req.headers.cookie
          ?.split(';')
          .map((c) => c.trim())
          .find((c) => c.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        if (!equalToken(cookie, token))
          return json(401, { error: 'Open the access link printed in your terminal to connect.' });
        if (url.pathname === '/api/refresh' && req.method === 'POST') {
          req.resume();
          await store.refresh();
          return json(200, { ok: true, status: store.status });
        }
        if (req.method !== 'GET') return json(405, { error: 'Method not allowed.' });
        const params = url.searchParams;
        const offset = integer(params, 'offset', 0, 10000000);
        const limit = integer(params, 'limit', 50, 100);
        if (url.pathname === '/api/sessions') {
          const q = params.get('q') ?? '';
          const project = params.get('project') ?? '';
          const archive = params.get('archive') ?? 'active';
          const sort = params.get('sort') ?? 'newest';
          if (
            q.length > 500 ||
            project.length > 4096 ||
            (archive !== 'active' && archive !== 'archived' && archive !== 'all') ||
            (sort !== 'newest' && sort !== 'oldest' && sort !== 'title')
          )
            return json(400, { error: 'Invalid search or filter.' });
          return json(200, {
            ...store.list({ q, project, archive, sort, offset, limit }),
            demo,
            sourcePath: store.home,
          } satisfies ListResponse);
        }
        const match = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]{8,128})$/);
        if (match?.[1]) {
          const session = await store.detail(match[1], { offset, limit });
          if (!session)
            return json(404, { error: 'Conversation not found. Refresh your history and try again.' });
          const commandSession = { ...session, codexHome: store.home };
          let commands: Record<Shell, string>;
          if (session.kind === 'chatgpt') {
            const exportFile = store.chatgptExport;
            if (!exportFile) throw new Error('Missing ChatGPT export for imported conversation');
            commands = {
              posix: handoffCommand(session.id, exportFile),
              powershell: handoffCommand(session.id, exportFile, 'powershell'),
            };
          } else {
            commands = {
              posix: resumeCommand(commandSession),
              powershell: resumeCommand(commandSession, 'powershell'),
            };
          }
          return json(200, { ...session, commands } satisfies SessionResponse);
        }
        return json(404, { error: 'Not found.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method not allowed.' });
      const asset = assets.get(url.pathname);
      if (!asset) return json(404, { error: 'Not found.' });
      const body = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (/^Invalid (offset|limit)$/.test(errorMessage(error)))
        return json(400, { error: errorMessage(error) });
      const code = errorCode(error);
      if (code && ['ENOENT', 'ELOOP'].includes(code))
        return json(410, { error: 'This file is no longer available. Refresh your history.' });
      json(500, { error: 'Could not read local history. Check file permissions and try refreshing.' });
    }
  };
}

export async function startServer({
  store,
  port = 0,
  demo = false,
}: {
  store: HistoryStore;
  port?: number;
  demo?: boolean;
}) {
  const token = randomBytes(32).toString('hex');
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid loopback server address');
  const origin = `http://127.0.0.1:${address.port}`;
  server.on('request', createHandler({ store, token, origin, demo }));
  return {
    server,
    token,
    url: `${origin}/#key=${token}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
