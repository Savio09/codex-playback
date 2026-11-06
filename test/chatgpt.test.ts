import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseChatGptExport, handoffCommand, prepareContext, continueChatGpt } from '../src/chatgpt.js';
import { HistoryStore } from '../src/history.js';
import { required } from './helpers.js';

const message = (role: string, text: string) => ({
  author: { role },
  content: { parts: [text] },
  create_time: 1700000000,
});
const conversation = {
  id: 'sample-chat',
  title: 'Garden plan',
  current_node: 'answer',
  create_time: 1700000000,
  update_time: 1700000100,
  mapping: {
    root: { parent: null, message: message('system', 'hidden system instructions') },
    question: { parent: 'root', message: message('user', 'Which herbs grow well indoors?') },
    abandoned: { parent: 'question', message: message('assistant', 'abandoned answer') },
    answer: { parent: 'question', message: message('assistant', 'Try basil and mint.') },
  },
};
test('imports only the selected conversation branch and visible messages', () => {
  const { sessions } = parseChatGptExport([conversation]);
  assert.equal(sessions.length, 1);
  assert.deepEqual(
    required(sessions[0]).messages.map((m) => m.text),
    ['Which herbs grow well indoors?', 'Try basil and mint.'],
  );
  assert.equal(required(sessions[0]).kind, 'chatgpt');
  assert.match(required(sessions[0]).id, /^chatgpt-[a-f0-9]+$/);
});
test('rejects non-export JSON, skips invalid conversations, and terminates on cycles', () => {
  assert.throws(() => parseChatGptExport({ unexpected: true }), /array of conversations/);
  const cyclic = structuredClone(conversation);
  cyclic.mapping.question.parent = 'answer';
  assert.equal(parseChatGptExport([cyclic]).skipped, 1);
  assert.equal(parseChatGptExport([null, { id: 'invalid' }]).skipped, 2);
});
test('keeps imports searchable and paginates their transcripts', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'playback-chatgpt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'conversations.json');
  await writeFile(file, JSON.stringify([conversation]));
  const store = new HistoryStore(home, { chatgptExport: file });
  await store.refresh();
  const data = store.list({ q: 'basil' });
  assert.equal(data.total, 1);
  assert.equal('messages' in required(data.sessions[0]), false);
  assert.equal(required(data.projects[0]).id, '@chatgpt');
  assert.equal(required(data.projects[0]).name, 'ChatGPT');
  assert.equal(store.list({ project: '@chatgpt' }).total, 1);
  const detail = required(await store.detail(required(data.sessions[0]).id, { limit: 1 }));
  assert.equal(detail.hasMore, true);
  assert.equal(detail.messages.length, 1);
});
test('handoff commands quote file paths and private context files are cleaned up', async (t) => {
  const session = required(parseChatGptExport([conversation]).sessions[0]);
  const command = handoffCommand(session.id, "/tmp/it's an export.json", 'posix');
  assert.ok(command.includes("'--chatgpt-export' '/tmp/it'\\''s an export.json'"));
  assert.match(handoffCommand(session.id, 'C:\\export.json', 'powershell'), /^& '/);
  const context = await prepareContext(session);
  t.after(context.cleanup);
  assert.match(context.prompt, /historical context/);
  const { readFile, stat } = await import('node:fs/promises');
  assert.match(await readFile(context.file, 'utf8'), /Try basil and mint/);
  if (process.platform !== 'win32') assert.equal((await stat(context.file)).mode & 0o777, 0o600);
  await context.cleanup();
  await assert.rejects(stat(context.file), { code: 'ENOENT' });
});

test('terminal handoff passes only a file reference to Codex and cleans it after the child exits', async (t) => {
  if (process.platform === 'win32') return t.skip('Synthetic executable fixture uses a POSIX shebang');
  const directory = await mkdtemp(join(tmpdir(), 'playback-handoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'export.json');
  const capture = join(directory, 'capture.json');
  await writeFile(file, JSON.stringify([conversation]));
  await writeFile(
    join(directory, 'codex'),
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst prompt = process.argv[2];\nconst file = JSON.parse(prompt.match(/at (".*?") as historical/)[1]);\nfs.writeFileSync(process.env.PLAYBACK_TEST_CAPTURE, JSON.stringify({prompt, file, text: fs.readFileSync(file, 'utf8')}));\nprocess.exit(23);\n`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH;
  const oldCapture = process.env.PLAYBACK_TEST_CAPTURE;
  process.env.PATH = `${directory}:${oldPath}`;
  process.env.PLAYBACK_TEST_CAPTURE = capture;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldCapture === undefined) delete process.env.PLAYBACK_TEST_CAPTURE;
    else process.env.PLAYBACK_TEST_CAPTURE = oldCapture;
  });
  const id = required(parseChatGptExport([conversation]).sessions[0]).id;
  assert.equal(await continueChatGpt(file, id), 23);
  const { readFile, stat } = await import('node:fs/promises');
  const result = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(result.prompt.includes('basil'), false);
  assert.match(result.text, /Try basil and mint/);
  await assert.rejects(stat(result.file), { code: 'ENOENT' });
});

test('ChatGPT handoff paths escape PowerShell smart quotes and refuse terminal controls', () => {
  const id = required(parseChatGptExport([conversation]).sessions[0]).id;
  for (const quote of ['\u2018', '\u2019', '\u201a', '\u201b']) {
    const file = `C:\\export${quote}; Write-Output injected; #.json`;
    assert.ok(
      handoffCommand(id, file, 'powershell').includes(
        `'C:\\export${quote}${quote}; Write-Output injected; #.json'`,
      ),
    );
  }
  for (const shell of ['posix', 'powershell'] as const) {
    assert.throws(() => handoffCommand(id, '/tmp/export\x1b[201~.json', shell), /unsafe.*character/i);
  }
});
