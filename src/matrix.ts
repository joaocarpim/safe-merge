import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, type AnalysisReport, type Level } from './analyze.js';
import type { BranchRef } from './branches.js';
import { VERSION } from './version.js';
import { runChild, selfCommand } from './workspace.js';
import { detectBranches, fetchRemote, listBranches, pickRemote } from './branches.js';
import type { Config } from './config.js';
import { git, isAncestor, repoRoot } from './git.js';
import type { ToolRunner } from './tools.js';
import { mergeOrder, renderOrderText, type OrderStep } from './plan.js';

/** Colunas da matriz, na ordem em que aparecem. */
export const MATRIX_CATEGORIES = ['secret', 'supply-chain', 'ci', 'sast', 'migration', 'env', 'semantic', 'tenant', 'auth', 'lgpd', 'runtime', 'risk', 'hygiene', 'process', 'branch'] as const;

export const CATEGORY_LABEL: Record<(typeof MATRIX_CATEGORIES)[number], string> = {
  secret: 'segredos',
  'supply-chain': 'dependências',
  ci: 'CI',
  sast: 'SAST',
  migration: 'migrações',
  env: 'variáveis',
  semantic: 'semântico',
  tenant: 'tenant',
  auth: 'autenticação',
  lgpd: 'LGPD',
  runtime: 'símbolos',
  risk: 'riscos',
  hygiene: 'higiene',
  process: 'processo',
  branch: 'branch',
};

export interface MatrixCell {
  block: number;
  warn: number;
}

export interface MatrixRow {
  branch: string;
  level: Level | 'error';
  /** Arquivos em conflito com o destino. */
  conflicts: number;
  /** Todos os conflitos são em lockfile (aviso, não bloqueio). */
  conflictsLockfileOnly: boolean;
  /** Outras branches que vão conflitar com esta. */
  otherConflicts: number;
  behind: number;
  /** `failed`, `passed`, `flaky`… ou null se os testes não rodaram. */
  tests: string | null;
  cells: Record<string, MatrixCell>;
  /** Verificações sem cobertura nesta branch. */
  uncovered: number;
  /** Branches desta matriz sobre as quais esta está empilhada (entram antes). */
  after: string[];
  /** Branches desta matriz com que esta vai conflitar. */
  conflictsWith: string[];
  /** Branches com migração de mesmo número. */
  migrationWith: string[];
  error?: string;
}

export interface MatrixResult {
  schema: 1;
  base: string;
  rows: MatrixRow[];
  skipped: { branch: string; reason: string }[];
  /** Ordem de merge sugerida (stacks primeiro; entre as livres, quem já pode, depois avisos, depois bloqueadas). */
  order: OrderStep[];
  /** Quantas branches vieram do cache (sem analisar de novo). */
  cached?: number;
}

export interface MatrixOptions {
  cwd: string;
  cfg: Config;
  base?: string;
  limit: number;
  fetch?: boolean;
  testCommand?: string | null;
  security?: boolean;
  tools?: ToolRunner;
  now?: () => number;
}


interface Plan {
  cwd: string;
  base: BranchRef;
  branches: BranchRef[];
  skipped: MatrixResult['skipped'];
}

