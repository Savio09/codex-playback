# Security

Playback handles private conversation history. Keep the server on loopback and use the complete per-launch URL printed by the CLI. Do not share that link or expose the port through a tunnel.

## Trust boundaries

- Incoming HTTP requests are untrusted. The server checks Host and Origin and requires a per-launch bearer key on every API request. It never sets authentication cookies, because cookies are shared across localhost ports. The browser keeps the key in the launch URL's fragment, which is not sent in HTTP request URLs or referrers, and attaches it only to same-origin API requests. The complete access link remains private and supports reloading; a tab opened without the key is locked. API fetches omit cookies and refuse redirects. The server sends no CORS allowance, disables caching, and applies a restrictive Content Security Policy.
- Session files and ChatGPT exports are untrusted text. Only user and assistant text is displayed. HTML, scripts, links, images, reasoning, and tool payloads are not executed. Known context-only messages are omitted. Source formats are not a security boundary for malicious local files; review any terminal command before pasting it.
- API clients can select discovered IDs, not arbitrary filesystem paths. Discovery ignores symbolic-link entries, and JSONL reads use `O_NOFOLLOW` where supported. No API executes commands or changes Codex's history.
- Terminal commands quote directory and profile paths, including PowerShell's smart-quote delimiters. Paths containing terminal control characters, line separators, or bidirectional overrides are refused. Native session IDs are validated before command generation. ChatGPT handoffs invoke a child process without a shell and put the transcript in a private temporary directory, with file mode 0600 where supported. The file is removed on ordinary completion and startup errors. A forced kill or machine crash can leave that temporary directory; remove stale `codex-playback-context-*` directories from your OS temporary folder if needed.

## Limits

The random key protects against unrelated browser pages; it does not isolate history from other processes running as your OS user. Loopback HTTP is not a multi-user authentication system. Large local inputs can consume memory; ChatGPT JSON imports are capped at 256 MB and Codex JSONL files are streamed. Selected transcripts are parsed on demand and lists/messages are paginated.

The reader is intentionally offline. Continuing in Codex uses Codex's existing provider configuration and security settings. Playback does not add sandbox bypasses or approval overrides.

See the [security review](https://github.com/Savio09/codex-playback/blob/main/docs/security-review.md) for the issues addressed after the initial release and their regression checks. Restart Playback after updating so the running server uses the fixes and a new access key.

Report suspected vulnerabilities privately to the project maintainers. Do not post real conversation history, credentials, or access links in public issues.
