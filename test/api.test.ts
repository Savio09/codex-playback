import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../public/api.js';
import { HistoryStore } from '../src/history.js';
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
