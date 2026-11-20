import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Contrato de eventos (versão 1). Uma linha JSON por evento em `events.ndjson`.
 * Ferramentas que acompanham a análise ao vivo e o CI leem este mesmo arquivo.
 */
export type SafemergeEvent =
  | { type: 'run.start'; head: string; headSha: string; targets: string[] }
  | { type: 'phase.start'; phase: Phase }
  | { type: 'phase.end'; phase: Phase; status: PhaseStatus; ms: number; summary: string }
  | { type: 'merge.result'; target: string; status: string; conflicts: number; behind: number }
  | { type: 'overlap.result'; branch: string; wouldConflict: boolean; shared: number }
  | { type: 'semantic.result'; target: string; status: string; cause?: string }
  | { type: 'security.result'; check: string; status: string; findings: number }
  | { type: 'run.end'; level: 'ok' | 'warn' | 'block'; reasons: string[] };

export type Phase = 'branches' | 'merge' | 'overlap' | 'semantic' | 'security';
export type PhaseStatus = 'ok' | 'warn' | 'block' | 'skipped' | 'error';

export type Emit = (event: SafemergeEvent) => void;

export const noopEmit: Emit = () => {};

export const EVENT_SCHEMA_VERSION = 1;

export function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return stamp;
}

/** Grava os eventos em arquivo, criando a pasta (e um .gitignore para ela) se precisar. */
export function fileEmitter(runDir: string, runId: string): { emit: Emit; path: string } {
  const path = join(runDir, 'events.ndjson');
  mkdirSync(dirname(path), { recursive: true });
  // `*` dentro da pasta de execuções ignora tudo nela, inclusive o próprio .gitignore: o git status fica limpo.
  const ignoreFile = join(dirname(runDir), '.gitignore');
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, '*\n');
  writeFileSync(path, '');
  const emit: Emit = (event) => {
    appendFileSync(path, `${JSON.stringify({ v: EVENT_SCHEMA_VERSION, run: runId, t: new Date().toISOString(), ...event })}\n`);
  };
  return { emit, path };
}
