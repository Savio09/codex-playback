import { readdir, copyFile, mkdir, chmod } from 'node:fs/promises';
import { extname } from 'node:path';

const assets = new Set(['.html', '.css', '.svg', '.ttf', '.txt', '.md']);
async function copyAssets(from: URL, to: URL): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = new URL(entry.name + (entry.isDirectory() ? '/' : ''), from);
    const target = new URL(entry.name + (entry.isDirectory() ? '/' : ''), to);
    if (entry.isDirectory()) await copyAssets(source, target);
    else if (assets.has(extname(entry.name))) await copyFile(source, target);
  }
}

await copyAssets(new URL('../../public/', import.meta.url), new URL('../public/', import.meta.url));
await chmod(new URL('../bin/codex-playback.js', import.meta.url), 0o755);
console.log('Built TypeScript and copied local browser assets.');
