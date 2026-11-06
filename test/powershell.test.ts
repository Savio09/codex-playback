import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { quotePowerShell } from '../src/commands.js';
import { errorCode } from '../shared/values.js';

test('PowerShell evaluates hostile path literals as data, including every smart apostrophe', (t) => {
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const paths = [
    "C:\\it's a [project] $(Write-Output injected) `literal`",
    ...['\u2018', '\u2019', '\u201a', '\u201b'].map(
      (quote) => `C:\\project${quote}; Write-Output ${quote}injected${quote}; #`,
    ),
  ];
  for (const path of paths) {
    const result = spawnSync(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write(${quotePowerShell(path)})`,
      ],
      { encoding: 'utf8', timeout: 10000, shell: false },
    );
    if (errorCode(result.error) === 'ENOENT') return t.skip('PowerShell is not installed on this host');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, path);
  }
});
