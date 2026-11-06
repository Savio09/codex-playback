export type Shell = 'posix' | 'powershell';
export type ArchiveFilter = 'active' | 'archived' | 'all';
export type ConversationSort = 'newest' | 'oldest' | 'title';
export type ProjectSort = 'az' | 'za';
export type Role = 'user' | 'assistant';

export interface Message {
  role: Role;
  text: string;
  timestamp: string | null;
  id?: string;
}

export interface SessionSummary {
  id: string;
  kind: 'codex' | 'chatgpt';
  source: string;
  cwd: string;
  project: string;
  archived: boolean;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  malformedLines: number;
}

export interface CodexSession extends SessionSummary {
  kind: 'codex';
  messages: Message[];
}

export interface ChatGptSession extends SessionSummary {
  kind: 'chatgpt';
  messages: Message[];
}

export type Session = CodexSession | ChatGptSession;
export type SessionPage = Session & { offset: number; hasMore: boolean };
export type SessionResponse = SessionPage & { commands: Record<Shell, string> };

export interface Project {
  id: string;
  cwd: string;
  name: string;
  activeCount: number;
}

export interface HistoryStatus {
  indexedAt: string | null;
  durationMs: number;
  skippedFiles: number;
  malformedLines: number;
  indexWarning: boolean;
  importSkipped: number;
}

export interface ListOptions {
  q?: string;
  project?: string;
  archive?: ArchiveFilter;
  sort?: ConversationSort;
  offset?: number;
  limit?: number;
}

export interface HistoryList {
  sessions: SessionSummary[];
  total: number;
  totalSessions: number;
  counts: { active: number; archived: number };
  projects: Project[];
  status: HistoryStatus;
}

export interface ListResponse extends HistoryList {
  demo: boolean;
  sourcePath: string;
}

export interface ActionResponse {
  ok: true;
  status?: HistoryStatus;
}
