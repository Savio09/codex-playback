import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const examples: [string, string, string, ...string[]][] = [
  [
    'Building a better command palette',
    'atlas',
    'cli',
    'I want a command palette that feels fast. Can we add fuzzy search and full keyboard navigation?',
    'Let’s start with the interaction: ⌘K opens it, arrow keys move through results, and Enter runs the selected command. Search should match both the command label and its keywords.\n\nHere’s a small scoring function to get us started:\n\n```js\nexport function scoreCommand(query, command) {\n  const label = command.label.toLowerCase();\n  const search = query.toLowerCase().trim();\n\n  if (label.startsWith(search)) return 100;\n  if (label.includes(search)) return 50;\n  return 0;\n}\n```\n\nKeep focus inside the dialog while it’s open, then return focus to the trigger when it closes.',
    'Can you make sure Escape closes it, too?',
    'Yes. Handle Escape on the dialog, clear the query when it closes, and restore focus to the element that opened it. I’d test that with the keyboard before adding visual polish.',
  ],
  [
    'Tracking down a memory leak',
    'atlas',
    'vscode',
    'Our dashboard gets slower after switching projects a few times. Where should I look?',
    'Start by recording a heap snapshot before and after switching projects ten times. Look for retained event listeners and disconnected DOM nodes. The most likely cause is a subscription created on each navigation without a cleanup function.',
  ],
  [
    'A tiny HTTP server, no dependencies',
    'tiny-tools',
    'cli',
    'Can we serve a local UI with just the Node standard library?',
    "Yes. Use node:http and bind to the loopback interface.\n\n```js\nimport { createServer } from 'node:http';\n\nconst server = createServer((request, response) => {\n  response.setHeader('Content-Type', 'text/plain');\n  response.end('Hello, localhost.');\n});\n\nserver.listen(0, '127.0.0.1');\n```\n\nA port of zero asks the operating system to select an available port.",
  ],
  [
    'Designing the settings page',
    'fieldnotes',
    'cli',
    'Let’s simplify the settings page. There are too many sections.',
    'Group settings by the decisions people make: appearance, editor behavior, and account. Put the most frequently changed controls first. Each control needs a visible label and an explanation only when the impact isn’t obvious.',
  ],
  [
    'Making search feel instant',
    'fieldnotes',
    'vscode',
    'Search is slow with a few thousand notes.',
    'Build an inverted index of normalized terms, then intersect document IDs for multi-word queries. Update the index incrementally when a note changes. Measure query time before considering a worker.',
  ],
  [
    'Release checklist for v0.2',
    'tiny-tools',
    'cli',
    'Help me prepare the next open-source release.',
    'Verify the package from its tarball in a temporary directory. Check that the executable bit, README, license, and browser assets are included. Run the public commands exactly as a new user would.',
  ],
  [
    'Accessible navigation patterns',
    'atlas',
    'cli',
    'Review our navigation for keyboard accessibility.',
    'Use native links for navigation and buttons for actions. Give the current page aria-current="page". Ensure focus is visible, and keep the tab order aligned with the reading order.',
  ],
  [
    'An earlier prototype',
    'fieldnotes',
    'cli',
    'Explore a minimal editor prototype.',
    'Start with a plain textarea and a preview. Keep the document model independent of the rendering layer so you can replace the editor later.',
  ],
];

export async function createDemoHome() {
  const home = await mkdtemp(join(tmpdir(), 'codex-playback-demo-'));
  await mkdir(join(home, 'sessions'));
  await mkdir(join(home, 'archived_sessions'));
  const index = [];
  for (const [i, [title, project, source, ...texts]] of examples.entries()) {
    const id = `019cc9fa-c3b0-7142-b232-${String(i + 1).padStart(12, '0')}`;
    const timestamp = new Date(Date.now() - i * 6 * 3600000 - 1800000).toISOString();
    const entries: Record<string, unknown>[] = [
      { type: 'session_meta', timestamp, payload: { id, cwd: `/projects/${project}`, source, timestamp } },
    ];
    texts.forEach((text, j) =>
      entries.push({
        type: 'response_item',
        timestamp: new Date(Date.parse(timestamp) + j * 60000).toISOString(),
        payload: {
          type: 'message',
          role: j % 2 ? 'assistant' : 'user',
          content: [{ type: j % 2 ? 'output_text' : 'input_text', text }],
        },
      }),
    );
    await writeFile(
      join(home, i === 7 ? 'archived_sessions' : 'sessions', `${id}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join('\n'),
    );
    index.push(JSON.stringify({ id, thread_name: title, updated_at: timestamp }));
  }
  await writeFile(join(home, 'session_index.jsonl'), index.join('\n'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}
