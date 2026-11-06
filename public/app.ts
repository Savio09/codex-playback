import { el, icon, markdown, sortProjects } from './render.js';
import { api } from './api.js';
import { createFloatingResume } from './floating-resume.js';
import { errorMessage, isRecord } from '../shared/values.js';
import type {
  ConversationSort,
  Message,
  Project,
  ProjectSort,
  SessionResponse,
  SessionSummary,
  Shell,
} from '../shared/types.js';

function element<T extends HTMLElement>(id: string, constructor: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof constructor)) throw new Error(`Missing or invalid UI element: ${id}`);
  return node;
}
const ui = {
  toast: element('toast', HTMLDivElement),
  search: element('search', HTMLInputElement),
  'search-shortcut': element('search-shortcut', HTMLElement),
  projects: element('projects', HTMLElement),
  'project-select': element('project-select', HTMLSelectElement),
  'archive-select': element('archive-select', HTMLSelectElement),
  'view-label': element('view-label', HTMLHeadingElement),
  'demo-label': element('demo-label', HTMLSpanElement),
  notice: element('notice', HTMLDivElement),
  'result-count': element('result-count', HTMLSpanElement),
  'conversation-feed': element('conversation-feed', HTMLDivElement),
  reader: element('reader', HTMLElement),
  'load-more': element('load-more', HTMLButtonElement),
  sort: element('sort', HTMLSelectElement),
  'terminal-shell': element('terminal-shell', HTMLSelectElement),
  'project-sort': element('project-sort', HTMLSelectElement),
  refresh: element('refresh', HTMLButtonElement),
  'library-controls': element('library-controls', HTMLDivElement),
};
const $ = <K extends keyof typeof ui>(id: K): (typeof ui)[K] => ui[id];
const floatingResume = createFloatingResume($('reader'));
interface State {
  q: string;
  project: string;
  archive: 'active' | 'archived';
  sort: ConversationSort;
  projectSort: ProjectSort;
  projects: Project[];
  rows: SessionSummary[];
  listVersion: number;
  shell: Shell;
}
const state: State = {
  q: '',
  project: '',
  archive: 'active',
  sort: 'newest',
  projectSort: 'az',
  projects: [],
  rows: [],
  listVersion: 0,
  shell: 'posix',
};
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const copyFeedback = new WeakMap<
  HTMLButtonElement,
  { original: Node[]; timer: ReturnType<typeof setTimeout> }
>();
document
  .querySelectorAll<HTMLElement>('[data-icon]')
  .forEach((node) => node.replaceChildren(icon(node.dataset.icon)));
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('search-shortcut').textContent = 'Ctrl K';

function toast(message: string): void {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 3500);
}
function manualCopy(text: string): void {
  const dialog = el('dialog', 'copy-dialog');
  const heading = el('h2', '', 'Copy to your clipboard');
  heading.id = 'copy-dialog-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  const description = el(
    'p',
    '',
    'Clipboard access is unavailable. Select the text below and press Ctrl+C or ⌘C.',
  );
  const input = el('textarea');
  input.value = text;
  input.readOnly = true;
  input.setAttribute('aria-label', 'Text to copy');
  const close = el('button', 'button primary', 'Done');
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(heading, description, input, close);
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  input.select();
}
async function copy(text: string, button?: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard.');
    if (button) {
      const previous = copyFeedback.get(button);
      if (previous) clearTimeout(previous.timer);
      const original = previous?.original || [...button.childNodes].map((node) => node.cloneNode(true));
      button.replaceChildren(icon('check'), document.createTextNode('Copied!'));
      const timer = setTimeout(() => {
        if (button.isConnected) button.replaceChildren(...original);
        copyFeedback.delete(button);
      }, 1800);
      copyFeedback.set(button, { timer, original });
    }
  } catch {
    manualCopy(text);
  }
}

