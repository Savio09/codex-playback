import type { Shell } from '../shared/types.js';

const sessionId = /^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/;

function validateTerminalArgument(value: string): void {
  // Shell quoting cannot protect text that a terminal consumes before the shell,
  // such as bracketed-paste escapes. Reject controls and direction overrides.
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value))
    throw new Error('Path contains an unsafe terminal character.');
}

export function quotePosix(value: string): string {
  validateTerminalArgument(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function quotePowerShell(value: string): string {
  validateTerminalArgument(value);
  // PowerShell recognizes U+2018 through U+201B as single-quote delimiters too.
  return `'${value.replace(/['\u2018-\u201b]/gu, (quote) => quote + quote)}'`;
}

export function resumeCommand(
  session: { id: string; cwd?: string; archived?: boolean; codexHome?: string },
  shell: Shell = 'posix',
): string {
  if (!sessionId.test(session.id)) throw new Error('Invalid session ID');
  if (!['posix', 'powershell'].includes(shell)) throw new Error('Unsupported shell');
  const prefix = shell === 'posix' && session.codexHome ? `CODEX_HOME=${quotePosix(session.codexHome)} ` : '';
  const resume = `${prefix}codex resume ${session.id}`;
  const restore = `${prefix}codex unarchive ${session.id}`;
  if (shell === 'powershell') {
    let command = resume;
    if (session.archived) command = `${restore}; if ($?) { ${command} }`;
    if (session.cwd)
      command = `Set-Location -LiteralPath ${quotePowerShell(session.cwd)}; if ($?) { ${command} }`;
    if (session.codexHome) command = `$env:CODEX_HOME = ${quotePowerShell(session.codexHome)}; ${command}`;
    return command;
  }
  return [session.cwd && `cd -- ${quotePosix(session.cwd)}`, session.archived && restore, resume]
    .filter(Boolean)
    .join(' && ');
}
