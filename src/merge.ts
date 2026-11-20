import type { BranchRef } from './branches.js';
import { sameFunctions, type SameFunction } from './functions.js';
import { changedFiles, countCommits, git, mergeBase, renamedFiles, shortSha } from './git.js';

export interface ConflictHunk {
  /** Linhas (1-based) dos marcadores no arquivo mesclado. Esse arquivo não existe no disco: use oursLine/theirsLine. */
  mergedStart: number;
  mergedEnd: number;
  /** Linha (1-based) onde o trecho começa no arquivo da sua branch. Null se não foi possível localizar. */
  oursLine: number | null;
  /** Linha (1-based) onde o trecho começa no arquivo do destino. Null se não foi possível localizar. */
  theirsLine: number | null;
  /** Trecho da sua branch. */
  ours: string[];
  /** Trecho da branch de destino. */
  theirs: string[];
  /** Como o trecho era no ponto de partida (estilo zdiff3). Vazio se o trecho não existia. */
  base: string[];
  oursTotal: number;
  theirsTotal: number;
  baseTotal: number;
}

export interface TouchInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface ConflictFile {
  path: string;
  /** Tipo informado pelo git: `contents`, `modify/delete`, `add/add`, `rename/delete`… */
  kind: string;
  hunks: ConflictHunk[];
  /** Quem mexeu no arquivo na branch de destino desde o ponto de partida. */
  lastTouchOnTarget: TouchInfo | null;
  /** `regenerate-lockfile`: conflito em lockfile se resolve gerando de novo, nunca na mão. */
  hint?: 'regenerate-lockfile';
  /** Resultado do merge estruturado (Mergiraf), quando rodou. */
  structured?: StructuredResult;
}

export interface StructuredResult {
  tool: 'mergiraf';
  /** `line-only`: o Mergiraf junta pela estrutura do código; `real`: as mudanças se contradizem. */
  result: 'line-only' | 'real' | 'error';
  detail?: string;
}

/** Lockfiles: conflito neles se resolve regenerando (npm install etc.). */
export const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|Cargo\.lock)$/;

export interface MergeResult {
  target: string;
  targetRef: string;
  status: 'clean' | 'conflict' | 'error' | 'unrelated';
  mergeBase: string | null;
  /** Commits do destino que a sua branch ainda não tem. */
  behind: number;
  /** Commits da sua branch que o destino ainda não tem. */
  ahead: number;
  conflicts: ConflictFile[];
  /** Arquivos alterados dos dois lados que o git juntou sozinho. Vale conferir. */
  autoMerged: string[];
  /** Arquivos que você alterou e que o destino renomeou: o git leva a sua mudança para o nome novo. */
  renamedOnTarget: Array<{ from: string; to: string }>;
  /** Arquivos juntados sozinhos em que os dois lados alteraram a mesma função (risco de lógica). */
  sameFunction: SameFunction[];
  error?: string;
}

export interface MergeTreeRecord {
  paths: string[];
  type: string;
  message: string;
}

export interface MergeTreeOutput {
  tree: string;
  files: string[];
  records: MergeTreeRecord[];
}

/** Interpreta a saída de `git merge-tree --write-tree --name-only -z`. */
export function parseMergeTree(stdout: string): MergeTreeOutput {
  const parts = stdout.split('\0');
  const tree = parts[0] ?? '';
  let i = 1;
  const files: string[] = [];
  while (i < parts.length && parts[i] !== '') files.push(parts[i++]!);
  if (parts[i] === '') i++;
  const records: MergeTreeRecord[] = [];
  while (i < parts.length) {
    const count = Number.parseInt(parts[i] ?? '', 10);
    if (!Number.isFinite(count)) break;
    i++;
    const paths = parts.slice(i, i + count);
    i += count;
    const type = parts[i++] ?? '';
    const message = (parts[i++] ?? '').trim();
    records.push({ paths, type, message });
  }
  return { tree, files, records };
}

const PREVIEW_LINES = 6;

/** Extrai os trechos em conflito de um arquivo com marcadores `<<<<<<<`. */
export function parseConflictHunks(text: string): ConflictHunk[] {
  const lines = text.split('\n');
  const hunks: ConflictHunk[] = [];
  let state: 'out' | 'ours' | 'base' | 'theirs' = 'out';
  let start = 0;
  let ours: string[] = [];
  let theirs: string[] = [];
  let base: string[] = [];
  lines.forEach((line, idx) => {
    if (state === 'out') {
      if (line.startsWith('<<<<<<< ') || line === '<<<<<<<') {
        state = 'ours';
        start = idx + 1;
        ours = [];
        theirs = [];
        base = [];
      }
      return;
    }
    if (line.startsWith('|||||||')) {
      state = 'base';
    } else if (line === '=======') {
      state = 'theirs';
    } else if (line.startsWith('>>>>>>> ') || line === '>>>>>>>') {
      hunks.push({
        mergedStart: start,
        mergedEnd: idx + 1,
        oursLine: null,
        theirsLine: null,
        ours: ours.slice(0, PREVIEW_LINES),
        theirs: theirs.slice(0, PREVIEW_LINES),
        base: base.slice(0, PREVIEW_LINES),
        oursTotal: ours.length,
        theirsTotal: theirs.length,
        baseTotal: base.length,
      });
      state = 'out';
    } else if (state === 'ours') {
      ours.push(line);
    } else if (state === 'theirs') {
      theirs.push(line);
    } else if (state === 'base') {
      base.push(line);
    }
  });
  return hunks;
}

