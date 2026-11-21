import type { BranchRef } from './branches.js';
import type { Config } from './config.js';
import { compileRegexes } from './config.js';
import type { PrInfo } from './github.js';
import { changedFiles, git, isAncestor, mergeBase, renamedFiles, revParse } from './git.js';

export { renamedFiles } from './git.js';
import { sameFunctions, type SameFunction } from './functions.js';
import { parseMergeTree } from './merge.js';
import type { TouchInfo } from './merge.js';

export interface OverlapEntry {
  branch: string;
  ref: string;
  pr: PrInfo | null;
  /**
   * `ours-contains-theirs`: a sua branch já carrega os commits dela (empilhada: ela entra primeiro).
   * `theirs-contains-ours`: ela carrega os seus commits (depende da sua).
   */
  relation: 'independent' | 'ours-contains-theirs' | 'theirs-contains-ours';
  sharedFiles: string[];
  /** Arquivos em comum que a configuração manda ignorar (lockfiles, por exemplo). */
  ignoredShared: string[];
  /** Arquivos que você alterou e que a outra branch renomeou. */
  renames: Array<{ from: string; to: string }>;
  /** Funções que esta branch e a sua alteram (o git junta sozinho, mas a lógica pode colidir). */
  sameFunctions: SameFunction[];
  wouldConflict: boolean;
  conflictFiles: string[];
  lastCommit: TouchInfo | null;
  ageDays: number;
  /** Só na branch empilhada: commits dela que o destino não tem (maior = base mais próxima da sua). */
  stackDepth?: number;
}

export interface OverlapInput {
  cwd: string;
  headRef: string;
  primary: BranchRef;
  candidates: BranchRef[];
  prs: PrInfo[];
  cfg: Config;
  /** Nomes de branch que não devem ser comparadas (a sua e as principais). */
  exclude: Set<string>;
  nowMs?: number;
}

interface RefInfo {
  sha: string;
  epochSec: number;
  touch: TouchInfo;
}

/** Uma chamada ao git para todas as branches: sha, data e último commit (em vez de várias por branch). */
function refTable(cwd: string): Map<string, RefInfo> {
  const res = git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(authorname)%00%(authordate:short)%00%(contents:subject)', 'refs/heads', 'refs/remotes']);
  const out = new Map<string, RefInfo>();
  if (res.code !== 0) return out;
  for (const line of res.stdout.split('\n')) {
    const [ref = '', sha = '', ct = '0', author = '', date = '', subject = ''] = line.split('\0');
    if (ref) out.set(ref, { sha, epochSec: Number.parseInt(ct, 10) || 0, touch: { sha: sha.slice(0, 7), author, date, subject } });
  }
  return out;
}

/** Branches já contidas no destino (uma chamada ao git). */
function mergedInto(cwd: string, ref: string): Set<string> {
  const res = git(cwd, ['for-each-ref', '--merged', ref, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  return new Set(res.code === 0 ? res.stdout.split('\n').filter(Boolean) : []);
}

function lastCommitOf(cwd: string, ref: string): { touch: TouchInfo | null; epochSec: number } {
  const res = git(cwd, ['log', '-1', '--format=%H%x00%an%x00%as%x00%s%x00%ct', ref]);
  if (res.code !== 0 || !res.stdout.trim()) return { touch: null, epochSec: 0 };
  const [sha = '', author = '', date = '', subject = '', ct = '0'] = res.stdout.trim().split('\0');
  return { touch: { sha: sha.slice(0, 7), author, date, subject }, epochSec: Number.parseInt(ct, 10) || 0 };
}

/**
 * Procura outras branches (e PRs) que mexem nos mesmos arquivos que a sua e diz
 * quais iriam conflitar com ela quando as duas forem mergeadas.
 */
export function findOverlaps(input: OverlapInput): OverlapEntry[] {
  const { cwd, headRef, primary, candidates, prs, cfg, exclude } = input;
  const nowMs = input.nowMs ?? Date.now();
  const ignore = compileRegexes(cfg.overlap.ignorePaths);
  const headSha = revParse(cwd, headRef);

  const ourBase = mergeBase(cwd, primary.ref, headRef);
  const ours = new Set(ourBase ? changedFiles(cwd, ourBase, headRef) : []);
  const prByBranch = new Map(prs.map((p) => [p.headRefName, p]));
  const out: OverlapEntry[] = [];
  const refs = refTable(cwd);
  const merged = mergedInto(cwd, primary.ref);

  for (const cand of candidates) {
    if (exclude.has(cand.name)) continue;
    const info = refs.get(cand.ref);
    const candSha = info?.sha ?? revParse(cwd, cand.ref);
    if (candSha === headSha) continue;
    if (info ? merged.has(cand.ref) : isAncestor(cwd, cand.ref, primary.ref)) continue; // já foi mergeada

    const { touch, epochSec } = info ?? lastCommitOf(cwd, cand.ref);
    const ageDays = Math.floor((nowMs / 1000 - epochSec) / 86400);
    if (ageDays > cfg.overlap.maxAgeDays) continue;

    // Primeiro o barato: sem arquivo em comum, não há conflito nem empilhamento possível.
    const candBase = mergeBase(cwd, primary.ref, cand.ref);
    const theirs = candBase ? changedFiles(cwd, candBase, cand.ref) : [];
    const shared = theirs.filter((f) => ours.has(f)).sort();
    if (shared.length === 0) continue;
    const ignoredShared = shared.filter((f) => ignore.some((re) => re.test(f)));
    const sharedFiles = shared.filter((f) => !ignoredShared.includes(f));
    const renames = candBase ? renamedFiles(cwd, candBase, cand.ref).filter((r) => ours.has(r.from)) : [];

    const relation: OverlapEntry['relation'] = isAncestor(cwd, cand.ref, headRef)
      ? 'ours-contains-theirs'
      : isAncestor(cwd, headRef, cand.ref)
        ? 'theirs-contains-ours'
        : 'independent';

    if (relation === 'independent' && sharedFiles.length === 0) continue;

    let wouldConflict = false;
    let conflictFiles: string[] = [];
    if (relation === 'independent') {
      const res = git(cwd, ['merge-tree', '--write-tree', '--name-only', '-z', headRef, cand.ref]);
      if (res.code === 1) {
        wouldConflict = true;
        conflictFiles = parseMergeTree(res.stdout).files.filter((f) => !ignore.some((re) => re.test(f)));
        if (conflictFiles.length === 0) wouldConflict = false; // só lockfiles
      }
    }

    out.push({
      branch: cand.name,
      ref: cand.ref,
      pr: prByBranch.get(cand.name) ?? null,
      relation,
      sharedFiles,
      renames,
      sameFunctions: !wouldConflict && relation === 'independent' && sharedFiles.length > 0 ? sameFunctions(cwd, mergeBase(cwd, headRef, cand.ref) ?? candBase ?? '', headRef, cand.ref, sharedFiles) : [],
      ignoredShared,
      wouldConflict,
      conflictFiles,
      lastCommit: touch,
      ageDays,
      ...(relation === 'ours-contains-theirs' ? { stackDepth: Number(git(cwd, ['rev-list', '--count', `${primary.ref}..${cand.ref}`]).stdout.trim()) || 0 } : {}),
    });
  }

  const rank = (e: OverlapEntry) => (e.wouldConflict ? 0 : e.relation !== 'independent' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.sharedFiles.length - a.sharedFiles.length);
}
