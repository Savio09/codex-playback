import { constants } from 'node:fs';
import { readdir, lstat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { readChatGptExport } from './chatgpt.js';
import { errorCode, isRecord } from '../shared/values.js';
import type {
  ChatGptSession,
  CodexSession,
  HistoryList,
  HistoryStatus,
  ListOptions,
  Message,
  SessionPage,
  SessionSummary,
} from '../shared/types.js';

interface RolloutSegment extends CodexSession {
  segmentId: string;
}
interface SessionFile {
  path: string;
  archived: boolean;
}
interface CachedSession {
  signature: string;
  session: RolloutSegment;
}
type IndexedSession = (
  | (Omit<CodexSession, 'messages'> & { path: string; paths: SessionFile[] })
  | Omit<ChatGptSession, 'messages'>
) & { search: string };

async function* records(file: string): AsyncGenerator<unknown> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const input = handle.createReadStream({
    encoding: 'utf8',
    autoClose: false,
  });
  // JSONL records end at LF. Unicode separators can occur inside valid strings;
  // readline treats those as line endings and would split a single JSON record.
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  };
  let pending = '';
  try {
    for await (const chunk of input) {
      if (typeof chunk !== 'string') throw new Error('Expected UTF-8 log text');
      pending += chunk;
      let boundary;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (line.trim()) yield parse(line);
      }
    }
    if (pending.trim()) yield parse(pending);
  } finally {
    input.destroy();
    await handle.close();
  }
}

function visibleText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: unknown[] = content;
  return parts
    .map((part) => {
      if (!isRecord(part)) return '';
      if (typeof part?.text === 'string') return part.text;
      if (part?.type === 'input_image' || part?.type === 'image') return '[Image attachment]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isContext(text: string): boolean {
  return /^\s*(<environment_context>|<permissions instructions>|<skills_instructions>|<collaboration_mode>|# AGENTS\.md instructions|# Repository guidelines|# Repository Guidelines)/.test(
    text,
  );
}

export async function readSession(file: string, archived = false): Promise<RolloutSegment> {
  const messages: (Message & { order: number })[] = [];
  const events: (Message & { order: number })[] = [];
  let meta: Record<string, unknown> = {};
  let malformedLines = 0;
  let latest = '';
  let order = 0;
  for await (const entry of records(file)) {
    order++;
    if (!isRecord(entry)) {
      malformedLines++;
      continue;
    }
    const payload = entry.payload;
    if (!isRecord(payload)) continue;
    if (typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)))
      latest = entry.timestamp;
    if (entry.type === 'session_meta') meta = payload;
    if (
      entry.type === 'response_item' &&
      payload.type === 'message' &&
      payload.channel !== 'analysis' &&
      (payload.role === 'user' || payload.role === 'assistant')
    ) {
      const text = visibleText(payload.content);
      if (text.trim() && !isContext(text))
        messages.push({
          role: payload.role,
          text,
          timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
          order,
          ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
        });
    }
    if (
      entry.type === 'event_msg' &&
      (payload.type === 'user_message' || payload.type === 'agent_message') &&
      typeof payload.message === 'string' &&
      !isContext(payload.message)
    ) {
      events.push({
        role: payload.type === 'user_message' ? 'user' : 'assistant',
        text: payload.message,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
        order,
      });
    }
  }
  const responseKeys = new Set(messages.map((m) => `${m.role}\0${m.text}`));
  const transcript = [...messages, ...events.filter((m) => !responseKeys.has(`${m.role}\0${m.text}`))]
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...message }) => message);
  const id = meta.session_id ?? meta.id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(id))
    throw new Error('Unrecognized session format');
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  const source =
    typeof meta.source === 'string'
      ? meta.source
      : isRecord(meta.source) && meta.source.subagent
        ? 'subagent'
        : 'unknown';
  return {
    id,
    segmentId: typeof meta.id === 'string' ? meta.id : id,
    kind: 'codex',
    cwd,
    source,
    archived,
    project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || 'No project',
    title:
      transcript
        .find((message) => message.role === 'user')
        ?.text.replace(/\s+/g, ' ')
        .slice(0, 120) || 'Untitled conversation',
    createdAt: typeof meta.timestamp === 'string' ? meta.timestamp : (transcript[0]?.timestamp ?? latest),
    updatedAt: latest,
    messageCount: transcript.length,
    preview:
      transcript
        .find((message) => message.role === 'user')
        ?.text.replace(/\s+/g, ' ')
        .slice(0, 180) || '',
    messages: transcript,
    malformedLines,
  };
}

