import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resumeCommand, quotePosix } from '../src/commands.js';

const id = '019cc9fa-c3b0-7142-b232-d2970375b844';
test('POSIX quoting preserves shell metacharacters literally', () => {
  const path = "/tmp/it's a $(printf danger) `whoami` project";
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${quotePosix(path)}`], { encoding: 'utf8' }), path);
  assert.equal(resumeCommand({ id, cwd: path }), `cd -- ${quotePosix(path)} && codex resume ${id}`);
});
test('PowerShell command quotes literal paths and gates resume on directory success', () => {
  assert.equal(
    resumeCommand({ id, cwd: "C:\\it's [app]" }, 'powershell'),
    `Set-Location -LiteralPath 'C:\\it''s [app]'; if ($?) { codex resume ${id} }`,
  );
});
test('archived sessions must be restored before resuming', () => {
  assert.equal(resumeCommand({ id, archived: true }), `codex unarchive ${id} && codex resume ${id}`);
});
test('invalid session IDs and shells are rejected', () => {
  assert.throws(() => resumeCommand({ id: '$(whoami)' }));
  // @ts-expect-error Deliberately exercise runtime validation for an invalid shell.
  assert.throws(() => resumeCommand({ id }, 'fish'));
});
test('custom Codex homes are carried into both restore and resume commands', () => {
  const session = { id, codexHome: '/tmp/other profile', archived: true };
  assert.equal(
    resumeCommand(session),
    `CODEX_HOME='/tmp/other profile' codex unarchive ${id} && CODEX_HOME='/tmp/other profile' codex resume ${id}`,
  );
  assert.match(
    resumeCommand(session, 'powershell'),
    /^\$env:CODEX_HOME = '\/tmp\/other profile'; codex unarchive/,
  );
});