/** Quais branches entram na matriz (e quais ficam de fora, com o motivo). */
function planMatrix(opts: MatrixOptions): Plan {
  const cwd = repoRoot(opts.cwd);
  const remote = pickRemote(cwd);
  if (remote && opts.fetch !== false) fetchRemote(cwd, remote);
  const branches = listBranches(cwd, remote);
  const detected = detectBranches(cwd, opts.cfg, branches);
  const base = opts.base ? branches.all.get(opts.base) : (detected.integration ?? detected.default);
  if (!base) throw new Error(opts.base ? `branch de destino não encontrada: ${opts.base}` : 'não achei nenhuma branch principal. Use --base <branch>.');
  const mains = new Set(detected.main.map((b) => b.name));
  const nowSec = (opts.now?.() ?? Date.now()) / 1000;
  const skipped: MatrixResult['skipped'] = [];
  const candidates = [...branches.all.values()]
    .filter((b) => !mains.has(b.name) && b.name !== base.name)
    .filter((b) => {
      if (isAncestor(cwd, b.ref, base.ref)) {
        skipped.push({ branch: b.name, reason: `já mergeada em ${base.name}` });
        return false;
      }
      const ct = Number.parseInt(git(cwd, ['log', '-1', '--format=%ct', b.ref]).stdout.trim(), 10) || 0;
      if ((nowSec - ct) / 86400 > opts.cfg.overlap.maxAgeDays) {
        skipped.push({ branch: b.name, reason: `sem commits há mais de ${opts.cfg.overlap.maxAgeDays} dias` });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const b of candidates.slice(opts.limit)) skipped.push({ branch: b.name, reason: `fora do limite de ${opts.limit} branches (--limit)` });
  return { cwd, base, branches: candidates.slice(0, opts.limit), skipped };
}

/** Linha da matriz a partir do relatório da branch. */
export function rowFromReport(branch: string, r: AnalysisReport): MatrixRow {
  const cells: Record<string, MatrixCell> = Object.fromEntries(MATRIX_CATEGORIES.map((c) => [c, { block: 0, warn: 0 }]));
  for (const f of r.findings) {
    const cell = cells[f.category];
    if (!cell || f.level === 'info') continue;
    cell[f.level]++;
  }
  // motivos que não são achados nem conflito (atrasada, mesma função, stack de PR): coluna "branch"
  for (const x of r.verdict.reasons) if (x.level !== 'info' && !x.text.startsWith('[SM-') && !/conflit|testes/.test(x.text)) cells.branch![x.level]++;
  const t = r.targets[0];
  if (r.semantic[0]?.status === 'failed' && r.semantic[0].cause === 'semantic-conflict') cells.semantic!.block++;
  // migração com o mesmo número em outra branch (a evidência termina com "em <branch>")
  const migrationWith = r.findings
    .filter((f) => f.category === 'migration' && f.rule === 'duplicate-number')
    .map((f) => / em (\S+)$/.exec(f.evidence ?? '')?.[1])
    .filter((b): b is string => Boolean(b) && b !== r.primary);
  return {
    branch,
    level: r.verdict.level,
    conflicts: t?.conflicts.length ?? 0,
    conflictsLockfileOnly: (t?.conflicts.length ?? 0) > 0 && t!.conflicts.every((c) => c.hint === 'regenerate-lockfile'),
    otherConflicts: r.summary.otherBranchConflicts,
    behind: t?.behind ?? 0,
    tests: r.semantic[0] && r.semantic[0].status !== 'skipped' ? r.semantic[0].status : null,
    cells,
    uncovered: r.coverage.filter((c) => c.status === 'missing-tool' || c.status === 'error').length,
    after: r.overlaps.filter((o) => o.relation === 'ours-contains-theirs').map((o) => o.branch),
    conflictsWith: r.overlaps.filter((o) => o.wouldConflict).map((o) => o.branch),
    migrationWith: [...new Set(migrationWith)],
  };
}

function errorRow(branch: string, message: string): MatrixRow {
  return { branch, level: 'error', conflicts: 0, conflictsLockfileOnly: false, otherConflicts: 0, behind: 0, tests: null, cells: {}, uncovered: 0, after: [], conflictsWith: [], migrationWith: [], error: message.split('\n')[0] };
}

function finish(plan: Plan, rows: MatrixRow[], extra: Partial<MatrixResult> = {}): MatrixResult {
  const rank = { block: 0, error: 1, warn: 2, ok: 3 } as const;
  rows.sort((a, b) => rank[a.level] - rank[b.level] || a.branch.localeCompare(b.branch));
  return {
    schema: 1,
    base: plan.base.name,
    rows,
    skipped: plan.skipped,
    order: mergeOrder(rows.map((r) => ({ branch: r.branch, level: r.level, after: r.after, conflictsWith: r.conflictsWith, migrationWith: r.migrationWith }))),
    ...extra,
  };
}

/** Roda a análise de cada branch aberta contra o destino e resume por categoria. Só leitura. */
export function matrix(opts: MatrixOptions): MatrixResult {
  const plan = planMatrix(opts);
  const rows = plan.branches.map((b) => {
    try {
      const r = analyze({
        cwd: plan.cwd,
        cfg: opts.cfg,
        head: b.name,
        base: plan.base.name,
        targets: [plan.base.name],
        fetch: false,
        usePrs: false,
        // mesmo veredito da análise individual: compara com as outras branches e roda os testes configurados
        testCommand: opts.testCommand,
        security: opts.security,
        tools: opts.tools,
        now: opts.now,
      });
      return rowFromReport(b.name, r);
    } catch (err) {
      return errorRow(b.name, (err as Error).message);
    }
  });
  return finish(plan, rows);
}

export interface ParallelOptions extends MatrixOptions {
  /** Branches analisadas ao mesmo tempo (um processo da CLI por branch). */
  jobs: number;
  /** Pasta do cache (null = sem cache). */
  cacheDir: string | null;
  /** Opções repassadas a cada análise (ex.: --config). */
  forward?: string[];
  cli?: { command: string; args: string[] };
}

/**
 * Chave do cache de uma branch: muda se a branch, o destino, qualquer outra branch da matriz (as
 * sobreposições dependem delas), a configuração, o comando de testes ou a versão mudarem.
 */
export function cacheKey(parts: { head: string; base: string; others: string[]; config: string; testCommand: string | null | undefined; security: boolean | undefined; version: string }): string {
  return createHash('sha1').update(JSON.stringify({ ...parts, others: [...parts.others].sort() })).digest('hex');
}

/** Mesma matriz, com as branches analisadas em paralelo e o resultado guardado por versão das branches. */
export async function matrixParallel(opts: ParallelOptions): Promise<MatrixResult> {
  const plan = planMatrix(opts);
  const sha = (ref: string) => git(plan.cwd, ['rev-parse', ref]).stdout.trim();
  const baseSha = sha(plan.base.ref);
  const allShas = plan.branches.map((b) => `${b.name}@${sha(b.ref)}`);
  const config = createHash('sha1').update(JSON.stringify(opts.cfg)).digest('hex');
  const cmd = opts.cli ?? selfCommand();
  const rows: MatrixRow[] = new Array(plan.branches.length);
  let cached = 0;
  let next = 0;
  const worker = async () => {
    while (next < plan.branches.length) {
      const i = next++;
      const b = plan.branches[i]!;
      const key = cacheKey({ head: allShas[i]!, base: baseSha, others: allShas, config, testCommand: opts.testCommand, security: opts.security, version: VERSION });
      const file = opts.cacheDir ? join(opts.cacheDir, `${key}.json`) : null;
      if (file && existsSync(file)) {
        try {
          rows[i] = JSON.parse(readFileSync(file, 'utf8')) as MatrixRow;
          cached++;
          continue;
        } catch {
          /* cache corrompido: analisa de novo */
        }
      }
      const args = ['analyze', '--head', b.name, '--base', plan.base.name, '--target', plan.base.name, '--no-fetch', '--no-prs', '--format', 'json', '--fail-on', 'never', ...(opts.testCommand ? ['--test-cmd', opts.testCommand] : []), ...(opts.security === false ? ['--no-security'] : []), ...(opts.forward ?? [])];
      const res = await runChild(cmd, plan.cwd, args);
      try {
        if (res.code !== 0) throw new Error(res.stderr.trim().split('\n').pop() || `saiu com código ${res.code}`);
        rows[i] = rowFromReport(b.name, JSON.parse(res.stdout) as AnalysisReport);
        if (file) {
          mkdirSync(opts.cacheDir!, { recursive: true });
          writeFileSync(file, JSON.stringify(rows[i]));
        }
      } catch (err) {
        rows[i] = errorRow(b.name, (err as Error).message.replace(/^erro:\s*/, ''));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.jobs, plan.branches.length)) }, worker));
  return finish(plan, rows, { cached });
}

