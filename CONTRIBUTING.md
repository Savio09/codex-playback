# Contributing

Use Node.js 22 or newer. Clone the repository, enter its directory, then install dependencies and run the synthetic demo:

```sh
npm ci
npm run demo
```

The demo uses fictional conversations and opens a local browser window. Use it for screenshots and recordings rather than your personal history.

Before submitting a change:

```sh
npm run check
npm test
npm run test:browser
```

Browser checks use Google Chrome by default. To use Playwright Chromium:

```sh
npx playwright install chromium
PLAYWRIGHT_CHANNEL=chromium npm run test:browser
```

Write strict TypeScript and keep changes focused. Validate external JSON before using it, render history through text nodes, and keep history access read-only. Include regression tests for changes to parsing, commands, or interactions. Generated output, dependencies, private exports, credentials, and personal-history screenshots do not belong in commits.

## Record the demo

```sh
npm run record:demo
```

This records the real UI with synthetic conversations, writes the media, and updates the README's demo link. It uses Chrome by default; `PLAYWRIGHT_CHANNEL=chromium` selects Playwright Chromium. Install FFmpeg to also produce an MP4 and animated preview; without it, the recording is WebM with a still preview. Review the recording before committing it.

## Package

```sh
npm pack
```

The package includes compiled code and local browser assets, so installation does not require a TypeScript runtime. Test global installation from the resulting archive in an isolated prefix before publishing. Publishing to npm and pushing a GitHub repository are maintainer actions.

Follow the [publication guide](docs/publishing.md) for the first npm release and later updates.
