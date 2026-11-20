import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Config } from './config.js';
import { showFile } from './diff.js';
import { git, mergeBase } from './git.js';
import type { MergeResult, StructuredResult } from './merge.js';
import type { ToolRunner } from './tools.js';
import { firstLine } from './tools.js';
import { withTempDir } from './worktree.js';

export interface MergirafOutcome {
  /** `resolved`: juntou sem conflito. `conflict`: sobrou conflito. `error`: não rodou. */
  status: 'resolved' | 'conflict' | 'error';
  merged?: string;
  detail?: string;
}

/**
 * Chama o Mergiraf (programa externo, GPLv3: nunca embutido) com as três versões do arquivo.
 * As versões ficam numa pasta temporária com o mesmo nome do arquivo, porque o Mergiraf
 * escolhe a linguagem pela extensão.
 */
export function runMergiraf(tools: ToolRunner, cfg: Config, path: string, base: string, ours: string, theirs: string): MergirafOutcome {
  return withTempDir((tmp) => {
    const name = basename(path);
    const files = { base, left: ours, right: theirs } as const;
    const paths: Record<string, string> = {};
    for (const [side, text] of Object.entries(files)) {
      mkdirSync(join(tmp, side));
      paths[side] = join(tmp, side, name);
      writeFileSync(paths[side]!, text);
    }
    const out = join(tmp, `out-${name}`);
    const res = tools(cfg.security.tools.mergiraf, ['merge', paths.base!, paths.left!, paths.right!, '-o', out], { cwd: tmp, timeoutMs: 120_000 });
    if (res.missing) return { status: 'error', detail: 'mergiraf não instalado' };
    const merged = existsSync(out) ? readFileSync(out, 'utf8') : res.stdout;
    if (res.code === 0 && !/^<<<<<<< /m.test(merged)) return { status: 'resolved', merged };
    if (res.code === 0 || res.code === 1) return { status: 'conflict', merged };
    return { status: 'error', detail: `mergiraf saiu com ${res.code}: ${firstLine(res.stderr) || 'sem mensagem'}` };
  });
}

export function mergirafAvailable(tools: ToolRunner, cfg: Config): boolean {
  const res = tools(cfg.security.tools.mergiraf, ['--version'], { timeoutMs: 15_000 });
  return !res.missing && res.code === 0;
}

/**
 * Para cada arquivo em conflito com o destino, pergunta ao Mergiraf se o conflito é real ou só de linha
 * (as duas mudanças tocam linhas vizinhas mas não se contradizem na estrutura do código).
 */
export function classifyConflicts(cwd: string, headRef: string, merge: MergeResult, tools: ToolRunner, cfg: Config): void {
  if (!merge.mergeBase) return;
  for (const c of merge.conflicts) {
    if (c.kind !== 'contents' || c.hint) continue; // lockfile, apagado × alterado etc.: Mergiraf não ajuda
    const base = showFile(cwd, merge.mergeBase, c.path) ?? '';
    const ours = showFile(cwd, headRef, c.path);
    const theirs = showFile(cwd, merge.targetRef, c.path);
    if (ours === null || theirs === null) continue;
    const r = runMergiraf(tools, cfg, c.path, base, ours, theirs);
    const result: StructuredResult =
      r.status === 'resolved' ? { tool: 'mergiraf', result: 'line-only' } : r.status === 'conflict' ? { tool: 'mergiraf', result: 'real' } : { tool: 'mergiraf', result: 'error', detail: r.detail };
    c.structured = result;
  }
}

// ─── replay: refaz merges antigos e compara git × Mergiraf × o que o dev commitou ─────────────────

export interface ReplayFile {
  path: string;
  /** `same`: Mergiraf resolveu igual ao commit. `different`: resolveu diferente (possível merge errado). */
  mergiraf: 'same' | 'different' | 'unresolved' | 'error' | 'skipped';
}

export interface ReplayMerge {
  sha: string;
  subject: string;
  date: string;
  conflicts: ReplayFile[];
}

