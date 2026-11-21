import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AnalysisReport } from './analyze.js';
import type { MatrixResult } from './matrix.js';
import { renderMatrixMarkdown, renderMatrixText } from './matrix.js';
import { detectBranches, listBranches, pickRemote } from './branches.js';
import { loadConfig } from './config.js';
import { crossCheck, type ContractIssue, type RepoSide } from './contract.js';
import { git } from './git.js';

/**
 * Pasta com vários repositórios (ex.: front e back lado a lado): acha todos e analisa ao mesmo tempo,
 * um processo da CLI por repositório. Cada análise é a mesma de rodar dentro do repositório; aqui só se
 * junta o resultado. Só leitura, como o resto.
 */

export interface FoundRepo {
  path: string;
  name: string;
  /** Caminho relativo à pasta raiz. */
  relative: string;
  branch: string | null;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vscode', 'coverage', '.cache', '.safemerge']);

function readBranch(repo: string): string | null {
  try {
    let gitDir = join(repo, '.git');
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = join(repo, m[1]!.trim());
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1]! : null;
  } catch {
    return null;
  }
}

/** Repositórios até `maxDepth` níveis abaixo de `root` (não entra num repositório achado). */
export function findRepos(root: string, maxDepth = 3, limit = 30): FoundRepo[] {
  const out: FoundRepo[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit) return;
    if (existsSync(join(dir, '.git'))) {
      out.push({ path: dir, name: basename(dir), relative: dir === root ? '.' : dir.slice(root.length + 1).replace(/\\/g, '/'), branch: readBranch(dir) });
      return;
    }
    if (depth >= maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.has(e.name)).map((e) => e.name).sort();
    } catch {
      return;
    }
    for (const n of names) walk(join(dir, n), depth + 1);
  };
  walk(root, 0);
  return out;
}

export interface WorkspaceEntry {
  repo: FoundRepo;
  /** Análise da branch atual (modo padrão). */
  report?: AnalysisReport;
  /** Todas as branches abertas (com --all-branches). */
  matrix?: MatrixResult;
  error?: string;
  ms: number;
}

export interface WorkspaceResult {
  schema: 1;
  root: string;
  mode: 'current-branch' | 'all-branches';
  entries: WorkspaceEntry[];
  /** Rotas de API que uma branch muda e outro repositório usa (front × back). */
  contracts: ContractIssue[];
  durationMs: number;
}

export interface WorkspaceOptions {
  root: string;
  allBranches: boolean;
  /** Opções repassadas a cada análise (ex.: --no-fetch, --test-cmd auto, --base dev). */
  forward: string[];
  /** Quantos repositórios ao mesmo tempo. */
  jobs: number;
  depth: number;
  /** Como chamar a própria CLI (injetável nos testes). */
  cli?: { command: string; args: string[] };
}

/** Comando para rodar esta mesma CLI num processo filho (Node normal ou o do VS Code). */
export function selfCommand(): { command: string; args: string[] } {
  const electron = Boolean(process.versions.electron);
  // execArgv: mantém loaders e opções do Node com que esta CLI foi iniciada
  return { command: process.execPath, args: [...(electron ? ['--ms-enable-electron-run-as-node'] : []), ...process.execArgv, process.argv[1]!] };
}

