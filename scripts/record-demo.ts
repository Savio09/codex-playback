import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { createDemoHome } from '../src/demo.js';
import { HistoryStore } from '../src/history.js';
import { createHandler } from '../src/server.js';
import { errorMessage } from '../shared/values.js';

// Recording always uses generated fixtures, never the user's Codex profile.
const demo = await createDemoHome();
const temporary = await mkdtemp(join(tmpdir(), 'codex-playback-recording-'));
let browser: Browser | undefined;
let context: BrowserContext | undefined;
try {
  const store = new HistoryStore(demo.home);
  await store.refresh();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
    recordVideo: { dir: temporary, size: { width: 1440, height: 800 } },
  });
  const origin = 'http://127.0.0.1:4317';
  const token = randomBytes(32).toString('hex');
  const handler = createHandler({ store, token, origin, demo: true });
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers: Record<string, string> = {};
    let status = 200;
    let body: string | Buffer = '';
    await handler(
      {
        url: url.pathname + url.search,
        method: request.method(),
        headers: { ...(await request.allHeaders()), host: url.host },
        resume() {},
      },
      {
        setHeader(name, value) {
          headers[name] = value;
        },
        writeHead(code, values) {
          status = code;
          Object.assign(headers, values);
        },
        end(value) {
          body = value ?? '';
        },
      },
    );
    await route.fulfill({ status, headers, body });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/#key=${token}`);
  const first = page.getByRole('region', { name: 'Building a better command palette', exact: true });
  await first.locator('.copy-resume:not(:disabled)').waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: join(temporary, 'poster.png') });
  // These pauses set the viewing pace of the recording, rather than test readiness.
  await page.waitForTimeout(1600);
  const projects = page.getByRole('navigation', { name: 'Filter by project' });
  await projects.getByRole('button', { name: 'fieldnotes', exact: true }).click();
  await page.getByRole('region', { name: 'Designing the settings page', exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await page.getByRole('searchbox').pressSequentially('inverted index', { delay: 90 });
  await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 1);
  await page.waitForTimeout(1600);
  await page.getByRole('searchbox').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 2);
  await projects.getByRole('button', { name: 'atlas', exact: true }).click();
  await first.locator('.copy-resume:not(:disabled)').waitFor();
  await first.getByRole('button', { name: 'Copy code', exact: true }).click();
  await page.waitForTimeout(1400);
  await first.locator('.message').nth(2).scrollIntoViewIfNeeded();
  await first.locator('.copy-resume.is-floating').waitFor();
  await page.waitForTimeout(1200);
  await first.locator('.copy-resume').click();
  await page.waitForTimeout(1800);
  await page.locator('#reader').hover();
  await page.mouse.wheel(0, -1600);
  await page.waitForFunction(() => document.querySelectorAll('.copy-resume.is-floating').length === 0);
  await page.waitForTimeout(1500);
  const video = page.video();
  if (!video) throw new Error('Browser did not create a recording');
  await context.close();
  context = undefined;
  const recorded = await video.path();
  const media = fileURLToPath(new URL('../../docs/media/', import.meta.url));
  await mkdir(media, { recursive: true });
  let videoName = 'demo.webm';
  let previewName = 'demo.png';
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        recorded,
        '-an',
        '-c:v',
        'libx264',
        '-crf',
        '24',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        join(temporary, 'demo.mp4'),
      ],
      { stdio: 'ignore' },
    );
    videoName = 'demo.mp4';
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        recorded,
        '-filter_complex',
        'fps=8,scale=960:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
        '-loop',
        '0',
        join(temporary, 'demo.gif'),
      ],
      { stdio: 'ignore' },
    );
    if ((await stat(join(temporary, 'demo.gif'))).size <= 8 * 1024 * 1024) previewName = 'demo.gif';
  }
  await copyFile(videoName === 'demo.webm' ? recorded : join(temporary, videoName), join(media, videoName));
  await copyFile(
    previewName === 'demo.png' ? join(temporary, 'poster.png') : join(temporary, previewName),
    join(media, previewName),
  );
  const readmePath = new URL('../../README.md', import.meta.url);
  const readme = await readFile(readmePath, 'utf8');
  const section = `<!-- playback-demo:start -->\n\n[![Watch the Playback demo](https://raw.githubusercontent.com/Savio09/codex-playback/main/docs/media/${previewName})](https://github.com/Savio09/codex-playback/blob/main/docs/media/${videoName})\n\n*Choose a project, search, copy code, and copy a resume command. Recorded with synthetic history.*\n\n<!-- playback-demo:end -->`;
  await writeFile(
    readmePath,
    readme.replace(/<!-- playback-demo:start -->[\s\S]*?<!-- playback-demo:end -->/, section),
  );
  console.log(
    `Recorded docs/media/${videoName} and updated the README. Review the video before committing it.`,
  );
} catch (error) {
  const message = errorMessage(error);
  console.error(
    /Operation not permitted|EPERM|bootstrap_check_in|Permission denied/.test(message)
      ? 'This sandbox blocks browser recording. Run npm run record:demo in a normal terminal.'
      : `Could not record the demo: ${message}`,
  );
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  await demo.cleanup();
  await rm(temporary, { recursive: true, force: true });
}