function timestamp(value: string | null): number {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

// A conversation may span several rollout files. Merge by canonical session ID,
// retaining message IDs where available and treating exact dated copies as overlap.
function mergeSegments(segments: readonly RolloutSegment[]): CodexSession {
  const ordered = [...segments].sort(
    (a, b) =>
      timestamp(a.createdAt) - timestamp(b.createdAt) ||
      timestamp(a.updatedAt) - timestamp(b.updatedAt) ||
      a.segmentId.localeCompare(b.segmentId),
  );
  const first = ordered[0];
  if (!first) throw new Error('Cannot merge an empty session');
  const latest = ordered.reduce((a, b) => (timestamp(b.updatedAt) >= timestamp(a.updatedAt) ? b : a));
  const merged = new Map<string, { message: Message; time: number; order: number }>();
  let sequence = 0;
  for (const [segmentIndex, segment] of ordered.entries()) {
    const occurrences = new Map<string, number>();
    let lastTime = timestamp(segment.createdAt);
    for (const [messageIndex, message] of segment.messages.entries()) {
      if (timestamp(message.timestamp)) lastTime = timestamp(message.timestamp);
      let key;
      if (message.id) key = `id:${message.id}`;
      else if (message.timestamp) {
        const base = JSON.stringify([message.role, message.timestamp, message.text]);
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        key = `${base}:${occurrence}`;
      } else key = `undated:${segmentIndex}:${messageIndex}`;
      const existing = merged.get(key);
      merged.set(key, {
        message,
        time: existing ? Math.min(existing.time, lastTime) : lastTime,
        order: existing?.order ?? sequence++,
      });
    }
  }
  const messages = [...merged.values()]
    .sort((a, b) => a.time - b.time || a.order - b.order)
    .map((record) => record.message);
  const { segmentId, ...metadata } = latest;
  return {
    ...metadata,
    title: first.title,
    createdAt: first.createdAt,
    archived: ordered.every((segment) => segment.archived),
    messages,
    messageCount: messages.length,
    malformedLines: ordered.reduce((sum, segment) => sum + segment.malformedLines, 0),
    preview:
      messages
        .find((message) => message.role === 'user')
        ?.text.replace(/\s+/g, ' ')
        .slice(0, 180) || '',
  };
}

async function cachedSession(
  file: string,
  archived: boolean,
  cache: ReadonlyMap<string, CachedSession>,
): Promise<CachedSession> {
  const stat = await lstat(file);
  if (!stat.isFile()) {
    const error: NodeJS.ErrnoException = new Error('Session file is not a regular file');
    error.code = stat.isSymbolicLink() ? 'ELOOP' : 'EINVAL';
    throw error;
  }
  const signature = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(file);
  if (cached?.signature === signature && cached.session.archived === archived) return cached;
  return { signature, session: await readSession(file, archived) };
}

function projectId(session: SessionSummary): string {
  return session.kind === 'chatgpt' ? '@chatgpt' : session.cwd || '@unassigned';
}

async function discover(directory: string, archived: boolean, output: SessionFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await discover(path, archived, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push({ path, archived });
  }
}

export class HistoryStore {
  readonly home: string;
  cache = new Map<string, CachedSession>();
  sessions = new Map<string, IndexedSession>();
  chatgptExport: string | null;
  imported = new Map<string, ChatGptSession>();
  status: HistoryStatus = {
    indexedAt: null,
    durationMs: 0,
    skippedFiles: 0,
    malformedLines: 0,
    indexWarning: false,
    importSkipped: 0,
  };
  private refreshing: Promise<void> | null = null;
  private importSignature: string | undefined;
  private importSkipped = 0;
  private indexWarning = false;

  constructor(home: string, { chatgptExport = null }: { chatgptExport?: string | null } = {}) {
    this.home = home;
    this.chatgptExport = chatgptExport;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async scan(): Promise<void> {
    const started = performance.now();
    this.indexWarning = false;
    const titles = new Map<string, { thread_name: string }>();
    try {
      for await (const entry of records(join(this.home, 'session_index.jsonl'))) {
        if (isRecord(entry) && typeof entry.id === 'string' && typeof entry.thread_name === 'string')
          titles.set(entry.id, { thread_name: entry.thread_name });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') this.indexWarning = true;
    }
    const files: SessionFile[] = [];
    await discover(join(this.home, 'sessions'), false, files);
    await discover(join(this.home, 'archived_sessions'), true, files);
    const nextCache = new Map<string, CachedSession>();
    let skippedFiles = 0;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < files.length) {
          const file = files[cursor++];
          if (!file) continue;
          try {
            const cached = await cachedSession(file.path, file.archived, this.cache);
            nextCache.set(file.path, cached);
          } catch {
            skippedFiles++;
          }
        }
      }),
    );
    const groups = new Map<string, { segments: RolloutSegment[]; paths: SessionFile[] }>();
    for (const file of files) {
      const cached = nextCache.get(file.path);
      if (!cached) continue;
      const group = groups.get(cached.session.id) || { segments: [], paths: [] };
      group.segments.push(cached.session);
      group.paths.push(file);
      groups.set(cached.session.id, group);
    }
    const sessions = new Map<string, IndexedSession>();
    for (const [id, group] of groups) {
      const session = mergeSegments(group.segments);
      const title =
        titles.get(id) || group.segments.map((segment) => titles.get(segment.segmentId)).find(Boolean);
      const { messages, ...summary } = session;
      const lastFile = group.paths.at(-1);
      if (!lastFile) continue;
      sessions.set(id, {
        ...summary,
        title: title?.thread_name || session.title,
        path: lastFile.path,
        paths: group.paths,
        search: messages
          .map((message) => message.text)
          .join('\n')
          .toLowerCase(),
      });
    }
    let importSkipped = 0;
    if (this.chatgptExport) {
      const info = await lstat(this.chatgptExport);
      const signature = `${info.mtimeMs}:${info.size}`;
      if (signature !== this.importSignature) {
        const imported = await readChatGptExport(this.chatgptExport);
        this.imported = new Map(imported.sessions.map((session) => [session.id, session]));
        this.importSkipped = imported.skipped;
        this.importSignature = signature;
      }
      importSkipped = this.importSkipped || 0;
      for (const session of this.imported.values()) {
        const { messages, ...summary } = session;
        sessions.set(session.id, {
          ...summary,
          search: messages
            .map((m) => m.text)
            .join('\n')
            .toLowerCase(),
        });
      }
    }
    this.cache = nextCache;
    this.sessions = sessions;
    this.status = {
      indexedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      skippedFiles,
      malformedLines: [...sessions.values()].reduce((sum, s) => sum + s.malformedLines, 0),
      indexWarning: Boolean(this.indexWarning),
      importSkipped,
    };
  }

  list({
    q = '',
    project = '',
    archive = 'active',
    sort = 'newest',
    offset = 0,
    limit = 50,
  }: ListOptions = {}): HistoryList {
    const query = q.trim().toLowerCase();
    const all = [...this.sessions.values()];
    const filtered = all.filter(
      (s) =>
        (archive === 'all' || s.archived === (archive === 'archived')) &&
        (!project || projectId(s) === project) &&
        (!query || `${s.title}\n${s.cwd}\n${s.source}\n${s.search}`.toLowerCase().includes(query)),
    );
    filtered.sort((a, b) =>
      sort === 'oldest'
        ? a.updatedAt.localeCompare(b.updatedAt)
        : sort === 'title'
          ? a.title.localeCompare(b.title)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
    return {
      sessions: filtered.slice(offset, offset + limit).map(({ search, ...session }) => {
        if ('paths' in session) {
          const { path, paths, ...summary } = session;
          return summary;
        }
        return session;
      }),
      total: filtered.length,
      totalSessions: all.length,
      counts: {
        active: all.filter((s) => !s.archived).length,
        archived: all.filter((s) => s.archived).length,
      },
      projects: [...new Set(all.map(projectId))].sort().map((id) => {
        const sessions = all.filter((session) => projectId(session) === id);
        return {
          id,
          cwd: sessions[0]?.cwd ?? '',
          name: id === '@chatgpt' ? 'ChatGPT' : id === '@unassigned' ? 'Unassigned' : basename(id),
          activeCount: sessions.filter((session) => !session.archived).length,
        };
      }),
      status: this.status,
    };
  }

  async detail(
    id: string,
    { offset = 0, limit = 100 }: { offset?: number; limit?: number } = {},
  ): Promise<SessionPage | null> {
    const indexed = this.sessions.get(id);
    if (!indexed) return null;
    let session: CodexSession | ChatGptSession | undefined;
    if (indexed.kind === 'chatgpt') session = this.imported.get(id);
    else {
      const segments = await Promise.all(
        indexed.paths.map(async ({ path, archived }) => {
          const cached = await cachedSession(path, archived, this.cache);
          this.cache.set(path, cached);
          return cached.session;
        }),
      );
      if (segments.some((segment) => segment.id !== id)) return null;
      session = mergeSegments(segments);
    }
    if (!session || session.id !== id) return null;
    return {
      ...session,
      title: indexed.title,
      messages: session.messages.slice(offset, offset + limit),
      offset,
      hasMore: offset + limit < session.messages.length,
    };
  }
}