export function runChild(cmd: { command: string; args: string[] }, cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd.command, [...cmd.args, ...args], { cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Roda a análise em todos os repositórios, `jobs` por vez. */
export async function analyzeWorkspace(opts: WorkspaceOptions): Promise<WorkspaceResult> {
  const started = Date.now();
  const repos = findRepos(opts.root, opts.depth);
  const cmd = opts.cli ?? selfCommand();
  const entries: WorkspaceEntry[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const i = next++;
      const repo = repos[i]!;
      const t0 = Date.now();
      const args = opts.allBranches ? ['matrix', '--format', 'json', ...opts.forward] : ['analyze', '--format', 'json', '--fail-on', 'never', ...opts.forward];
      const res = await runChild(cmd, repo.path, args);
      const entry: WorkspaceEntry = { repo, ms: Date.now() - t0 };
      try {
        if (res.code !== 0) throw new Error(res.stderr.trim().split('\n').pop() || `saiu com código ${res.code}`);
        const parsed = JSON.parse(res.stdout) as AnalysisReport | MatrixResult;
        if (opts.allBranches) entry.matrix = parsed as MatrixResult;
        else entry.report = parsed as AnalysisReport;
      } catch (err) {
        entry.error = (err as Error).message.replace(/^erro:\s*/, '');
      }
      entries[i] = entry;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.jobs, repos.length)) }, worker));
  let contracts: ContractIssue[] = [];
  try {
    contracts = repos.length > 1 ? workspaceContracts(opts.root, { allBranches: opts.allBranches, depth: opts.depth }) : [];
  } catch {
    /* heurística: se falhar, segue sem */
  }
  return { schema: 1, root: opts.root, mode: opts.allBranches ? 'all-branches' : 'current-branch', entries, contracts, durationMs: Date.now() - started };
}

const VERDICT_TEXT = { ok: '✓ PODE MERGEAR', warn: '! MERGEAR COM ATENÇÃO', block: '✗ NÃO MERGEAR' } as const;

/** Nível mais grave entre todos os repositórios (decide o código de saída). */
export function workspaceLevel(w: WorkspaceResult): 'ok' | 'warn' | 'block' | 'error' {
  const levels = w.entries.flatMap((e) => (e.error ? ['error'] : e.report ? [e.report.verdict.level] : (e.matrix?.rows ?? []).map((r) => r.level)));
  if (levels.includes('block')) return 'block';
  if (levels.includes('error')) return 'error';
  return levels.includes('warn') ? 'warn' : 'ok';
}

export function renderWorkspaceText(w: WorkspaceResult): string {
  const out = [`safemerge · ${w.entries.length} repositório(s) em ${basename(w.root)} · ${w.mode === 'all-branches' ? 'todas as branches abertas' : 'branch atual de cada um'} · ${(w.durationMs / 1000).toFixed(1)}s`, ''];
  for (const e of w.entries) {
    const title = `⏺ ${e.repo.relative}${e.repo.branch ? ` (${e.repo.branch})` : ''}`;
    if (e.error) {
      out.push(`${title}  erro: ${e.error}`, '');
      continue;
    }
    if (e.report) {
      const r = e.report;
      out.push(`${title} → ${r.primary}  ${VERDICT_TEXT[r.verdict.level]}  ${(e.ms / 1000).toFixed(1)}s`);
      const important = r.verdict.reasons.filter((x) => x.level !== 'info');
      for (const x of important.slice(0, 8)) out.push(`  ${x.level === 'block' ? '✗' : '!'} ${x.text}`);
      if (important.length > 8) out.push(`  … mais ${important.length - 8} motivo(s)`);
      const infos = r.verdict.reasons.length - important.length;
      if (infos) out.push(`  · ${infos} observação(ões)`);
      out.push('');
    }
    if (e.matrix) {
      out.push(title, ...renderMatrixText(e.matrix).trimEnd().split('\n').map((l) => `  ${l}`), '');
    }
  }
  if (w.contracts?.length) out.push(renderContractsText(w.contracts), '');
  else if (w.entries.length > 1) out.push('Entre repositórios: nenhuma rota de API mudada por uma branch e usada por outro repositório (heurística por texto).', '');
  out.push('somente leitura: nenhuma branch foi alterada. Detalhes de um repositório: entre nele e rode safemerge.');
  return `${out.join('\n')}\n`;
}

