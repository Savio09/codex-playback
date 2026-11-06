import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../public/api.js';
import { HistoryStore } from '../src/history.js';
import { createHandler } from '../src/server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListResponse, SessionResponse } from '../shared/types.js';

const list: ListResponse = {
  ...new HistoryStore('/tmp/playback-api-contract').list(),
  demo: false,
  sourcePath: '/tmp/playback-api-contract',
};
const detail: SessionResponse = {
  id: 'sample-session',
  kind: 'codex',
  source: 'cli',
  cwd: '/tmp/project',
  project: 'project',
  archived: false,
  title: 'Example',
  createdAt: '',
  updatedAt: '',
  messageCount: 1,
  malformedLines: 0,
  preview: 'Hello',
  messages: [{ role: 'user', text: 'Hello', timestamp: null }],
  offset: 0,
  hasMore: false,
  commands: { posix: 'codex resume sample-session', powershell: 'codex resume sample-session' },
};

test('API client accepts the shared list, transcript, and action contracts', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(list));
  assert.deepEqual(await api('sessions?project=example'), list);
  fetch.mock.mockImplementation(async () => Response.json(detail));
  assert.deepEqual(await api('sessions/sample-session'), detail);
  fetch.mock.mockImplementation(async () => Response.json({ ok: true }));
  assert.deepEqual(await api('refresh', { method: 'POST' }), { ok: true });
});

test('API client rejects malformed response shapes instead of asserting untrusted JSON into types', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ...list, projects: [{ id: 42 }] }),
  );
  await assert.rejects(api('sessions?'), /unexpected response/);
  fetch.mock.mockImplementation(async () =>
    Response.json({ ...detail, messages: [{ role: 'developer', text: 'hidden' }] }),
  );
  await assert.rejects(api('sessions/sample-session'), /unexpected response/);
  fetch.mock.mockImplementation(async () => Response.json({ ...detail, commands: { posix: false } }));
  await assert.rejects(api('sessions/sample-session'), /unexpected response/);
  fetch.mock.mockImplementation(async () => new Response('{partial'));
  await assert.rejects(api('refresh'), /Could not read/);
});

test('API client preserves server errors and cancellation while explaining connection failures', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Open the access link.' }, { status: 401 }),
  );
  await assert.rejects(api('sessions?'), /Open the access link/);
  const abort = new DOMException('Cancelled', 'AbortError');
  fetch.mock.mockImplementation(async () => {
    throw abort;
  });
  await assert.rejects(api('sessions?'), (error) => error === abort);
  fetch.mock.mockImplementation(async () => {
    throw new TypeError('Connection refused');
  });
  await assert.rejects(api('sessions?'), /local server is not responding/);
});

test('API requests omit cookies and refuse redirects', async (t) => {
  let requestOptions: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    requestOptions = options;
    return Response.json({ ok: true });
  });
  await api('unlock', { method: 'POST' });
  assert.equal(requestOptions?.credentials, 'omit');
  assert.equal(requestOptions?.redirect, 'error');
  assert.equal(requestOptions?.mode, 'cors');
});

test('API requests use the fragment key without cookies or persistent storage', async (t) => {
  const key = 'a'.repeat(64);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Reflect.defineProperty(globalThis, 'location', { configurable: true, value: { hash: `#key=${key}` } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  const requests: Headers[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    requests.push(new Headers(options?.headers));
    return Response.json({ ok: true });
  });
  await api('unlock', { method: 'POST' });
  await api('refresh', { method: 'POST' });
  assert.deepEqual(
    requests.map((headers) => headers.get('authorization')),
    [`Bearer ${key}`, `Bearer ${key}`],
  );
});

test('startup and refresh retain a verifiable Origin under the no-referrer policy', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'playback-request-origin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const origin = 'http://127.0.0.1:4321';
  const token = 'a'.repeat(64);
  const handler = createHandler({ store: new HistoryStore(home), token, origin });
  const sentOrigins: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => {
    const request = new Request(new URL(path, origin), { ...options, referrerPolicy: 'no-referrer' });
    const headers = Object.fromEntries(request.headers);
    headers.host = new URL(origin).host;
    // Fetch's "append a request Origin header" algorithm redacts non-CORS POST
    // origins under no-referrer. Model that browser behavior before the real handler.
    // https://fetch.spec.whatwg.org/#append-a-request-origin-header
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers.origin = request.mode === 'cors' ? origin : 'null';
      sentOrigins.push(headers.origin);
    }
    let status = 200;
    let body: string | Buffer = '';
    const responseHeaders = new Headers();
    await handler(
      { url: new URL(request.url).pathname, method: request.method, headers, resume() {} },
      {
        setHeader: (name, value) => responseHeaders.set(name, value),
        writeHead: (code, values) => {
          status = code;
          for (const [name, value] of Object.entries(values)) responseHeaders.set(name, value);
        },
        end: (value) => {
          body = value ?? '';
        },
      },
    );
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status,
      headers: responseHeaders,
    });
  });
  const options = { method: 'POST', headers: { Authorization: `Bearer ${token}` } };
  assert.equal((await api('unlock', options)).ok, true);
  assert.equal((await api('refresh', options)).ok, true);
  assert.deepEqual(sentOrigins, [origin, origin]);
});
