import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { required } from './helpers.js';
import { isRecord } from '../shared/values.js';

const bin = new URL('../bin/codex-playback.js', import.meta.url).pathname;
test('help and version work without a Codex installation or history', () => {
  assert.match(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }), /--codex-home/);
  const metadata: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(isRecord(metadata) && typeof metadata.version === 'string');
  assert.equal(
    execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(),
    metadata.version,
  );
});
test('invalid CLI options fail with actionable messages', () => {
  for (const args of [['--port', 'no'], ['--port', '65536'], ['--unknown'], ['--codex-home']]) {
    assert.throws(
      () => execFileSync(process.execPath, [bin, ...args], { stdio: 'pipe' }),
      (error: unknown) =>
        isRecord(error) &&
        error.status === 1 &&
        Buffer.isBuffer(error.stderr) &&
        /Error:/.test(error.stderr.toString()),
    );
  }
});
test('demo starts on a free port and stops cleanly on SIGTERM', { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, [bin, '--demo', '--no-open', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const started = await new Promise<boolean>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('Press Ctrl+C')) resolve(true);
    });
    child.on('exit', (code) => {
      if (/Cannot start local server \(EPERM\)/.test(errors)) resolve(false);
      else reject(new Error(`Exited ${code}: ${errors}`));
    });
  });
  if (started === false) return t.skip('Sandbox does not allow the CLI to listen on local ports');
  const url = required(required(output.match(/http:\/\/127\.0\.0\.1:\d+\/#key=[a-f0-9]+/))[0]);
  assert.equal((await fetch(url)).status, 200);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
});
