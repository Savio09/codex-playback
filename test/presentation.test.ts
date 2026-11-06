import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { codeTokens, sortProjects } from '../public/render.js';

test('code coloring preserves source exactly, including untrusted markup and strings', () => {
  const source = 'export const text = "<script>alert(1)</script>";\n// keep this comment\nreturn 42;';
  const tokens = codeTokens(source);
  assert.equal(tokens.map((token) => token.text).join(''), source);
  assert.ok(tokens.some((token) => token.kind === 'keyword' && token.text === 'export'));
  assert.ok(tokens.some((token) => token.kind === 'string' && token.text.includes('<script>')));
  assert.ok(tokens.some((token) => token.kind === 'comment'));
  assert.ok(tokens.every((token) => ['text', 'keyword', 'string', 'comment', 'number'].includes(token.kind)));
});

test('project sorting orders names and keeps duplicate names stable by directory', () => {
  const projects = [
    { name: 'zebra', cwd: '/work/zebra' },
    { name: 'atlas', cwd: '/other/atlas' },
    { name: 'atlas', cwd: '/work/atlas' },
  ];
  assert.deepEqual(
    sortProjects(projects, 'az').map((project) => project.cwd),
    ['/other/atlas', '/work/atlas', '/work/zebra'],
  );
  assert.deepEqual(
    sortProjects(projects, 'za').map((project) => project.cwd),
    ['/work/zebra', '/work/atlas', '/other/atlas'],
  );
  assert.equal(projects[0]?.name, 'zebra');
});

test('code coloring consumes unterminated strings and comments without rescanning their contents', () => {
  for (const marker of ['"', "'", '`', '/*']) {
    const source = marker + (marker === '/*' ? 'unclosed comment' : `text\\${marker}more\\`);
    assert.deepEqual(codeTokens(source), [{ kind: marker === '/*' ? 'comment' : 'string', text: source }]);
  }
});

test('a large escaped unterminated string cannot stall syntax highlighting', { timeout: 3000 }, async (t) => {
  // A worker makes the time limit effective even if a regexp blocks its event loop.
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     import(workerData.module).then(({ codeTokens }) => {
       const tokens = codeTokens(workerData.source);
       parentPort.postMessage({ preserved: tokens.map(t => t.text).join('') === workerData.source, count: tokens.length });
     });`,
    {
      eval: true,
      workerData: {
        module: new URL('../public/render.js', import.meta.url).href,
        source: '"' + '\\"'.repeat(500000),
      },
    },
  );
  t.after(async () => {
    await worker.terminate();
  });
  const [result] = await once(worker, 'message');
  assert.deepEqual(result, { preserved: true, count: 1 });
});

test(
  'code fences containing Unicode separators cannot trap the markdown parser',
  { timeout: 3000 },
  async (t) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
     let blocks = 0;
     const node = () => ({ append() {}, addEventListener() {}, setAttribute() {} });
     globalThis.document = {
       createElement(tag) { if (tag === 'pre') blocks++; return node(); },
       createElementNS: node, createTextNode: node, createDocumentFragment: node
     };
     import(workerData.module).then(({ markdown }) => {
       for (const separator of ['\\r', '\\u2028', '\\u2029']) {
         for (const marker of ['~~~', String.fromCharCode(96).repeat(3)]) {
           markdown(marker + 'js' + separator + 'header\\nconst x = 1;\\n' + marker + '\\nAfter the code.', () => {});
         }
       }
       parentPort.postMessage(blocks);
     });`,
      { eval: true, workerData: { module: new URL('../public/render.js', import.meta.url).href } },
    );
    t.after(async () => {
      await worker.terminate();
    });
    const [blocks] = await once(worker, 'message');
    assert.equal(blocks, 6);
  },
);