export interface ReplaySummary {
  schema: 1;
  repo: string;
  /** Merges com dois pais examinados. */
  merges: number;
  mergesWithConflict: number;
  conflictFiles: number;
  mergiraf: { available: boolean; same: number; different: number; unresolved: number; errors: number };
  details: ReplayMerge[];
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

export interface ReplayOptions {
  limit: number;
  tools: ToolRunner;
  cfg: Config;
  /** Ponto de partida do histórico. Padrão: HEAD. */
  rev?: string;
  useMergiraf?: boolean;
}

/** Só leitura: usa merge-tree e cat-file; nada é escrito no repositório além de objetos soltos do git. */
export function replay(cwd: string, opts: ReplayOptions): ReplaySummary {
  const rev = opts.rev ?? 'HEAD';
  const list = git(cwd, ['rev-list', '--merges', `--max-count=${opts.limit}`, '--format=%P%x00%s%x00%as', rev]);
  const merges: ReplayMerge[] = [];
  const useMergiraf = opts.useMergiraf !== false && mergirafAvailable(opts.tools, opts.cfg);
  const summary: ReplaySummary = {
    schema: 1,
    repo: basename(cwd),
    merges: 0,
    mergesWithConflict: 0,
    conflictFiles: 0,
    mergiraf: { available: useMergiraf, same: 0, different: 0, unresolved: 0, errors: 0 },
    details: merges,
  };
  const lines = list.stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!.match(/^commit ([0-9a-f]+)$/);
    if (!header) continue;
    const sha = header[1]!;
    const [parentsRaw = '', subject = '', date = ''] = (lines[i + 1] ?? '').split('\0');
    const parents = parentsRaw.trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 2) continue; // octopus: fora do escopo
    summary.merges++;
    const [p1, p2] = parents as [string, string];
    const mt = git(cwd, ['merge-tree', '--write-tree', '--name-only', '-z', p1, p2]);
    if (mt.code !== 1) continue;
    const files = mt.stdout.split('\0').slice(1);
    const end = files.indexOf('');
    const paths = (end === -1 ? files : files.slice(0, end)).filter(Boolean);
    if (paths.length === 0) continue;
    summary.mergesWithConflict++;
    const mb = mergeBase(cwd, p1, p2);
    const conflicts: ReplayFile[] = paths.map((path) => {
      summary.conflictFiles++;
      if (!useMergiraf || !mb) return { path, mergiraf: 'skipped' };
      const ours = showFile(cwd, p1, path);
      const theirs = showFile(cwd, p2, path);
      const committed = showFile(cwd, sha, path);
      if (ours === null || theirs === null) return { path, mergiraf: 'skipped' };
      const r = runMergiraf(opts.tools, opts.cfg, path, showFile(cwd, mb, path) ?? '', ours, theirs);
      if (r.status === 'error') {
        summary.mergiraf.errors++;
        return { path, mergiraf: 'error' };
      }
      if (r.status === 'conflict') {
        summary.mergiraf.unresolved++;
        return { path, mergiraf: 'unresolved' };
      }
      const same = committed !== null && normalize(committed) === normalize(r.merged ?? '');
      if (same) summary.mergiraf.same++;
      else summary.mergiraf.different++;
      return { path, mergiraf: same ? 'same' : 'different' };
    });
    merges.push({ sha: sha.slice(0, 7), subject, date, conflicts });
  }
  return summary;
}

export function renderReplay(s: ReplaySummary): string {
  const out: string[] = [];
  out.push(`safemerge replay · ${s.repo}`);
  out.push('');
  out.push(`merges examinados ............ ${s.merges}`);
  out.push(`merges com conflito no git ... ${s.mergesWithConflict}`);
  out.push(`arquivos em conflito ......... ${s.conflictFiles}`);
  if (s.mergiraf.available) {
    const tried = s.mergiraf.same + s.mergiraf.different + s.mergiraf.unresolved;
    out.push('');
    out.push('Mergiraf nos mesmos arquivos:');
    out.push(`  resolveu igual ao que o dev commitou ... ${s.mergiraf.same}`);
    out.push(`  resolveu diferente (conferir!) ......... ${s.mergiraf.different}`);
    out.push(`  continuou em conflito .................. ${s.mergiraf.unresolved}`);
    if (s.mergiraf.errors) out.push(`  erro ao rodar .......................... ${s.mergiraf.errors}`);
    if (tried > 0) out.push(`  conflitos que somem sem merge diferente: ${s.mergiraf.same} de ${tried}`);
  } else {
    out.push('');
    out.push('Mergiraf: sem cobertura (não instalado). Só os conflitos do git foram contados.');
  }
  const changed = s.details.flatMap((m) => m.conflicts.filter((c) => c.mergiraf === 'different').map((c) => `  ${m.sha} ${c.path}  (${m.subject})`));
  if (changed.length > 0) {
    out.push('');
    out.push('Resolvidos diferente do commit (pode ser merge errado; confira):');
    out.push(...changed.slice(0, 30));
  }
  return `${out.join('\n')}\n`;
}