function updateProjects(projects: Project[]): void {
  state.projects = projects;
  const fragment = document.createDocumentFragment();
  const options = [];
  for (const project of sortProjects(projects, state.projectSort)) {
    const button = el('button', `project-item${state.project === project.id ? ' selected' : ''}`);
    button.title = project.cwd || project.name;
    button.setAttribute('aria-pressed', String(state.project === project.id));
    button.append(icon('folder'), el('span', '', project.name));
    button.addEventListener('click', () => {
      if (state.project === project.id && state.archive === 'active') return;
      state.project = project.id;
      state.archive = 'active';
      loadSessions();
    });
    fragment.append(button);
    options.push(new Option(project.name, project.id));
  }
  $('projects').replaceChildren(fragment);
  $('project-select').replaceChildren(...options);
  $('project-select').value = state.project;
}
async function loadSessions(append = false): Promise<boolean | undefined> {
  const version = ++state.listVersion;
  $('conversation-feed').setAttribute('aria-busy', 'true');
  $('load-more').disabled = true;
  const params = new URLSearchParams({
    q: state.q,
    project: state.project,
    archive: state.archive,
    sort: state.sort,
    offset: String(append ? state.rows.length : 0),
    limit: '50',
  });
  try {
    const data = await api(`sessions?${params}`);
    if (version !== state.listVersion) return;
    if (!data.projects.some((project) => project.id === state.project) && data.projects.length) {
      const projects = sortProjects(data.projects, state.projectSort);
      const project = projects.find((project) => project.activeCount > 0) || projects[0];
      if (!project) throw new Error('No project is available. Refresh your history.');
      state.project = project.id;
      return await loadSessions();
    }
    if (!append) resetFeed();
    state.rows = append ? [...state.rows, ...data.sessions] : data.sessions;
    $('result-count').textContent = `${data.total} conversation${data.total === 1 ? '' : 's'}`;
    $('view-label').textContent =
      data.projects.find((project) => project.id === state.project)?.name || 'Projects';
    $('archive-select').value = state.archive;
    $('demo-label').hidden = !data.demo;
    const warnings = [];
    if (data.status.skippedFiles)
      warnings.push(`${data.status.skippedFiles} unreadable or unsupported files were skipped.`);
    if (data.status.indexWarning)
      warnings.push('Session titles could not be read; showing conversation text.');
    if (data.status.importSkipped)
      warnings.push(`${data.status.importSkipped} unsupported ChatGPT records were skipped.`);
    if (data.status.malformedLines)
      warnings.push(`${data.status.malformedLines} log records could not be parsed.`);
    $('notice').textContent = warnings.join(' ');
    $('notice').hidden = !warnings.length;
    updateProjects(data.projects);
    for (const summary of data.sessions) {
      if (views.has(summary.id)) continue;
      const view = conversationView(summary);
      views.set(summary.id, view);
      $('conversation-feed').append(view.node);
      observer.observe(view.node);
    }
    if (!state.rows.length) {
      const node = el('div', 'empty-state');
      node.append(
        icon('search'),
        el('h2', '', data.totalSessions ? 'No conversations found.' : 'No conversations yet.'),
      );
      if (state.q) {
        const clear = el('button', 'button secondary', 'Clear search');
        clear.addEventListener('click', () => {
          state.q = '';
          $('search').value = '';
          loadSessions();
        });
        node.append(clear);
      }
      $('conversation-feed').replaceChildren(node);
    }
    $('load-more').hidden = state.rows.length >= data.total;
    return true;
  } catch (error) {
    if (version !== state.listVersion) return;
    $('result-count').textContent = 'Could not load history';
    $('notice').textContent = errorMessage(error);
    $('notice').hidden = false;
    if (!append) {
      resetFeed();
      state.rows = [];
      $('load-more').hidden = true;
      $('conversation-feed').append(el('div', 'empty-state', errorMessage(error)));
    }
    return false;
  } finally {
    if (version === state.listVersion) {
      $('conversation-feed').setAttribute('aria-busy', 'false');
      $('load-more').disabled = false;
    }
  }
}