function kindOf(path: string, records: MergeTreeRecord[]): string {
  const rec = records.find((r) => r.type.startsWith('CONFLICT') && r.paths.includes(path));
  const m = rec?.type.match(/^CONFLICT \((.+)\)$/);
  return m?.[1] ?? 'desconhecido';
}

export function lastTouch(cwd: string, range: string, path: string): TouchInfo | null {
  const res = git(cwd, ['log', '-1', '--format=%H%x00%an%x00%as%x00%s', range, '--', path]);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const [sha = '', author = '', date = '', subject = ''] = res.stdout.trim().split('\0');
  return { sha: shortSha(sha), author, date, subject };
}

const MAX_BLOB_BYTES = 1_000_000;

/** Linha (1-based) onde o bloco aparece, contíguo, no texto. Null se não aparece ou o bloco é vazio. */
export function locateBlock(text: string | null, block: string[]): number | null {
  if (!text || block.length === 0) return null;
  const lines = text.split('\n');
  outer: for (let i = 0; i + block.length <= lines.length; i++) {
    for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) continue outer;
    return i + 1;
  }
  return null;
}

function blob(cwd: string, spec: string): string | null {
  const res = git(cwd, ['show', spec]);
  return res.code === 0 && res.stdout.length <= MAX_BLOB_BYTES && !res.stdout.includes('\0') ? res.stdout : null;
}

function readHunks(cwd: string, tree: string, path: string, headRef: string, targetRef: string): ConflictHunk[] {
  const merged = blob(cwd, `${tree}:${path}`);
  if (merged === null) return [];
  const hunks = parseConflictHunks(merged);
  if (hunks.length === 0) return hunks;
  const oursText = blob(cwd, `${headRef}:${path}`);
  const theirsText = blob(cwd, `${targetRef}:${path}`);
  return hunks.map((h) => ({ ...h, oursLine: locateBlock(oursText, h.ours), theirsLine: locateBlock(theirsText, h.theirs) }));
}

/** Merge a seco: nada é escrito na árvore de trabalho nem nas branches. */
export function simulateMerge(cwd: string, headRef: string, target: BranchRef): MergeResult {
  const base: MergeResult = {
    target: target.name,
    targetRef: target.ref,
    status: 'clean',
    mergeBase: null,
    behind: 0,
    ahead: 0,
    conflicts: [],
    autoMerged: [],
    renamedOnTarget: [],
    sameFunction: [],
  };

  const mb = mergeBase(cwd, target.ref, headRef);
  if (!mb) return { ...base, status: 'unrelated', error: 'as branches não têm histórico em comum' };
  base.mergeBase = mb;
  base.behind = countCommits(cwd, `${headRef}..${target.ref}`);
  base.ahead = countCommits(cwd, `${target.ref}..${headRef}`);

  // zdiff3: os marcadores trazem também como o trecho era no ponto de partida
  const res = git(cwd, ['-c', 'merge.conflictStyle=zdiff3', 'merge-tree', '--write-tree', '--name-only', '-z', headRef, target.ref]);
  if (res.code !== 0 && res.code !== 1) {
    return { ...base, status: 'error', error: res.stderr.trim() || `git merge-tree saiu com ${res.code}` };
  }
  const parsed = parseMergeTree(res.stdout);

  const oursChanged = new Set(changedFiles(cwd, mb, headRef));
  base.renamedOnTarget = renamedFiles(cwd, mb, target.ref).filter((r) => oursChanged.has(r.from));
  const targetChanged = changedFiles(cwd, mb, target.ref);
  const conflictPaths = new Set(parsed.files);
  const both = targetChanged.filter((f) => oursChanged.has(f) && !conflictPaths.has(f)).sort();

  base.sameFunction = sameFunctions(cwd, mb, headRef, target.ref, both);
  if (res.code === 0) return { ...base, status: 'clean', autoMerged: both };

  const conflicts: ConflictFile[] = [...conflictPaths].sort().map((path) => ({
    path,
    kind: kindOf(path, parsed.records),
    hunks: readHunks(cwd, parsed.tree, path, headRef, target.ref),
    lastTouchOnTarget: lastTouch(cwd, `${mb}..${target.ref}`, path),
    ...(LOCKFILE.test(path) ? { hint: 'regenerate-lockfile' as const } : {}),
  }));
  return { ...base, status: 'conflict', conflicts, autoMerged: both };
}
