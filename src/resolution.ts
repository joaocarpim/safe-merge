import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { BranchRef } from './branches.js';
import type { Config } from './config.js';
import { git } from './git.js';
import { parseMergeTree } from './merge.js';
import { resolveIsolation, runStep } from './semantic.js';
import type { ToolRunner } from './tools.js';
import { withWorktree } from './worktree.js';

export interface ResolutionCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ResolutionResult {
  /**
   * `verified`: sem marcadores, sintaxe ok e build/testes passaram no merge com a proposta.
   * `unverified`: passou no que deu para checar, mas sem comando de testes não é "verificada".
   * `failed`: alguma checagem falhou. `incomplete`: falta proposta para algum arquivo em conflito.
   */
  status: 'verified' | 'unverified' | 'failed' | 'incomplete';
  conflictFiles: string[];
  checks: ResolutionCheck[];
}

export interface ResolutionInput {
  repoDir: string;
  headRef: string;
  target: BranchRef;
  /** Conteúdo proposto por arquivo (caminho no projeto → texto completo do arquivo). */
  proposals: Record<string, string>;
  cfg: Config;
  tools: ToolRunner;
  testCommand?: string | null;
  buildCommand?: string | null;
}

const MARKER = /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)( |$)/m;

/** Checagem de sintaxe sem dependências: JSON e JavaScript (node --check). Outras linguagens: build/testes. */
export function syntaxCheck(path: string, text: string, dir: string): ResolutionCheck | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(text);
      return { name: `sintaxe ${path}`, ok: true };
    } catch (err) {
      return { name: `sintaxe ${path}`, ok: false, detail: (err as Error).message };
    }
  }
  if (['.js', '.cjs', '.mjs'].includes(ext)) {
    const res = spawnSync(process.execPath, ['--check', join(dir, path)], { encoding: 'utf8', timeout: 30_000 });
    return { name: `sintaxe ${path}`, ok: res.status === 0, detail: res.status === 0 ? undefined : (res.stderr ?? '').split(dir).join('.').trim().split('\n').slice(0, 5).join('\n') };
  }
  return null;
}

/**
 * Aplica a proposta numa cópia temporária do merge e verifica. Nunca toca na branch, no índice ou nos
 * arquivos do usuário: quem decide aplicar é a pessoa, depois de ver o resultado.
 */
export function verifyResolution(input: ResolutionInput): ResolutionResult {
  const { repoDir, headRef, target, proposals, cfg } = input;
  const mt = git(repoDir, ['merge-tree', '--write-tree', '--name-only', '-z', headRef, target.ref]);
  if (mt.code !== 0 && mt.code !== 1) return { status: 'failed', conflictFiles: [], checks: [{ name: 'merge', ok: false, detail: mt.stderr.trim() }] };
  const parsed = parseMergeTree(mt.stdout);
  const conflictFiles = parsed.files;
  const checks: ResolutionCheck[] = [];

  const missing = conflictFiles.filter((f) => !(f in proposals));
  const extra = Object.keys(proposals).filter((f) => !conflictFiles.includes(f));
  if (extra.length > 0) checks.push({ name: 'escopo', ok: false, detail: `proposta mexe em arquivos sem conflito: ${extra.join(', ')}` });
  if (missing.length > 0) {
    checks.push({ name: 'completa', ok: false, detail: `falta proposta para: ${missing.join(', ')}` });
    return { status: 'incomplete', conflictFiles, checks };
  }
  checks.push({ name: 'completa', ok: true, detail: `${conflictFiles.length} arquivo(s) em conflito com proposta` });

  for (const [path, text] of Object.entries(proposals)) {
    const marker = MARKER.test(text);
    checks.push({ name: `marcadores ${path}`, ok: !marker, detail: marker ? 'ainda há marcadores de conflito (<<<<<<< ======= >>>>>>>)' : undefined });
  }

  const identity = { GIT_AUTHOR_NAME: 'safemerge', GIT_AUTHOR_EMAIL: 'safemerge@localhost', GIT_COMMITTER_NAME: 'safemerge', GIT_COMMITTER_EMAIL: 'safemerge@localhost' };
  const made = git(repoDir, ['commit-tree', parsed.tree, '-p', headRef, '-p', target.ref, '-m', 'proposta de resolução (safemerge)'], { env: identity });
  if (made.code !== 0) return { status: 'failed', conflictFiles, checks: [...checks, { name: 'merge', ok: false, detail: made.stderr.trim() }] };

  withWorktree(repoDir, made.stdout.trim(), (dir) => {
    for (const [path, text] of Object.entries(proposals)) if (conflictFiles.includes(path)) writeFileSync(join(dir, path), text);
    for (const path of conflictFiles) {
      const c = syntaxCheck(path, readFileSync(join(dir, path), 'utf8'), dir);
      if (c) checks.push(c);
    }
    if (checks.some((c) => !c.ok)) return;
    const iso = resolveIsolation(cfg, input.tools);
    if ('error' in iso) {
      checks.push({ name: 'isolamento', ok: false, detail: iso.error });
      return;
    }
    const runner = { isolation: iso, tools: input.tools };
    for (const [name, cmd] of [['build', input.buildCommand], ['testes', input.testCommand]] as const) {
      if (!cmd) continue;
      const r = runStep(repoDir, dir, cmd, cfg, runner);
      checks.push({ name: `${name}: ${cmd}`, ok: r.code === 0, detail: r.code === 0 ? undefined : r.out.trim().split('\n').slice(-15).join('\n') });
      if (r.code !== 0) return;
    }
  });

  if (checks.some((c) => !c.ok)) return { status: 'failed', conflictFiles, checks };
  if (!input.testCommand) {
    checks.push({ name: 'testes', ok: true, detail: 'sem comando de testes: a proposta não pode ser marcada como verificada' });
    return { status: 'unverified', conflictFiles, checks };
  }
  return { status: 'verified', conflictFiles, checks };
}

export function renderResolution(r: ResolutionResult): string {
  const title = { verified: '✓ VERIFICADA', unverified: '! NÃO VERIFICADA (sem testes)', failed: '✗ FALHOU', incomplete: '✗ INCOMPLETA' }[r.status];
  const out = [`proposta de resolução: ${title}`, `arquivos em conflito: ${r.conflictFiles.join(', ') || 'nenhum'}`];
  for (const c of r.checks) {
    out.push(`  ${c.ok ? '✓' : '✗'} ${c.name}`);
    if (c.detail) for (const l of c.detail.split('\n')) out.push(`      ${l}`);
  }
  out.push('Nada foi aplicado. Para usar a proposta, copie os arquivos você mesmo depois de revisar.');
  return `${out.join('\n')}\n`;
}