/** Pasta de cache da matriz deste repositório (fora do repositório: nada é escrito nele). */
export function matrixCacheDir(cwd: string): string {
  return join(tmpdir(), 'safemerge-cache', createHash('sha1').update(repoRoot(cwd)).digest('hex').slice(0, 16));
}


/** Só as categorias com algo em alguma branch (a tabela cabe no terminal). */
function usedCategories(m: MatrixResult): Array<(typeof MATRIX_CATEGORIES)[number]> {
  return MATRIX_CATEGORIES.filter((c) => m.rows.some((r) => (r.cells[c]?.block ?? 0) + (r.cells[c]?.warn ?? 0) > 0));
}

function cellText(c: MatrixCell | undefined, mark: { block: string; warn: string }): string {
  if (!c || (c.block === 0 && c.warn === 0)) return '·';
  return [c.block ? `${c.block}${mark.block}` : '', c.warn ? `${c.warn}${mark.warn}` : ''].filter(Boolean).join(' ');
}

const LEVEL_TEXT = { block: '✗ não mergear', warn: '! atenção', ok: '✓ pode', error: '? erro' } as const;

export function renderMatrixText(m: MatrixResult): string {
  const cats = usedCategories(m);
  const headers = ['branch', 'veredito', 'conflitos', 'outros PRs', 'testes', ...cats.map((c) => CATEGORY_LABEL[c])];
  const rows = m.rows.map((r) => [
    r.branch,
    LEVEL_TEXT[r.level],
    r.conflicts ? `${r.conflicts}${r.conflictsLockfileOnly ? '! lock' : '✗'}` : '·',
    r.otherConflicts ? `${r.otherConflicts}!` : '·',
    r.tests ?? '–',
    ...cats.map((c) => cellText(r.cells[c], { block: '✗', warn: '!' })),
  ]);
  const width = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(width[i]!)).join('  ').trimEnd();
  const out = [`safemerge matrix · ${m.rows.length} branch(es) contra ${m.base}`, '', fmt(headers), fmt(width.map((w) => '─'.repeat(w))), ...rows.map(fmt)];
  for (const r of m.rows.filter((x) => x.error)) out.push(`  ${r.branch}: ${r.error}`);
  const uncovered = Math.max(0, ...m.rows.map((r) => r.uncovered));
  out.push('', `✗ bloqueia · ! aviso · · nada${uncovered ? ` · até ${uncovered} verificação(ões) sem cobertura por branch (rode safemerge na branch para ver quais)` : ''}`);
  if (m.skipped.length) out.push(`fora da matriz: ${m.skipped.map((s) => `${s.branch} (${s.reason})`).join(', ')}`);
  if (m.order?.length) out.push('', renderOrderText(m.order, m.base));
  return `${out.join('\n')}\n`;
}

