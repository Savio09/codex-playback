import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore, readSession } from '../src/history.js';
import type { TestContext } from 'node:test';
import type { Role } from '../shared/types.js';
import { required } from './helpers.js';

const id = '019cc9fa-c3b0-7142-b232-d2970375b844';
const line = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-01-01T12:00:00Z', type, payload });
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'playback-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'sessions', '2026'), { recursive: true });
  return { home, file: join(home, 'sessions', '2026', 'rollout-test.jsonl') };
}
const transcript = [
  line('session_meta', { id, cwd: '/tmp/my project', source: 'cli' }),
  line('response_item', { type: 'message', role: 'developer', content: [{ text: 'private instructions' }] }),
  line('response_item', {
    type: 'message',
    role: 'user',
    content: [{ text: '<environment_context>private</environment_context>' }],
  }),
  line('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Build a search index' }],
  }),
  line('event_msg', { type: 'user_message', message: 'Build a search index' }),
  line('response_item', { type: 'function_call', name: 'shell', arguments: 'private tool text' }),
  line('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Use an inverted index.\n```js\nconst x = 1;\n```' }],
  }),
  '{"incomplete":',
].join('\n');

test('reads visible messages without duplicating event mirrors or exposing internal records', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, transcript);
  const session = await readSession(file);
  assert.equal(session.id, id);
  assert.equal(session.cwd, '/tmp/my project');
  assert.equal(session.messages.length, 2);
  assert.equal(session.title, 'Build a search index');
  assert.equal(required(session.messages[1]).role, 'assistant');
  assert.equal(session.malformedLines, 1);
});
test('Unicode line and paragraph separators inside valid JSON are preserved, not treated as record boundaries', async (t) => {
  const { home, file } = await fixture(t);
  const question = 'First paragraph\u2028second line\u2029next paragraph';
  const answer = 'Answer\u2028continued';
  await writeFile(
    file,
    [
      line('session_meta', { id }),
      line('response_item', { type: 'message', role: 'user', content: [{ text: question }] }),
      line('response_item', { type: 'custom_tool_call_output', output: 'internal\u2028output\u2029text' }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ text: answer }] }),
    ].join('\r\n'),
  );
  const store = new HistoryStore(home);
  await store.refresh();
  assert.equal(store.status.malformedLines, 0);
  assert.deepEqual(
    required(await store.detail(id)).messages.map((message) => message.text),
    [question, answer],
  );
});
test('legacy event-only histories and non-text attachments have readable messages', async (t) => {
  const { file } = await fixture(t);
  await writeFile(
    file,
    [
      line('session_meta', { session_id: id }),
      line('event_msg', { type: 'user_message', message: 'Find this phrase' }),
      line('event_msg', { type: 'agent_message', message: 'Found it' }),
    ].join('\n'),
  );
  assert.deepEqual(
    (await readSession(file)).messages.map((m) => m.text),
    ['Find this phrase', 'Found it'],
  );
});
test('indexes titles, searches transcript text, refreshes changed files and ignores symlinks', async (t) => {
  const { home, file } = await fixture(t);
  await writeFile(file, transcript);
  await writeFile(
    join(home, 'session_index.jsonl'),
    line('unused', {}) +
      '\n' +
      JSON.stringify({ id, thread_name: 'Search architecture', updated_at: '2026-02-01T00:00:00Z' }),
  );
  await symlink(file, join(home, 'sessions', 'external.jsonl'));
  const store = new HistoryStore(home);
  await store.refresh();
  assert.equal(store.list({ q: 'inverted' }).total, 1);
  assert.equal(required(store.list().sessions[0]).title, 'Search architecture');
  assert.equal(store.list().total, 1);
  assert.equal('messages' in required(store.list().sessions[0]), false);
  await writeFile(file, transcript.replace('inverted', 'forward'));
  await store.refresh();
  assert.equal(store.list({ q: 'inverted' }).total, 0);
  assert.equal(store.list({ q: 'forward' }).total, 1);
  await rm(file);
  await store.refresh();
  assert.equal(store.list().total, 0);
});
test('missing history is empty and archives are separately filterable', async (t) => {
  const { home } = await fixture(t);
  const store = new HistoryStore(join(home, 'missing'));
  await store.refresh();
  assert.equal(store.list().total, 0);
  await mkdir(join(home, 'archived_sessions'));
  await writeFile(join(home, 'archived_sessions', 'archive.jsonl'), transcript);
  const archives = new HistoryStore(home);
  await archives.refresh();
  assert.equal(archives.list().total, 0);
  assert.equal(archives.list({ archive: 'archived' }).total, 1);
  assert.equal(required(archives.list({ archive: 'all' }).sessions[0]).archived, true);
});
test('mixed legacy and response histories keep both sides and hide analysis-channel messages', async (t) => {
  const { file } = await fixture(t);
  await writeFile(
    file,
    [
      line('session_meta', { id }),
      line('event_msg', { type: 'user_message', message: 'A legacy question' }),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        channel: 'analysis',
        content: [{ text: 'private reasoning' }],
      }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ text: 'A visible answer' }] }),
    ].join('\n'),
  );
  assert.deepEqual(
    (await readSession(file)).messages.map((m) => m.text),
    ['A legacy question', 'A visible answer'],
  );
});
test('pagination and project filters return bounded results', async (t) => {
  const { home, file } = await fixture(t);
  for (let i = 0; i < 55; i++) {
    await writeFile(
      `${file}-${i}.jsonl`,
      transcript.replaceAll(id, `019cc9fa-c3b0-7142-b232-${String(i).padStart(12, '0')}`),
    );
  }
  const store = new HistoryStore(home);
  await store.refresh();
  assert.equal(store.list().sessions.length, 50);
  assert.equal(store.list({ offset: 50 }).sessions.length, 5);
  assert.equal(store.list({ project: '/missing' }).total, 0);
  assert.equal(store.list({ project: '/tmp/my project' }).total, 55);
});

