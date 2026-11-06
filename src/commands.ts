import type { Shell } from '../shared/types.js';

const sessionId = /^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/;

export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
      command = `Set-Location -LiteralPath '${session.cwd.replaceAll("'", "''")}'; if ($?) { ${command} }`;
    if (session.codexHome)
      command = `$env:CODEX_HOME = '${session.codexHome.replaceAll("'", "''")}'; ${command}`;
    return command;
  }
  return [session.cwd && `cd -- ${quotePosix(session.cwd)}`, session.archived && restore, resume]
    .filter(Boolean)
    .join(' && ');
}