function messageNode(message: Message, kind: SessionSummary['kind'] = 'codex'): HTMLElement {
  const article = el('article', `message ${message.role}`);
  const header = el('div', 'message-header');
  const avatar = el('span', 'avatar', message.role === 'user' ? 'Y' : '');
  if (message.role !== 'user') avatar.append(icon('sparkles'));
  avatar.setAttribute('aria-hidden', 'true');
  header.append(
    avatar,
    el('span', 'message-author', message.role === 'user' ? 'You' : kind === 'chatgpt' ? 'ChatGPT' : 'Codex'),
  );
  article.append(header, markdown(message.text, copy));
  return article;
}
interface ConversationView {
  node: HTMLElement;
  status: 'idle' | 'queued' | 'loading' | 'ready' | 'error';
  session: SessionResponse | null;
  load(): Promise<void>;
}
const views = new Map<string, ConversationView>();
const detailControllers = new Set<AbortController>();
let pendingViews: ConversationView[] = [];
let activeLoads = 0;
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const id = entry.target instanceof HTMLElement ? entry.target.dataset.id : undefined;
      const view = id ? views.get(id) : undefined;
      if (view) enqueue(view);
    }
  },
  { root: $('reader'), rootMargin: '400px 0px' },
);

function resetFeed() {
  floatingResume.reset();
  observer.disconnect();
  for (const controller of detailControllers) controller.abort();
  detailControllers.clear();
  pendingViews = [];
  views.clear();
  $('conversation-feed').replaceChildren();
  $('reader').scrollTop = 0;
}
function enqueue(view: ConversationView): void {
  if (!['idle', 'error'].includes(view.status)) return;
  view.status = 'queued';
  pendingViews.push(view);
  drainQueue();
}
function drainQueue() {
  while (activeLoads < 3 && pendingViews.length) {
    const view = pendingViews.shift();
    if (!view) break;
    if (!view.node.isConnected) continue;
    activeLoads++;
    view.load().finally(() => {
      activeLoads--;
      drainQueue();
    });
  }
}

