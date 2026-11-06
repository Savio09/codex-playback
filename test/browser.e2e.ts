import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import type { Page } from 'playwright';
import { createDemoHome } from '../src/demo.js';
import { HistoryStore } from '../src/history.js';
import { createHandler, startServer } from '../src/server.js';
import { errorCode, errorMessage, isRecord } from '../shared/values.js';
import { required } from './helpers.js';

declare global {
  interface Window {
    playbackInjected?: boolean;
  }
}

async function assertClipboard(page: Page, expected: RegExp): Promise<void> {
  // A click dispatches the handler; pagination and clipboard writes finish later.
  await page.waitForFunction(
    async ({ source, flags }) => new RegExp(source, flags).test(await navigator.clipboard.readText()),
    { source: expected.source, flags: expected.flags },
    { timeout: 5000, polling: 50 },
  );
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), expected);
}

// Route browser requests through the real handler without a listening test port.
test(
  'browse, search, filter, read, copy, refresh, and responsive layouts',
  { timeout: 120000 },
  async (t) => {
    const demo = await createDemoHome();
    t.after(demo.cleanup);
    const canonicalId = '019cc9fa-c3b0-7142-b232-000000000001';
    const originalPath = `${demo.home}/sessions/${canonicalId}.jsonl`;
    const original: unknown[] = (await readFile(originalPath, 'utf8'))
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    const metadata = original[0];
    assert.ok(isRecord(metadata) && isRecord(metadata.payload) && typeof metadata.timestamp === 'string');
    metadata.payload.session_id = canonicalId;
    metadata.payload.id = 'rollout-part-0001';
    await writeFile(originalPath, original.map((entry) => JSON.stringify(entry)).join('\n'));
    const nextDay = new Date(Date.parse(metadata.timestamp) + 24 * 3600000).toISOString();
    const continuation = [
      {
        type: 'session_meta',
        timestamp: nextDay,
        payload: {
          id: 'rollout-part-0002',
          session_id: canonicalId,
          cwd: '/projects/atlas',
          source: 'cli',
          timestamp: nextDay,
        },
      },
      required(original[1]), // Overlap with an earlier file must not appear twice.
      {
        type: 'response_item',
        timestamp: nextDay,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ text: 'Continue the command palette from yesterday.' }],
        },
      },
    ];
    await writeFile(
      `${demo.home}/sessions/next-day.jsonl`,
      continuation.map((entry) => JSON.stringify(entry)).join('\n'),
    );
    const secondId = '019cc9fa-c3b0-7142-b232-000000000002';
    await appendFile(
      `${demo.home}/sessions/${secondId}.jsonl`,
      '\n' +
        JSON.stringify({
          type: 'response_item',
          timestamp: new Date(Date.now() - 5 * 3600000).toISOString(),
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                text: Array.from(
                  { length: 60 },
                  (_, i) => `Trace retained dashboard subscription ${i}.`,
                ).join('\n\n'),
              },
            ],
          },
        }),
    );
    const store = new HistoryStore(demo.home);
    await store.refresh();
    let browser;
    try {
      browser = await chromium.launch({
        channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
        headless: true,
      });
    } catch (error) {
      if (/Operation not permitted|EPERM|bootstrap_check_in|Permission denied/.test(errorMessage(error)))
        return t.skip('Sandbox prevents launching Chrome; run npm run test:browser outside the sandbox');
      throw error;
    }
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const base = 'http://127.0.0.1:4317';
    const token = 'e'.repeat(64);
    const handler = createHandler({ store, token, origin: base, demo: true });
    let offline = false;
    let transcriptPageGate: Promise<void> | undefined;
    await context.route(`${base}/**`, async (route) => {
      if (offline && route.request().url().includes('/api/')) return route.abort('failed');
      let status = 200;
      const headers: Record<string, string> = {};
      let body: string | Buffer = '';
      const request = route.request();
      const url = new URL(request.url());
      if (
        transcriptPageGate &&
        url.searchParams.get('offset') === '50' &&
        url.searchParams.get('limit') === '100'
      )
        await transcriptPageGate;
      await handler(
        {
          url: url.pathname + url.search,
          method: request.method(),
          headers: { ...(await request.allHeaders()), host: url.host },
          resume() {},
        },
        {
          setHeader: (key, value) => {
            headers[key] = value;
          },
          writeHead: (code, values) => {
            status = code;
            Object.assign(headers, values);
          },
          end: (value) => {
            body = value ?? '';
          },
        },
      );
      await route.fulfill({ status, headers, body });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${base}/#key=${token}`);
    const loadedFonts = await page.evaluate(async () => {
      const faces = await Promise.all([
        document.fonts.load('400 14px "Playback Sans"'),
        document.fonts.load('500 14px "Playback Sans"'),
      ]);
      return faces.map((weights) => weights.map((font) => font.status));
    });
    assert.deepEqual(loadedFonts, [['loaded'], ['loaded']], 'Bundled fonts load without a system fallback');
    const firstTitle = 'Building a better command palette';
    const first = page.getByRole('region', { name: firstTitle, exact: true });
    await first.getByRole('button', { name: 'Copy resume command', exact: true }).waitFor();
    assert.deepEqual(await context.cookies(), [], 'Access keys must never be stored in host-wide cookies');
    await page.reload();
    await first.getByRole('heading', { name: firstTitle, exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, `#key=${token}`, 'Reloads retain the private fragment key');

    const locked = await context.newPage();
    await locked.goto(base);
    await locked
      .getByText('Open the access link printed in your terminal to connect.', { exact: true })
      .first()
      .waitFor();
    assert.equal(await locked.locator('.conversation').count(), 0, 'Tabs without the key remain locked');
    await locked.close();

    const otherOrigin = 'http://127.0.0.1:4318';
    let otherHeaders: Record<string, string> = {};
    await context.route(`${otherOrigin}/**`, async (route) => {
      otherHeaders = await route.request().allHeaders();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Another local service</p>' });
    });
    const other = await context.newPage();
    await other.goto(otherOrigin);
    assert.equal(otherHeaders.cookie, undefined, 'Other ports receive no access cookie');
    assert.equal(otherHeaders.authorization, undefined, 'Other ports receive no bearer key');
    await other.close();

    await first.getByRole('button', { name: 'Copy resume command', exact: true }).click();
    await assertClipboard(
      page,
      new RegExp(`cd -- '/projects/atlas' && CODEX_HOME='[^']+' codex resume ${canonicalId}$`),
    );
    assert.equal(await page.locator('.conversation').count(), 3);
    assert.equal(await first.locator('.message').count(), 5);
    assert.equal(await first.locator('.copy-resume').count(), 1);
    await first.getByText('Continue the command palette from yesterday.', { exact: true }).waitFor();
    const presentation = await page.evaluate(() => {
      const style = (selector: string) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`Missing element: ${selector}`);
        return getComputedStyle(node);
      };
      return {
        sidebar: style('.sidebar').backgroundColor,
        reader: style('.reader').backgroundColor,
        selected: style('.project-item.selected').backgroundColor,
        code: style('.code-block').backgroundColor,
        font: style('.message-content').fontFamily,
        titleWeight: style('.conversation h2').fontWeight,
      };
    });
    assert.equal(presentation.sidebar, 'rgb(236, 243, 254)');
    assert.equal(presentation.reader, 'rgb(251, 253, 255)');
    assert.equal(presentation.selected, 'rgb(251, 253, 255)');
    assert.equal(presentation.code, 'rgb(255, 255, 255)');
    assert.match(presentation.font, /Playback Sans/);
    assert.equal(presentation.titleWeight, '400');
    assert.equal(await page.getByRole('button', { name: /All conversations/ }).count(), 0);
    assert.equal(
      await page
        .locator(
          '.conversation-list, .conversation-card, .date-group, .resume-panel, .resume-command, .browser-grid, .conversation-meta, .conversation-date, .conversation-count, .message-header time',
        )
        .count(),
      0,
    );
    assert.equal(await page.locator('.workspace > #reader').count(), 1);
    assert.equal(await page.locator('.topbar').getByRole('searchbox').count(), 1);
    const reader = page.locator('#reader');
    const resume = first.locator('.copy-resume');
    const originalButton = await resume.elementHandle();
    assert.ok(originalButton);
    const anchorBefore = await first.locator('.resume-anchor').boundingBox();
    assert.ok(anchorBefore);
    await reader.hover();
    await page.mouse.wheel(0, 400);
    await first.locator('.copy-resume.is-floating').waitFor();
    assert.equal(await resume.evaluate((button, original) => button === original, originalButton), true);
    assert.equal(await page.locator('.copy-resume.is-floating').count(), 1);
    const anchorAfter = await first.locator('.resume-anchor').boundingBox();
    assert.ok(anchorAfter);
    assert.equal(anchorAfter.height, anchorBefore.height);
    assert.equal(anchorAfter.width, anchorBefore.width);
    await resume.click();
    await assertClipboard(page, new RegExp(`codex resume ${canonicalId}$`));
    await mkdir(new URL('../../artifacts/', import.meta.url), { recursive: true });
    await page.screenshot({
      path: new URL('../../artifacts/resume-floating-1440.png', import.meta.url).pathname,
    });

    const nextConversation = page.getByRole('region', { name: 'Tracking down a memory leak', exact: true });
    await nextConversation.getByRole('heading').scrollIntoViewIfNeeded();
    await nextConversation
      .getByText('Trace retained dashboard subscription 18.', { exact: true })
      .scrollIntoViewIfNeeded();
    await nextConversation.locator('.copy-resume.is-floating').waitFor();
    assert.equal(await page.locator('.copy-resume.is-floating').count(), 1);
    await nextConversation.locator('.copy-resume').click();
    await assertClipboard(page, new RegExp(`codex resume ${secondId}$`));
    await first.getByRole('heading', { name: firstTitle, exact: true }).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.copy-resume.is-floating').length === 0);
    assert.equal(await resume.evaluate((button, original) => button === original, originalButton), true);
    await originalButton.dispose();
    await first.getByRole('button', { name: 'Copy code', exact: true }).click();
    await assertClipboard(page, /export function scoreCommand/);

    const sortButton = page
      .getByRole('complementary', { name: 'Library navigation' })
      .getByRole('button', { name: 'Sort and filter projects' });
    assert.equal(((await sortButton.textContent()) ?? '').trim(), '');
    const filters = page.getByRole('dialog', { name: 'Sort and filter projects' });
    await sortButton.click();
    await filters.getByRole('combobox', { name: 'Sort projects', exact: true }).selectOption('za');
    assert.deepEqual(await page.locator('.project-item').allTextContents(), [
      'tiny-tools',
      'fieldnotes',
      'atlas',
    ]);
    await filters.getByRole('combobox', { name: 'Sort projects', exact: true }).selectOption('az');
    await filters.getByRole('combobox', { name: 'Terminal shell', exact: true }).selectOption('powershell');
    await page.keyboard.press('Escape');
    await filters.waitFor({ state: 'hidden' });
    assert.equal(await sortButton.evaluate((button) => button === document.activeElement), true);
    await first.getByRole('button', { name: 'Copy resume command', exact: true }).click();
    await assertClipboard(page, /Set-Location -LiteralPath/);
    await sortButton.click();
    await filters.getByRole('combobox', { name: 'Terminal shell', exact: true }).selectOption('posix');
    await filters.getByRole('combobox', { name: 'Sort conversations', exact: true }).selectOption('title');
    await page.waitForFunction(
      () => document.querySelector('.conversation h2')?.textContent === 'Accessible navigation patterns',
    );
    await filters.getByRole('combobox', { name: 'Sort conversations', exact: true }).selectOption('newest');
    await page.getByRole('searchbox').click();
    await filters.waitFor({ state: 'hidden' });

    const project = page
      .getByRole('navigation', { name: 'Filter by project' })
      .getByRole('button', { name: 'fieldnotes', exact: true });
    await first
      .getByText('Continue the command palette from yesterday.', { exact: true })
      .scrollIntoViewIfNeeded();
    await first.locator('.copy-resume.is-floating').waitFor();
    await project.click();
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 2);
    assert.equal(await page.locator('.copy-resume.is-floating').count(), 0);
    assert.deepEqual(await page.locator('.conversation h2').allTextContents(), [
      'Designing the settings page',
      'Making search feel instant',
    ]);
    const second = page.getByRole('region', { name: 'Making search feel instant', exact: true });
    await second.scrollIntoViewIfNeeded();
    await second.getByText('Build an inverted index of normalized terms', { exact: false }).waitFor();
    assert.equal(await page.locator('.date-group').count(), 0);

    await page.getByRole('searchbox').fill('inverted index');
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 1);
    await page.getByRole('searchbox').fill('no-such-conversation-xyz');
    await page.getByRole('heading', { name: 'No conversations found.' }).waitFor();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 2);
    assert.equal(await project.getAttribute('aria-pressed'), 'true');
    await sortButton.click();
    await filters.getByRole('combobox', { name: 'Status', exact: true }).selectOption('archived');
    await page.keyboard.press('Escape');
    const archived = page.getByRole('region', { name: 'An earlier prototype', exact: true });
    await archived.getByRole('button', { name: 'Copy resume command', exact: true }).click();
    await assertClipboard(page, /codex unarchive/);
    await page
      .getByRole('navigation', { name: 'Filter by project' })
      .getByRole('button', { name: 'atlas', exact: true })
      .click();
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 3);
    await page.getByRole('button', { name: 'Refresh history' }).click();
    await page.getByRole('status').filter({ hasText: 'History refreshed.' }).waitFor();

    await mkdir(new URL('../../artifacts/', import.meta.url), { recursive: true });
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await first.getByRole('heading', { name: firstTitle, exact: true }).scrollIntoViewIfNeeded();
      await first.locator('.message').first().waitFor();
      const layout = await page.evaluate(() => {
        const bar = document.querySelector('.topbar')?.getBoundingClientRect();
        const search = document.querySelector('.search-wrap')?.getBoundingClientRect();
        if (!bar || !search) throw new Error('Missing top bar or search');
        const overflow = [
          ...document.querySelectorAll(
            '.workspace, .reader, .conversation, .conversation-header, .conversation-actions, .code-block',
          ),
        ].some((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < -1 || rect.right > innerWidth + 1;
        });
        return { centered: Math.abs(search.x + search.width / 2 - (bar.x + bar.width / 2)) < 2, overflow };
      });
      assert.deepEqual(layout, { centered: true, overflow: false }, `Layout at ${width}px`);
      const action = await first.locator('.copy-resume').boundingBox();
      const messages = await first.locator('.conversation-messages').boundingBox();
      assert.ok(action && messages);
      assert.ok(action.y + action.height <= messages.y, 'Resume action is above the conversation messages');
      await page.screenshot({
        path: new URL(`../../artifacts/feed-${width}.png`, import.meta.url).pathname,
        fullPage: true,
      });
    }
    await first
      .getByText('Continue the command palette from yesterday.', { exact: true })
      .scrollIntoViewIfNeeded();
    const mobileResume = first.locator('.copy-resume.is-floating');
    await mobileResume.waitFor();
    const floatingBounds = await mobileResume.boundingBox();
    assert.ok(floatingBounds && floatingBounds.x >= 8 && floatingBounds.x + floatingBounds.width <= 312);
    assert.ok(floatingBounds.y > 800 && floatingBounds.y + floatingBounds.height <= 892);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await mobileResume.evaluate((button) => getComputedStyle(button).animationName), 'none');
    await page.screenshot({
      path: new URL('../../artifacts/resume-floating-320.png', import.meta.url).pathname,
    });
    await first.getByRole('heading', { name: firstTitle, exact: true }).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.copy-resume.is-floating').length === 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Sort and filter projects' }).click();
    const mobileProject = filters.getByRole('combobox', { name: 'Project', exact: true });
    assert.equal(await mobileProject.locator('option[value=""]').count(), 0);
    await mobileProject.selectOption('/projects/fieldnotes');
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 2);
    await filters.getByRole('combobox', { name: 'Status', exact: true }).selectOption('archived');
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 1);
    await filters.getByRole('combobox', { name: 'Status', exact: true }).selectOption('active');
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 2);
    await mobileProject.selectOption('/projects/atlas');
    await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 3);
    await page.keyboard.press('Escape');
    await filters.waitFor({ state: 'hidden' });

    const saved = [...store.sessions.values()].find((session) => session.title === firstTitle);
    assert.ok(saved && saved.kind === 'codex');
    const stressTitle = 'Averylongconversationtitlewithoutanyspaces'.repeat(12);
    await appendFile(
      `${demo.home}/session_index.jsonl`,
      `\n${JSON.stringify({ id: saved.id, thread_name: stressTitle })}\n`,
    );
    const extra = Array.from({ length: 55 }, (_, i) => ({
      type: 'response_item',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'message',
        role: i % 2 ? 'assistant' : 'user',
        content: [{ text: `Extra message ${i}` }],
      },
    }));
    extra.unshift({
      type: 'response_item',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            text:
              '<img src=x onerror="window.playbackInjected=true"><script>window.playbackInjected=true</script>\n\n```js\u2028untrusted fence\nconst reallyLongValue = "' +
              'x'.repeat(1600) +
              '";\n```',
          },
        ],
      },
    });
    await appendFile(saved.path, '\n' + extra.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    await store.refresh();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Refresh history' }).click();
    const stress = page.getByRole('region', { name: stressTitle, exact: true });
    const copyTranscript = stress.getByRole('button', { name: 'Copy full transcript', exact: true });
    const staleClipboard = 'Waiting for the full transcript';
    await page.evaluate((text) => navigator.clipboard.writeText(text), staleClipboard);
    const gate: { release?: () => void } = {};
    transcriptPageGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const pageRequested = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname.endsWith(`/sessions/${saved.id}`) &&
        url.searchParams.get('offset') === '50' &&
        url.searchParams.get('limit') === '100'
      );
    });
    try {
      await copyTranscript.click();
      await pageRequested;
      assert.equal(await copyTranscript.isDisabled(), true);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), staleClipboard);
    } finally {
      gate.release?.();
      transcriptPageGate = undefined;
    }
    await assertClipboard(page, /Extra message 54/);
    await stress.getByRole('button', { name: 'Load more messages' }).click();
    await stress.getByText('Extra message 54', { exact: true }).waitFor();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('.message-content img, .message-content script').count(), 0);
      assert.equal(await page.evaluate(() => window.playbackInjected), undefined);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const fallback = await context.newPage();
    await fallback.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            throw new Error('Unavailable in test');
          },
        },
      });
    });
    await fallback.goto(`${base}/#key=${token}`);
    await fallback.getByRole('button', { name: 'Copy resume command', exact: true }).first().click();
    const dialog = fallback.getByRole('dialog', { name: 'Copy to your clipboard' });
    await dialog.waitFor();
    assert.match(await dialog.getByRole('textbox').inputValue(), /codex resume/);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await fallback.close();
    assert.deepEqual(errors, []);
    offline = true;
    await page.getByRole('button', { name: 'Refresh history' }).click();
    await page.getByRole('status').filter({ hasText: 'The local server is not responding.' }).waitFor();
  },
);

