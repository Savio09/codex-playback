import { errorMessage, isRecord } from '../shared/values.js';
import type {
  ActionResponse,
  HistoryStatus,
  ListResponse,
  Message,
  Project,
  SessionResponse,
  SessionSummary,
} from '../shared/types.js';

function isArrayOf<T>(value: unknown, check: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every((entry: unknown) => check(entry));
}
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isHistoryStatus(value: unknown): value is HistoryStatus {
  return (
    isRecord(value) &&
    (value.indexedAt === null || typeof value.indexedAt === 'string') &&
    isNonNegativeNumber(value.durationMs) &&
    isNonNegativeNumber(value.skippedFiles) &&
    isNonNegativeNumber(value.malformedLines) &&
    typeof value.indexWarning === 'boolean' &&
    isNonNegativeNumber(value.importSkipped)
  );
}
function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.name === 'string' &&
    isNonNegativeNumber(value.activeCount)
  );
}
function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'codex' || value.kind === 'chatgpt') &&
    typeof value.source === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.project === 'string' &&
    typeof value.archived === 'boolean' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isNonNegativeNumber(value.messageCount) &&
    typeof value.preview === 'string' &&
    isNonNegativeNumber(value.malformedLines)
  );
}
function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.text === 'string' &&
    (value.timestamp === null || typeof value.timestamp === 'string') &&
    (value.id === undefined || typeof value.id === 'string')
  );
}
function isListResponse(value: unknown): value is ListResponse {
  return (
    isRecord(value) &&
    isArrayOf(value.sessions, isSessionSummary) &&
    isNonNegativeNumber(value.total) &&
    isNonNegativeNumber(value.totalSessions) &&
    isRecord(value.counts) &&
    isNonNegativeNumber(value.counts.active) &&
    isNonNegativeNumber(value.counts.archived) &&
    isArrayOf(value.projects, isProject) &&
    isHistoryStatus(value.status) &&
    typeof value.demo === 'boolean' &&
    typeof value.sourcePath === 'string'
  );
}
function isSessionResponse(value: unknown): value is SessionResponse {
  return (
    isSessionSummary(value) &&
    isRecord(value) &&
    isArrayOf(value.messages, isMessage) &&
    isNonNegativeNumber(value.offset) &&
    typeof value.hasMore === 'boolean' &&
    isRecord(value.commands) &&
    typeof value.commands.posix === 'string' &&
    typeof value.commands.powershell === 'string'
  );
}
function isActionResponse(value: unknown): value is ActionResponse {
  return (
    isRecord(value) && value.ok === true && (value.status === undefined || isHistoryStatus(value.status))
  );
}

export function api(path: `sessions?${string}`, options?: RequestInit): Promise<ListResponse>;
export function api(path: `sessions/${string}`, options?: RequestInit): Promise<SessionResponse>;
export function api(path: 'unlock' | 'refresh', options?: RequestInit): Promise<ActionResponse>;
export async function api(
  path: string,
  options: RequestInit = {},
): Promise<ListResponse | SessionResponse | ActionResponse> {
  let response: Response;
  try {
    const headers = new Headers(options.headers);
    // Keep the capability in the URL fragment, which is never part of an HTTP
    // request or Referer. No cookies or browser storage are needed, even on reload.
    const key =
      typeof location === 'undefined' ? null : new URLSearchParams(location.hash.slice(1)).get('key');
    if (key && /^[a-f0-9]{64}$/.test(key)) headers.set('Authorization', `Bearer ${key}`);
    response = await fetch(`/api/${path}`, {
      ...options,
      headers,
      credentials: 'omit',
      mode: 'same-origin',
      redirect: 'error',
    });
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') throw error;
    throw new Error('The local server is not responding. Restart codex-playback and open the new link.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`Could not read the local server response: ${errorMessage(error)}`);
  }
  if (!response.ok)
    throw new Error(
      isRecord(data) && typeof data.error === 'string'
        ? data.error
        : 'Could not load your history. Try refreshing.',
    );
  if (path.startsWith('sessions?') && isListResponse(data)) return data;
  if (path.startsWith('sessions/') && isSessionResponse(data)) return data;
  if ((path === 'unlock' || path === 'refresh') && isActionResponse(data)) return data;
  throw new Error('The local server returned an unexpected response. Restart Playback and refresh the page.');
}
