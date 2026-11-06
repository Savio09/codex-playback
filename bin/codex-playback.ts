#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { HistoryStore } from '../src/history.js';
import { startServer } from '../src/server.js';
import { createDemoHome } from '../src/demo.js';
import { continueChatGpt } from '../src/chatgpt.js';
import { errorCode, errorMessage, isRecord } from '../shared/values.js';

const help = `
  Codex Playback — pick up where you left off.

  Usage: codex-playback [options]

  --codex-home <path>  History directory (default: CODEX_HOME or ~/.codex)
  --port <number>      Local port (default: an available port; 0 also works)
  --no-open            Print the browser link without opening it
  --demo               Browse synthetic examples instead of your history
  --chatgpt-export <file>  Also browse an extracted conversations.json export
  --continue <id>      Start a new Codex chat with an exported chat as context
  --help, -h           Show this help
  --version, -v        Print the version

  Runs on 127.0.0.1. History stays on your computer. Ctrl+C to stop.
`;

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => console.error('  Could not open a browser. Open the link above manually.'));
  child.on('exit', (code) => {
    if (code) console.error('  Could not open a browser. Open the link above manually.');
  });
  child.unref();
}

let demo: Awaited<ReturnType<typeof createDemoHome>> | undefined;
try {
  const { values } = parseArgs({
    options: {
      'codex-home': { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      demo: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'chatgpt-export': { type: 'string' },
      continue: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
    process.exit(0);
  }
  if (values.version) {
    const metadata: unknown = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    if (!isRecord(metadata) || typeof metadata.version !== 'string')
      throw new Error('Invalid package metadata');
    console.log(metadata.version);
    process.exit(0);
  }
  const chatgptExport = values['chatgpt-export']
    ? resolve(values['chatgpt-export'].replace(/^~(?=[/\\]|$)/, homedir()))
    : null;
  if (values.continue) {
    if (!chatgptExport)
      throw new Error('--continue requires --chatgpt-export pointing to the original export.');
    process.exitCode = await continueChatGpt(chatgptExport, values.continue);
    process.exit(process.exitCode);
  }
  const port = values.port ?? '0';
  if (!/^\d+$/.test(port) || Number(port) > 65535)
    throw new Error('--port must be a number between 0 and 65535.');
  if (values.demo) demo = await createDemoHome();
  const requestedHome = values['codex-home'] || process.env.CODEX_HOME || join(homedir(), '.codex');
  const home = demo?.home || resolve(requestedHome.replace(/^~(?=[/\\]|$)/, homedir()));
  const store = new HistoryStore(home, { chatgptExport });
  console.log('\n  Indexing local conversations…');
  await store.refresh();
  const app = await startServer({ store, port: Number(port), demo: Boolean(demo) });
  console.log(
    `\n  ◧  Codex Playback${demo ? ' · demo' : ''}\n\n  ${app.url}\n\n  ${store.sessions.size} conversations · ${store.status.durationMs}ms to index\n  ${demo ? 'Synthetic examples' : home}\n\n  Press Ctrl+C to stop.\n`,
  );
  if (store.status.skippedFiles)
    console.error(`  Skipped ${store.status.skippedFiles} unreadable or unsupported files.`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await app.close();
    await demo?.cleanup();
    process.exitCode = 0;
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (!values['no-open']) openBrowser(app.url);
} catch (error) {
  await demo?.cleanup();
  const code = errorCode(error);
  const message =
    code === 'EADDRINUSE'
      ? 'That port is in use. Try --port 0 to use an available port.'
      : isRecord(error) && error.syscall === 'listen'
        ? `Cannot start local server (${code}). Check local network permissions.`
        : code && ['EACCES', 'EPERM'].includes(code)
          ? 'Cannot access the history directory. Check file permissions.'
          : errorMessage(error);
  console.error(`\n  Error: ${message}\n  Run codex-playback --help for usage.\n`);
  process.exitCode = 1;
}
