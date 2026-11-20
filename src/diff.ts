import { git } from './git.js';

export interface AddedLine {
  file: string;
  /** Linha (1-based) no arquivo da versão nova. */
  line: number;
  text: string;
}

const Q = ['-c', 'core.quotePath=false'];

/** Interpreta um diff unificado e devolve só as linhas acrescentadas, com a linha na versão nova. */
export function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let cur = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      cur = Number.parseInt(hunk[1]!, 10);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+')) {
      out.push({ file, line: cur, text: line.slice(1) });
      cur++;
    } else if (line.startsWith(' ')) {
      cur++;
    }
  }
  return out;
}

/** Linhas acrescentadas entre dois commits (sem contexto). */
export function addedLines(cwd: string, from: string, to: string, paths: string[] = []): AddedLine[] {
  const res = git(cwd, [...Q, 'diff', '--no-color', '--no-ext-diff', '-U0', '--no-renames', from, to, '--', ...paths]);
  return res.code === 0 ? parseAddedLines(res.stdout) : [];
}

/** Arquivos criados entre dois commits. */
export function addedFiles(cwd: string, from: string, to: string): string[] {
  const res = git(cwd, [...Q, 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', from, to]);
  return res.code === 0 ? res.stdout.split('\0').filter(Boolean) : [];
}

/** Arquivos criados ou alterados (não apagados) entre dois commits. */
export function touchedFiles(cwd: string, from: string, to: string): string[] {
  const res = git(cwd, [...Q, 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=AM', from, to]);
  return res.code === 0 ? res.stdout.split('\0').filter(Boolean) : [];
}

/** Conteúdo de um arquivo num commit, ou null se não existe / é binário / grande demais. */
export function showFile(cwd: string, rev: string, path: string, maxBytes = 5_000_000): string | null {
  const res = git(cwd, ['show', `${rev}:${path}`]);
  if (res.code !== 0 || res.stdout.length > maxBytes || res.stdout.includes('\0')) return null;
  return res.stdout;
}

/** Todos os arquivos de um commit. */
export function listTree(cwd: string, rev: string): string[] {
  const res = git(cwd, [...Q, 'ls-tree', '-r', '-z', '--name-only', rev]);
  return res.code === 0 ? res.stdout.split('\0').filter(Boolean) : [];
}

/** Texto da linha (1-based) ou null. */
export function lineAt(text: string | null, line: number | null): string | null {
  if (!text || !line) return null;
  const l = text.split('\n')[line - 1];
  return l === undefined ? null : l.replace(/\r$/, '');
}

/** Primeira linha (1-based) que contém o trecho, a partir de `from`. */
export function findLine(text: string, needle: string, from = 1): number | null {
  const lines = text.split('\n');
  for (let i = Math.max(0, from - 1); i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
  return null;
}
