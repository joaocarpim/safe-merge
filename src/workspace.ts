import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AnalysisReport } from './analyze.js';
import type { MatrixResult } from './matrix.js';
import { renderMatrixMarkdown, renderMatrixText } from './matrix.js';

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

function runChild(cmd: { command: string; args: string[] }, cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  return { schema: 1, root: opts.root, mode: opts.allBranches ? 'all-branches' : 'current-branch', entries, durationMs: Date.now() - started };
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
  const out = [`safemerge · ${w.entries.length} repositório(s) em ${w.root} · ${w.mode === 'all-branches' ? 'todas as branches abertas' : 'branch atual de cada um'} · ${(w.durationMs / 1000).toFixed(1)}s`, ''];
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
  return `${out.join('\n')}\n`;
}
