import type { Project, ProjectSort } from '../shared/types.js';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const paths = {
  playback: 'M5 20V4h9a6 6 0 0 1 0 12H5m5-8 5 4-5 4',
  sort: 'M4 6h16M4 12h11M4 18h6',
  check: 'm5 12 4 4L19 6',
  sparkles: 'm12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2',
  messages: 'M21 11a8 8 0 0 1-8 8H5l-4 3V9a8 8 0 0 1 8-8h4a8 8 0 0 1 8 8Z M6 8h9M6 12h6',
  archive: 'M3 3h18v5H3zM5 8v13h14V8M10 12h4',
  folder: 'M3 5h6l2 3h10v12H3z',
  copy: 'M9 9h12v12H9zM15 5V2H2v13h3',
  terminal: 'm4 6 6 6-6 6M13 18h7',
};
function isIconName(name: string | undefined): name is keyof typeof paths {
  return name !== undefined && Object.hasOwn(paths, name);
}
export function icon(name: string | undefined): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', isIconName(name) ? paths[name] : paths.messages);
  svg.append(path);
  return svg;
}
export function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (part.startsWith('`') && part.endsWith('`')) fragment.append(el('code', '', part.slice(1, -1)));
    else if (part.startsWith('**') && part.endsWith('**'))
      fragment.append(el('strong', '', part.slice(2, -2)));
    else fragment.append(document.createTextNode(part));
  }
  return fragment;
}

interface CodeToken {
  kind: 'text' | 'comment' | 'string' | 'keyword' | 'number';
  text: string;
}
export function codeTokens(text: string): CodeToken[] {
  // Consume unterminated literals through EOF (including a trailing backslash).
  // Requiring a closing quote made repeated escaped quotes trigger quadratic
  // rescanning from every quote in an incomplete or malicious code block.
  const pattern =
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|`(?:\\[\s\S]|[^`\\])*(?:`|\\?$))|\b(export|import|from|const|let|var|function|return|async|await|class|def|if|else|for|while|try|catch|throw|new|true|false|null|undefined|public|private|type|interface|func|package|fn|pub|use|mut|match|self)\b|\b\d+(?:\.\d+)?\b/g;
  const tokens: CodeToken[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) tokens.push({ kind: 'text', text: text.slice(offset, match.index) });
    tokens.push({
      kind: match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'keyword' : 'number',
      text: match[0],
    });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) tokens.push({ kind: 'text', text: text.slice(offset) });
  return tokens;
}

// Build nodes from text. Raw HTML, image URLs and scripts in history never become active content.
export function markdown(
  text: string,
  onCopy: (text: string, button: HTMLButtonElement) => void | Promise<void>,
): HTMLDivElement {
  const container = el('div', 'message-content');
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? '';
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/s);
    const marker = fence?.[1];
    if (marker) {
      const language = (fence?.[2] ?? '').trim().slice(0, 40) || 'code';
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) code.push(lines[i++] ?? '');
      if (i < lines.length) i++;
      const block = el('div', 'code-block');
      const head = el('div', 'code-head');
      const button = el('button', 'copy-code');
      button.append(icon('copy'), document.createTextNode('Copy code'));
      button.type = 'button';
      button.addEventListener('click', () => onCopy(code.join('\n'), button));
      head.append(el('span', 'code-language', language), button);
      const pre = el('pre');
      const content = el('code');
      const source = code.join('\n');
      if (
        /^(js|jsx|javascript|ts|tsx|typescript|json|python|py|go|rust|rs|bash|sh|shell)\b/i.test(language)
      ) {
        for (const token of codeTokens(source)) {
          content.append(
            token.kind === 'text'
              ? document.createTextNode(token.text)
              : el('span', `code-${token.kind}`, token.text),
          );
        }
      } else content.textContent = source;
      pre.append(content);
      block.append(head, pre);
      container.append(block);
    } else if (!line.trim()) i++;
    else if (/^\s*#{1,6}\s/.test(line)) {
      container.append(el('p', 'markdown-heading', line.replace(/^\s*#{1,6}\s+/, '')));
      i++;
    } else if (/^\s*[-*]\s/.test(line)) {
      const list = el('ul');
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i] ?? '')) {
        const item = el('li');
        item.append(inline((lines[i++] ?? '').replace(/^\s*[-*]\s+/, '')));
        list.append(item);
      }
      container.append(list);
    } else {
      // Every branch must advance, even if a future block matcher disagrees
      // with the paragraph boundary matcher below.
      const paragraph: string[] = [line];
      i++;
      while (
        i < lines.length &&
        (lines[i] ?? '').trim() &&
        !/^\s*(`{3,}|~{3,}|#{1,6}\s|[-*]\s)/.test(lines[i] ?? '')
      )
        paragraph.push(lines[i++] ?? '');
      const node = el('p');
      node.append(inline(paragraph.join('\n')));
      container.append(node);
    }
  }
  return container;
}

export function sortProjects<T extends Pick<Project, 'name' | 'cwd'>>(
  projects: readonly T[],
  order: ProjectSort = 'az',
): T[] {
  const direction = order === 'za' ? -1 : 1;
  return [...projects].sort(
    (a, b) => direction * (a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd)),
  );
}
