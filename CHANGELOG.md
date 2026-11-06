# Changelog

## 0.1.2

### Fixed

- Fix initially empty history and failed refresh requests in Safari by preserving the POST Origin header under the no-referrer policy.
- Add a startup and refresh browser test over real HTTP, with optional WebKit coverage.

## 0.1.1

### Security

- Escape PowerShell smart apostrophes in resume and ChatGPT handoff commands, and refuse unsafe terminal characters in path arguments.
- Replace authentication cookies with per-request bearer keys so other localhost ports receive no Playback credentials. Use the complete launch link when opening another tab.
- Prevent crafted unterminated code strings and code-fence headers containing Unicode line separators from freezing the browser.

## 0.1.0

- Browse and search local Codex history by project, read transcripts and code, and copy terminal resume commands.
- Browse ChatGPT exports and start new Codex sessions with exported conversation context.
