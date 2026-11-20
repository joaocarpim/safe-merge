import { analyze, type Level } from './analyze.js';
import { detectBranches, fetchRemote, listBranches, pickRemote } from './branches.js';
import type { Config } from './config.js';
import { git, isAncestor, repoRoot } from './git.js';
import type { ToolRunner } from './tools.js';

/** Colunas da matriz, na ordem em que aparecem. */
export const MATRIX_CATEGORIES = ['secret', 'supply-chain', 'ci', 'sast', 'migration', 'env', 'semantic', 'tenant', 'auth', 'lgpd'] as const;

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
  error?: string;
}

export interface MatrixResult {
  schema: 1;
  base: string;
  rows: MatrixRow[];
  skipped: { branch: string; reason: string }[];
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

/** Roda a análise de cada branch aberta contra o destino e resume por categoria. Só leitura. */
export function matrix(opts: MatrixOptions): MatrixResult {
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

  const rows: MatrixRow[] = candidates.slice(0, opts.limit).map((b) => {
    try {
      const r = analyze({
        cwd,
        cfg: opts.cfg,
        head: b.name,
        base: base.name,
        targets: [base.name],
        fetch: false,
        usePrs: false,
        // mesmo veredito da análise individual: compara com as outras branches e roda os testes configurados
        testCommand: opts.testCommand,
        security: opts.security,
        tools: opts.tools,
        now: opts.now,
      });
      const cells: Record<string, MatrixCell> = Object.fromEntries(MATRIX_CATEGORIES.map((c) => [c, { block: 0, warn: 0 }]));
      for (const f of r.findings) {
        const cell = cells[f.category];
        if (!cell || f.level === 'info') continue;
        cell[f.level]++;
      }
      const t = r.targets[0];
      if (r.semantic[0]?.status === 'failed' && r.semantic[0].cause === 'semantic-conflict') cells.semantic!.block++;
      return {
        branch: b.name,
        level: r.verdict.level,
        conflicts: t?.conflicts.length ?? 0,
        conflictsLockfileOnly: (t?.conflicts.length ?? 0) > 0 && t!.conflicts.every((c) => c.hint === 'regenerate-lockfile'),
        otherConflicts: r.summary.otherBranchConflicts,
        behind: t?.behind ?? 0,
        tests: r.semantic[0] && r.semantic[0].status !== 'skipped' ? r.semantic[0].status : null,
        cells,
        uncovered: r.coverage.filter((c) => c.status === 'missing-tool' || c.status === 'error').length,
      };
    } catch (err) {
      return { branch: b.name, level: 'error', conflicts: 0, conflictsLockfileOnly: false, otherConflicts: 0, behind: 0, tests: null, cells: {}, uncovered: 0, error: (err as Error).message.split('\n')[0] };
    }
  });
  const rank = { block: 0, error: 1, warn: 2, ok: 3 } as const;
  rows.sort((a, b) => rank[a.level] - rank[b.level] || a.branch.localeCompare(b.branch));
  return { schema: 1, base: base.name, rows, skipped };
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
  return `${out.join('\n')}\n`;
}