test('refuses to follow a session file replaced by a symlink after indexing', async (t) => {
  if (process.platform === 'win32')
    return t.skip('Symlink creation may require Windows administrator rights');
  const { home, file } = await fixture(t);
  await writeFile(file, transcript);
  const store = new HistoryStore(home);
  await store.refresh();
  const replacement = join(home, 'replacement.jsonl');
  await writeFile(replacement, transcript);
  await rm(file);
  await symlink(replacement, file);
  await assert.rejects(store.detail(id), { code: 'ELOOP' });
});

test('uses the canonical session ID and merges dated rollout segments into one resumable transcript', async (t) => {
  const { home, file } = await fixture(t);
  type SegmentMessage = [Role, string, string, string];
  const segment = (segmentId: string, day: string, messages: SegmentMessage[]) =>
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: `${day}T12:00:00Z`,
        payload: {
          id: segmentId,
          session_id: id,
          cwd: '/tmp/project',
          timestamp: `${day}T12:00:00Z`,
          source: 'cli',
        },
      }),
      ...messages.map(([role, text, timestamp, messageId]) =>
        JSON.stringify({
          type: 'response_item',
          timestamp,
          payload: { id: messageId, type: 'message', role, content: [{ text }] },
        }),
      ),
    ].join('\n');
  const first: SegmentMessage = ['user', 'Start the project', '2026-01-01T12:00:00Z', 'message-first'];
  await writeFile(
    file,
    segment('segment-0001', '2026-01-01', [
      first,
      ['assistant', 'First answer', '2026-01-01T12:01:00Z', 'message-answer'],
    ]),
  );
  const later = join(home, 'sessions', '2026', 'later.jsonl');
  await writeFile(
    later,
    segment('segment-0002', '2026-01-02', [
      first,
      ['user', 'Continue the project', '2026-01-02T12:00:00Z', 'message-next'],
    ]),
  );
  assert.equal((await readSession(file)).id, id);
  const store = new HistoryStore(home);
  await store.refresh();
  assert.equal(store.list().total, 1);
  assert.equal(required(store.list().sessions[0]).id, id);
  assert.equal(required(store.list().sessions[0]).messageCount, 3);
  assert.deepEqual(
    required(await store.detail(id)).messages.map((m) => m.text),
    ['Start the project', 'First answer', 'Continue the project'],
  );
  assert.equal(
    required(required(await store.detail(id, { offset: 2, limit: 1 })).messages[0]).text,
    'Continue the project',
  );
  assert.equal(store.list({ q: 'First answer' }).total, 1);
  assert.equal(store.list({ q: 'Continue the project' }).total, 1);
  assert.equal(await store.detail('segment-0001'), null);
});