export function renderWorkspaceMarkdown(w: WorkspaceResult): string {
  const out = [`## safemerge: ${w.entries.length} repositório(s)`, ''];
  if (w.mode === 'current-branch') {
    out.push('| Repositório | Branch → destino | Veredito | Bloqueios | Avisos |', '|---|---|---|---|---|');
    for (const e of w.entries) {
      if (e.error) out.push(`| ${e.repo.relative} | ${e.repo.branch ?? ''} | erro: ${e.error.replace(/\|/g, '\\|')} | | |`);
      else if (e.report) {
        const r = e.report;
        const n = (l: string) => r.verdict.reasons.filter((x) => x.level === l).length;
        out.push(`| ${e.repo.relative} | \`${r.head.name ?? 'HEAD'}\` → \`${r.primary}\` | ${VERDICT_TEXT[r.verdict.level]} | ${n('block')} | ${n('warn')} |`);
      }
    }
    for (const e of w.entries.filter((x) => x.report && x.report.verdict.reasons.some((r) => r.level !== 'info'))) {
      out.push('', `### ${e.repo.relative}`, ...e.report!.verdict.reasons.filter((r) => r.level !== 'info').map((r) => `- ${r.level === 'block' ? '✗' : '!'} ${r.text}`));
    }
  } else {
    for (const e of w.entries) out.push(`### ${e.repo.relative}`, '', e.error ? `erro: ${e.error}` : renderMatrixMarkdown(e.matrix!), '');
  }
  if (w.contracts?.length) out.push('', '### Entre repositórios (contrato de API, heurística)', ...w.contracts.map((x) => `- ⚠️ ${x.message}`));
  return `${out.join('\n')}\n`;
}

// ───────────────────────────── contrato de API entre repositórios ─────────────────────────────

/**
 * Cruza os repositórios dois a dois (cada um como back e como front). Modo "branch atual": a branch de
 * cada um. Modo "todas": cada branch aberta do back (que mude rotas) com cada branch aberta do front.
 */
export function workspaceContracts(root: string, opts: { allBranches: boolean; depth?: number; maxAgeDays?: number }): ContractIssue[] {
  const repos = findRepos(root, opts.depth ?? 3);
  const sides = new Map<string, RepoSide[]>();
  for (const r of repos) {
    try {
      const cfg = loadConfig(r.path);
      const remote = pickRemote(r.path);
      const branches = listBranches(r.path, remote);
      const detected = detectBranches(r.path, cfg, branches);
      const base = detected.integration ?? detected.default;
      if (!base) continue;
      const mains = new Set(detected.main.map((b) => b.name));
      const nowSec = Date.now() / 1000;
      const heads = opts.allBranches
        ? [...branches.all.values()].filter((b) => !mains.has(b.name) && b.name !== base.name && (nowSec - (Number(git(r.path, ['log', '-1', '--format=%ct', b.ref]).stdout.trim()) || 0)) / 86400 <= (opts.maxAgeDays ?? cfg.overlap.maxAgeDays))
        : r.branch && r.branch !== base.name
          ? [branches.all.get(r.branch) ?? { name: r.branch, ref: `refs/heads/${r.branch}` }]
          : [];
      sides.set(r.path, heads.map((b) => ({ name: r.relative, cwd: r.path, branch: b.name, head: b.ref, base: base.ref })));
    } catch {
      /* repositório que não dá para ler: fica de fora */
    }
  }
  const out: ContractIssue[] = [];
  for (const a of repos) for (const b of repos) {
    if (a.path === b.path) continue;
    const backs = sides.get(a.path) ?? [];
    const fronts = sides.get(b.path) ?? [];
    // o front também conta na branch principal dele (o que já está lá chama a rota removida?)
    for (const back of backs) for (const front of fronts.length ? fronts : []) out.push(...crossCheck(back, front));
  }
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.kind}|${x.backRepo}|${x.backBranch}|${x.frontRepo}|${x.frontBranch}|${x.method}|${x.route}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function renderContractsText(issues: ContractIssue[]): string {
  if (!issues.length) return '';
  return ['Entre repositórios (contrato de API, heurística por texto):', ...issues.map((x) => `  ! ${x.message}\n      ${x.file}:${x.line}  ${x.evidence}`)].join('\n');
}