function conversationView(summary: SessionSummary): ConversationView {
  const node = el('section', 'conversation');
  node.dataset.id = summary.id;
  node.setAttribute('aria-labelledby', `conversation-${summary.id}`);
  node.setAttribute('aria-busy', 'true');
  const header = el('header', 'conversation-header');
  const heading = el('div', 'conversation-heading');
  const title = el('h2', '', summary.title);
  title.id = `conversation-${summary.id}`;
  title.title = summary.title;
  const actions = el('div', 'conversation-actions');
  const copyAll = el('button', 'button icon-button');
  copyAll.setAttribute('aria-label', 'Copy full transcript');
  copyAll.title = 'Copy full transcript';
  copyAll.append(icon('copy'));
  copyAll.disabled = true;
  const copyResume = el('button', 'button primary copy-resume', 'Copy resume command');
  copyResume.prepend(icon('terminal'));
  copyResume.setAttribute('aria-describedby', title.id);
  copyResume.title = `Copy resume command: ${summary.title}`;
  copyResume.disabled = true;
  const anchor = el('span', 'resume-anchor');
  const placeholder = el('span', 'button primary resume-placeholder', 'Copy resume command');
  placeholder.prepend(icon('terminal'));
  placeholder.setAttribute('aria-hidden', 'true');
  anchor.append(placeholder, copyResume);
  actions.append(copyAll, anchor);
  heading.append(title, actions);
  header.append(heading);
  if (summary.kind === 'chatgpt' || summary.archived)
    header.append(
      el(
        'p',
        'continuation-note',
        summary.kind === 'chatgpt'
          ? 'Starts a new Codex session with this transcript as context.'
          : 'Unarchives the session before resuming.',
      ),
    );
  const messages = el('div', 'conversation-messages');
  messages.append(el('div', 'conversation-loading', 'Loading messages…'));
  node.append(header, messages);
  const view: ConversationView = {
    node,
    status: 'idle',
    session: null,
    async load() {
      view.status = 'loading';
      node.setAttribute('aria-busy', 'true');
      const controller = new AbortController();
      detailControllers.add(controller);
      try {
        const session = await api(`sessions/${summary.id}?limit=50`, { signal: controller.signal });
        if (!node.isConnected) return;
        view.session = session;
        messages.replaceChildren(...session.messages.map((message) => messageNode(message, session.kind)));
        if (!session.messages.length)
          messages.append(el('p', 'empty-state', 'No messages in this conversation.'));
        if (session.hasMore) {
          const more = el('button', 'button secondary transcript-more', 'Load more messages');
          more.addEventListener('click', async () => {
            more.disabled = true;
            const controller = new AbortController();
            detailControllers.add(controller);
            try {
              const page = await api(`sessions/${session.id}?offset=${session.messages.length}&limit=50`, {
                signal: controller.signal,
              });
              if (!node.isConnected) return;
              session.messages.push(...page.messages);
              more.before(...page.messages.map((message) => messageNode(message, session.kind)));
              if (!page.hasMore) more.remove();
            } catch (error) {
              if (!(isRecord(error) && error.name === 'AbortError') && node.isConnected)
                toast(errorMessage(error));
            } finally {
              detailControllers.delete(controller);
              more.disabled = false;
            }
          });
          messages.append(more);
        }
        copyAll.disabled = false;
        copyResume.disabled = false;
        view.status = 'ready';
      } catch (error) {
        if ((isRecord(error) && error.name === 'AbortError') || !node.isConnected) return;
        view.status = 'error';
        const retry = el('button', 'button secondary', 'Retry');
        retry.addEventListener('click', () => enqueue(view));
        messages.replaceChildren(el('p', 'conversation-error', errorMessage(error)), retry);
      } finally {
        detailControllers.delete(controller);
        node.setAttribute('aria-busy', 'false');
        floatingResume.refresh();
      }
    },
  };
  copyResume.addEventListener('click', () => {
    if (view.session) void copy(view.session.commands[state.shell], copyResume);
  });
  copyAll.addEventListener('click', async () => {
    const session = view.session;
    if (!session) return;
    copyAll.disabled = true;
    try {
      const transcript = [...session.messages];
      while (transcript.length < session.messageCount) {
        const page = await api(`sessions/${session.id}?offset=${transcript.length}&limit=100`);
        if (!page.messages.length) break;
        transcript.push(...page.messages);
      }
      await copy(
        transcript
          .map(
            (message) =>
              `${message.role === 'user' ? 'You' : session.kind === 'chatgpt' ? 'ChatGPT' : 'Codex'}:\n${message.text}`,
          )
          .join('\n\n'),
      );
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      copyAll.disabled = false;
    }
  });
  floatingResume.register({ conversation: node, anchor, button: copyResume });
  return view;
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  state.q = $('search').value;
  searchTimer = setTimeout(() => loadSessions(), 180);
});
$('sort').addEventListener('change', () => {
  const value = $('sort').value;
  if (value !== 'newest' && value !== 'oldest' && value !== 'title') return;
  state.sort = value;
  loadSessions();
});
$('terminal-shell').addEventListener('change', () => {
  const value = $('terminal-shell').value;
  if (value === 'posix' || value === 'powershell') state.shell = value;
});
$('project-sort').addEventListener('change', () => {
  const value = $('project-sort').value;
  if (value !== 'az' && value !== 'za') return;
  state.projectSort = value;
  updateProjects(state.projects);
});
$('project-select').addEventListener('change', () => {
  state.project = $('project-select').value;
  loadSessions();
});
$('archive-select').addEventListener('change', () => {
  const value = $('archive-select').value;
  if (value !== 'active' && value !== 'archived') return;
  state.archive = value;
  loadSessions();
});
$('load-more').addEventListener('click', () => loadSessions(true));
$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  try {
    await api('refresh', { method: 'POST' });
    if (await loadSessions()) toast('History refreshed.');
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    $('refresh').disabled = false;
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if ($('library-controls').matches(':popover-open')) $('library-controls').hidePopover();
    $('search').focus();
  }
  if (
    event.key === 'Escape' &&
    !document.querySelector('dialog[open]') &&
    !$('library-controls').matches(':popover-open')
  ) {
    $('search').focus();
  }
});

try {
  const token = new URLSearchParams(location.hash.slice(1)).get('key');
  if (token) {
    await api('unlock', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    history.replaceState(null, '', location.pathname + location.search);
  }
  await loadSessions();
} catch (error) {
  $('notice').textContent = errorMessage(error);
  $('notice').hidden = false;
  $('conversation-feed').setAttribute('aria-busy', 'false');
  $('conversation-feed').replaceChildren(
    el('div', 'empty-state', 'Open the access link printed in your terminal to connect.'),
  );
}
