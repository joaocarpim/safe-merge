import { spawnSync } from 'node:child_process';

export interface ToolResult {
  /** A ferramenta não está instalada (ou não está no PATH). */
  missing: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ToolOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Executa uma ferramenta externa sem shell. É injetável: os testes passam um executor falso com
 * saídas no formato real, e a análise nunca depende de a ferramenta existir.
 */
export type ToolRunner = (cmd: string, args: string[], opts?: ToolOptions) => ToolResult;

export const runTool: ToolRunner = (cmd, args, opts = {}) => {
  const proc = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 256 * 1024 * 1024,
    env: opts.env ?? process.env,
    windowsHide: true,
  });
  const err = proc.error as NodeJS.ErrnoException | undefined;
  if (err?.code === 'ENOENT') return { missing: true, code: 127, stdout: '', stderr: `${cmd} não encontrado`, timedOut: false };
  const timedOut = err?.code === 'ETIMEDOUT';
  return {
    missing: false,
    code: timedOut ? 124 : (proc.status ?? 1),
    stdout: proc.stdout ?? '',
    stderr: err && !timedOut ? err.message : (proc.stderr ?? ''),
    timedOut,
  };
};

export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