test('merging retains legitimate repeats and keeps separate sessions in the same project separate', async (t) => {
  const { home, file } = await fixture(t);
  const entries = (segmentId: string, sessionId: string, messages: [string, string][]) =>
    [
      { type: 'session_meta', payload: { id: segmentId, session_id: sessionId, cwd: '/tmp/project' } },
      ...messages.map(([text, timestamp]) => ({
        type: 'response_item',
        timestamp,
        payload: { type: 'message', role: 'user', content: [{ text }] },
      })),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');
  await writeFile(
    file,
    entries('segment-0001', id, [
      ['Continue', '2026-01-01T12:00:00Z'],
      ['Continue', '2026-01-01T12:00:00Z'],
    ]),
  );
  await writeFile(
    join(home, 'sessions', '2026', 'later.jsonl'),
    entries('segment-0002', id, [
      ['Continue', '2026-01-01T12:00:00Z'],
      ['Continue', '2026-01-01T12:00:00Z'],
      ['Continue', '2026-01-02T12:00:00Z'],
    ]),
  );
  await writeFile(
    join(home, 'sessions', '2026', 'other.jsonl'),
    entries('segment-0003', 'independent-session', [['Different chat', '2026-01-03T12:00:00Z']]),
  );
  const store = new HistoryStore(home);
  await store.refresh();
  assert.equal(store.list({ project: '/tmp/project' }).total, 2);
  assert.equal(required(await store.detail(id)).messages.length, 3);
  assert.equal(
    required(required(await store.detail('independent-session')).messages[0]).text,
    'Different chat',
  );
});

test('a merged session stays active while an active segment exists and becomes archived when it is removed', async (t) => {
  const { home, file } = await fixture(t);
  await mkdir(join(home, 'archived_sessions'));
  const archivedFile = join(home, 'archived_sessions', 'old.jsonl');
  const archivedTranscript = transcript.replace(
    '"id":"' + id + '"',
    '"id":"archived-segment","session_id":"' + id + '"',
  );
  await writeFile(
    file,
    transcript.replace('"id":"' + id + '"', '"id":"active-segment","session_id":"' + id + '"'),
  );
  await writeFile(archivedFile, archivedTranscript);
  const store = new HistoryStore(home);
  await store.refresh();
  assert.equal(store.list().total, 1);
  assert.equal(required(await store.detail(id)).archived, false);
  await writeFile(archivedFile, archivedTranscript.replace('inverted', 'updated'));
  await store.detail(id);
  await rm(file);
  await store.refresh();
  assert.equal(store.list().total, 0);
  assert.equal(store.list({ archive: 'archived' }).total, 1);
  assert.equal(required(await store.detail(id)).archived, true);
});

test('sessions without a saved directory remain accessible through their own project scope', async (t) => {
  const { home, file } = await fixture(t);
  await writeFile(file, transcript.replace('"cwd":"/tmp/my project",', ''));
  const store = new HistoryStore(home);
  await store.refresh();
  assert.equal(required(store.list().projects[0]).id, '@unassigned');
  assert.equal(store.list({ project: '@unassigned' }).total, 1);
});
