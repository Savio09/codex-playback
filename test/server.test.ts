import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from '../src/history.js';
import { createHandler, startServer } from '../src/server.js';
import type { TestContext } from 'node:test';
import { required } from './helpers.js';
import { errorCode } from '../shared/values.js';

const id = '019cc9fa-c3b0-7142-b232-d2970375b844';
async function setup(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'playback-api-'));
  await mkdir(join(home, 'sessions'));
  await writeFile(
    join(home, 'sessions', 'fixture.jsonl'),
    [
      { type: 'session_meta', payload: { id, cwd: '/tmp/example', source: 'cli' } },
      {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { type: 'message', role: 'user', content: [{ text: 'Design an index' }] },
      },
      {
        type: 'response_item',
        timestamp: '2026-01-01T00:01:00Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ text: 'An inverted index enables search.' }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  const store = new HistoryStore(home);
  await store.refresh();
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = 'http://127.0.0.1:4321';
  const token = 'a'.repeat(64);
  const handler = createHandler({ store, token, origin: base });
  const request = async (
    url: string,
    options: Pick<RequestInit, 'headers' | 'method'> = {},
  ): Promise<Response> => {
    const headers = new Headers();
    let status = 200;
    let body: string | Buffer = '';
    await handler(
      {
        method: options.method ?? 'GET',
        url: new URL(url).pathname + new URL(url).search,
        headers: { host: '127.0.0.1:4321', ...Object.fromEntries(new Headers(options.headers)) },
        resume() {},
      },
      {
        setHeader: (key, value) => headers.set(key, value),
        writeHead: (code, values) => {
          status = code;
          Object.entries(values).forEach(([key, value]) => headers.set(key, value));
        },
        end: (value) => {
          body = value ?? '';
        },
      },
    );
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers });
  };
  const unlock = await request(`${base}/api/unlock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const setCookie = required(unlock.headers.get('set-cookie'));
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = required(setCookie.split(';')[0]);
  return { base, cookie, request, store, home };
}

test('requires auth and gives the UI a private SameSite HttpOnly cookie', async (t) => {
  const { base, cookie, request } = await setup(t);
  assert.equal((await request(`${base}/api/sessions`)).status, 401);
  const response = await request(`${base}/api/sessions?q=inverted`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(required(response.headers.get('content-security-policy')).includes("connect-src 'self'"));
});
test('pages transcripts and generates commands without accepting file paths', async (t) => {
  const { base, cookie, request } = await setup(t);
  const response = await request(`${base}/api/sessions/${id}?limit=1`, { headers: { cookie } });
  const session = await response.json();
  assert.equal(session.messages.length, 1);
  assert.equal(session.hasMore, true);
  assert.match(
    session.commands.posix,
    new RegExp(`^cd -- '/tmp/example' && CODEX_HOME='[^']+' codex resume ${id}$`),
  );
  assert.equal((await request(`${base}/api/sessions/not-found`, { headers: { cookie } })).status, 404);
  assert.equal((await request(`${base}/api/sessions?limit=-1`, { headers: { cookie } })).status, 400);
  assert.equal((await request(`${base}/api/sessions?sort=invalid`, { headers: { cookie } })).status, 400);
});
test('rejects foreign origins and host headers even with credentials', async (t) => {
  const { base, cookie, request } = await setup(t);
  assert.equal(
    (
      await request(`${base}/api/refresh`, {
        method: 'POST',
        headers: { cookie, origin: 'https://unrelated.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(`${base}/api/sessions`, { headers: { cookie, host: 'evil.example' } })).status,
    403,
  );
  assert.equal(
    (await request(`${base}/api/refresh`, { method: 'POST', headers: { cookie, origin: base } })).status,
    200,
  );
  assert.equal((await request(`${base}/src/history.js`)).status, 404);
});

test('serves all shipped browser assets and rejects invalid access keys', async (t) => {
  const { base, request } = await setup(t);
  for (const path of [
    '/',
    '/app.js',
    '/api.js',
    '/floating-resume.js',
    '/render.js',
    '/shared/values.js',
    '/style.css',
    '/favicon.svg',
  ]) {
    const response = await request(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
  }
  for (const weight of ['Regular', 'Medium']) {
    const response = await request(`${base}/fonts/Inter-${weight}.ttf`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'font/ttf');
    const font = Buffer.from(await response.arrayBuffer());
    assert.equal(font.readUInt32BE(0), 0x00010000);
    assert.ok(font.length > 100000);
    const head = await request(`${base}/fonts/Inter-${weight}.ttf`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const license = await request(`${base}/fonts/OFL.txt`);
  assert.equal(license.status, 200);
  assert.match(await license.text(), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.equal((await request(`${base}/fonts/missing.ttf`)).status, 404);
  assert.equal(
    (
      await request(`${base}/api/unlock`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'é'.repeat(64)}` },
      })
    ).status,
    401,
  );
});

test('ChatGPT API entries return context handoffs rather than native resume commands', async (t) => {
  const { base, cookie, request, store, home } = await setup(t);
  const file = join(home, 'conversations.json');
  await writeFile(
    file,
    JSON.stringify([
      {
        id: 'api-export',
        title: 'Imported chat',
        current_node: 'a',
        mapping: {
          a: {
            parent: null,
            message: { author: { role: 'user' }, content: { parts: ['An exported question'] } },
          },
        },
      },
    ]),
  );
  store.chatgptExport = file;
  await store.refresh();
  const list = await (await request(`${base}/api/sessions?q=chatgpt`, { headers: { cookie } })).json();
  assert.equal(list.total, 1);
  const detail = await (
    await request(`${base}/api/sessions/${list.sessions[0].id}`, { headers: { cookie } })
  ).json();
  assert.equal(detail.kind, 'chatgpt');
  assert.match(detail.commands.posix, /'--continue'/);
  assert.match(detail.commands.posix, /'--chatgpt-export'/);
  assert.equal(detail.commands.posix.includes('codex resume'), false);
});

test('dated segments return one API conversation and the canonical resume command', async (t) => {
  const { base, cookie, request, store, home } = await setup(t);
  await writeFile(
    join(home, 'sessions', 'continuation.jsonl'),
    [
      {
        type: 'session_meta',
        payload: { id: 'another-rollout-segment', session_id: id, cwd: '/tmp/example', source: 'cli' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-01T12:00:00Z',
        payload: { type: 'message', role: 'user', content: [{ text: 'Continue on another day' }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  await store.refresh();
  const list = await (
    await request(`${base}/api/sessions?project=/tmp/example`, { headers: { cookie } })
  ).json();
  assert.equal(list.total, 1);
  assert.equal(list.sessions[0].id, id);
  const detail = await (await request(`${base}/api/sessions/${id}`, { headers: { cookie } })).json();
  assert.equal(detail.messages.length, 3);
  assert.ok(detail.commands.posix.endsWith(`codex resume ${id}`));
  assert.equal(detail.commands.posix.includes('another-rollout-segment'), false);
  assert.equal(
    (await request(`${base}/api/sessions/another-rollout-segment`, { headers: { cookie } })).status,
    404,
  );
});

test('live loopback server serves the browser entry point', async (t) => {
  let app;
  try {
    const { store } = await setup(t);
    app = await startServer({ store, port: 0 });
  } catch (error) {
    if (errorCode(error) === 'EPERM') return t.skip('Sandbox does not allow listening on local ports');
    throw error;
  }
  t.after(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
});