// Unlike route interception, a real HTTP connection includes the Origin header
// serialized by the browser's network stack under the document's referrer policy.
test(
  'fresh launch and refresh work over real HTTP with strict Origin checks',
  { timeout: 30000 },
  async (t) => {
    const demo = await createDemoHome();
    t.after(demo.cleanup);
    const store = new HistoryStore(demo.home);
    await store.refresh();
    let app;
    try {
      app = await startServer({ store, port: 0, demo: true });
    } catch (error) {
      if (errorCode(error) === 'EPERM') return t.skip('Sandbox does not allow listening on local ports');
      throw error;
    }
    t.after(() => app.close());
    const origin = new URL(app.url).origin;
    const posts: { path: string | undefined; origin: string | undefined; referer: string | undefined }[] = [];
    app.server.on('request', (request) => {
      if (request.method === 'POST')
        posts.push({ path: request.url, origin: request.headers.origin, referer: request.headers.referer });
    });
    let browser;
    try {
      browser =
        process.env.PLAYWRIGHT_STARTUP_BROWSER === 'webkit'
          ? await webkit.launch({ headless: true })
          : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    } catch (error) {
      if (/Operation not permitted|EPERM|bootstrap_check_in|Permission denied/.test(errorMessage(error)))
        return t.skip('Sandbox prevents launching a browser; run npm run test:browser outside the sandbox');
      throw error;
    }
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const unlocked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/unlock');
    await page.goto(app.url);
    assert.equal((await unlocked).status(), 200, 'Fresh launch must authenticate without changing a filter');
    await page.getByRole('heading', { name: 'Building a better command palette', exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('.copy-resume')?.disabled === false,
    );
    assert.equal(await page.locator('.project-item').count(), 3);
    assert.equal(await page.locator('.conversation').count(), 3);
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/refresh');
    await page.getByRole('button', { name: 'Refresh history' }).click();
    assert.equal((await refreshed).status(), 200);
    await page.getByRole('status').filter({ hasText: 'History refreshed.' }).waitFor();
    assert.deepEqual(posts, [
      { path: '/api/unlock', origin, referer: undefined },
      { path: '/api/refresh', origin, referer: undefined },
    ]);
    assert.deepEqual(errors, []);
  },
);