export function renderMatrixMarkdown(m: MatrixResult): string {
  const out = [`## safemerge matrix: ${m.rows.length} branch(es) contra \`${m.base}\``, ''];
  const cats = usedCategories(m);
  out.push(`| Branch | Veredito | Conflitos | Outros PRs | Testes | ${cats.map((c) => CATEGORY_LABEL[c]).join(' | ')} |`);
  out.push(`|${'---|'.repeat(5 + cats.length)}`);
  const md = { block: '🔴 não mergear', warn: '🟡 atenção', ok: '🟢 pode', error: '⚠️ erro' } as const;
  for (const r of m.rows) {
    out.push(`| \`${r.branch}\` | ${md[r.level]} | ${r.conflicts ? `${r.conflicts}${r.conflictsLockfileOnly ? ' (lockfile)' : ''}` : '·'} | ${r.otherConflicts || '·'} | ${r.tests ?? '–'} | ${cats.map((c) => cellText(r.cells[c], { block: '❌', warn: '⚠️' })).join(' | ')} |`);
  }
  if (m.skipped.length) out.push('', `_Fora da matriz: ${m.skipped.map((s) => `\`${s.branch}\` (${s.reason})`).join(', ')}_`);
  if (m.order?.length) out.push('', `### Ordem de merge sugerida em \`${m.base}\``, '', ...m.order.map((s) => `${s.n}. \`${s.branch}\` ${md[s.level] ?? ''} — ${s.note}`));
  return `${out.join('\n')}\n`;
}
