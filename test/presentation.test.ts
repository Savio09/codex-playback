import test from 'node:test';
import assert from 'node:assert/strict';
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
