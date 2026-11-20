import { definedNames } from './checks/symbols.js';
import { showFile } from './diff.js';
import { git } from './git.js';

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|py|go|rb|php|java|kt|cs)$/;

/** Faixas de linhas (do lado antigo) que um diff altera. Inserção pura vira faixa de uma linha. */
export function changedOldRanges(diff: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    out.push(len === 0 ? [start, start] : [start, start + len - 1]);
  }
  return out;
}

/**
 * Nome da função/método que contém a linha (1-based), olhando para cima até a definição mais próxima
 * com indentação menor ou igual. Heurística por texto: JS/TS, Python, Go, Ruby, PHP, Java, Kotlin, C#.
 */
export function enclosingFunction(lines: string[], line: number): string | null {
  const indentOf = (s: string) => s.length - s.trimStart().length;
  const target = lines[line - 1] ?? '';
  let maxIndent = target.trim() ? indentOf(target) : Number.POSITIVE_INFINITY;
  for (let i = line - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (ind > maxIndent) continue;
    const names = definedNames(l);
    const method = l.match(/^\s*(?:(?:public|private|protected|static|async|override|def|fun|func)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|, ]+)?\s*\{\s*$/);
    const name = names[0] ?? (method && !/^(if|for|while|switch|catch|function|return)$/.test(method[1]!) ? method[1]! : null);
    if (name) return name;
    maxIndent = Math.min(maxIndent, ind);
    if (ind === 0 && i < line - 1) break; // saiu do bloco de topo sem achar definição
  }
  return null;
}

/** Funções do arquivo (no ponto de partida) que o lado `ref` alterou. */
export function touchedFunctions(cwd: string, base: string, ref: string, path: string, baseText: string | null): Set<string> {
  const out = new Set<string>();
  if (!CODE_FILE.test(path) || baseText === null) return out;
  const res = git(cwd, ['diff', '--no-color', '--no-ext-diff', '-U0', '--no-renames', base, ref, '--', path]);
  if (res.code !== 0) return out;
  const lines = baseText.split('\n');
  for (const [a, b] of changedOldRanges(res.stdout)) {
    for (let l = Math.max(1, a); l <= Math.min(lines.length, b); l++) {
      const fn = enclosingFunction(lines, l);
      if (fn) out.add(fn);
    }
  }
  return out;
}

export interface SameFunction {
  path: string;
  functions: string[];
}

/**
 * Arquivos em que os dois lados alteraram a MESMA função, a partir do mesmo ponto de partida.
 * O git pode juntar sem conflito (linhas diferentes), mas a regra de negócio pode ficar errada.
 */
export function sameFunctions(cwd: string, base: string, oursRef: string, theirsRef: string, paths: string[]): SameFunction[] {
  const out: SameFunction[] = [];
  for (const path of paths) {
    if (!CODE_FILE.test(path)) continue;
    const baseText = showFile(cwd, base, path);
    const ours = touchedFunctions(cwd, base, oursRef, path, baseText);
    if (ours.size === 0) continue;
    const theirs = touchedFunctions(cwd, base, theirsRef, path, baseText);
    const both = [...ours].filter((f) => theirs.has(f)).sort();
    if (both.length) out.push({ path, functions: both });
  }
  return out;
}
