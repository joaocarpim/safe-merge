import type { Finding } from './findings.js';
import type { Level } from './analyze.js';

/**
 * Plano para mergear: o que fazer, em ordem, para esta branch poder entrar. Sai só do relatório (sem IA):
 * cada passo aponta para o achado, o conflito ou o motivo que o originou, com arquivo, linha e evidência
 * quando existem. A ordem é fixa: o que depende de outra branch, atualizar a branch, conflitos, testes,
 * bloqueios, avisos, combinar com quem mexe nos mesmos arquivos, sugestões e, por fim, analisar de novo.
 */

export type PlanKind = 'order' | 'update' | 'conflict' | 'lockfile' | 'tests' | 'finding' | 'coordinate' | 'review' | 'suggestion' | 'recheck' | 'done';

export interface PlanStep {
  n: number;
  kind: PlanKind;
  /** Quanto pesa: bloqueia o merge, aviso, ou sugestão. */
  level: 'block' | 'warn' | 'info';
  title: string;
  detail: string;
  file: string | null;
  line: number | null;
  evidence: string | null;
  /** Comando pronto para copiar (ex.: git rebase origin/dev). */
  command: string | null;
  /** Um assistente de IA pode propor a mudança (sempre verificada antes de aplicar). */
  ai: boolean;
  /** De onde o passo veio. */
  ref: { finding?: string; conflict?: { path: string; target: string; hunk: number }; branch?: string } | null;
}

/** Subconjunto do relatório que o plano usa (o AnalysisReport inteiro serve). */
export interface PlanInput {
  head: { name: string | null };
  remote: string | null;
  primary: string;
  targets: Array<{
    target: string;
    status: string;
    behind: number;
    ahead: number;
    conflicts: Array<{ path: string; hint?: string; hunks: Array<{ oursLine: number | null }> }>;
    sameFunction?: Array<{ path: string; functions: string[] }>;
  }>;
  overlaps: Array<{
    branch: string;
    pr: { number: number } | null;
    relation: string;
    wouldConflict: boolean;
    conflictFiles: string[];
    sameFunctions: Array<{ path: string; functions: string[] }>;
    stackDepth?: number;
  }>;
  semantic: Array<{ target: string; status: string; cause?: string; command?: string | null; outputTail?: string }>;
  findings: Finding[];
  coverage: Array<{ check: string; status: string; reason?: string }>;
  verdict: { level: Level };
}

/** Primeiro arquivo do projeto citado no erro dos testes (pilha de JS/TS, Python, Go…). */
export function errorLocation(output: string): { file: string; line: number } | null {
  const patterns = [
    /\((?:\.\/)?((?!node:|internal\/)[\w./@-]+\.(?:m?[jt]sx?|cjs|mjs|vue|svelte)):(\d+):\d+\)/,
    /at (?:\.\/)?((?!node:|internal\/)[\w./@-]+\.(?:m?[jt]sx?|cjs|mjs)):(\d+):\d+/,
    /File "(?!\/usr|<)([^"]+\.py)", line (\d+)/,
    /^\s*((?!\/usr)[\w./-]+\.(?:go|rs|dart|rb|php)):(\d+)/m,
  ];
  for (const re of patterns) {
    const m = re.exec(output);
    if (m && !/node_modules|site-packages/.test(m[1]!)) return { file: m[1]!.replace(/^\.\//, ''), line: Number(m[2]) };
  }
  return null;
}

const name = (o: { branch: string; pr: { number: number } | null }) => (o.pr ? `#${o.pr.number} (${o.branch})` : o.branch);

export function buildPlan(r: PlanInput, opts: { warnBehindCommits?: number; maxFindings?: number } = {}): PlanStep[] {
  const steps: Omit<PlanStep, 'n'>[] = [];
  const add = (s: Partial<Omit<PlanStep, 'n'>> & Pick<PlanStep, 'kind' | 'level' | 'title' | 'detail'>) =>
    steps.push({ file: null, line: null, evidence: null, command: null, ai: false, ref: null, ...s });
  const upstream = (b: string) => (r.remote ? `${r.remote}/${b}` : b);
  const primary = r.targets.find((t) => t.target === r.primary);

  // 1. o que precisa entrar antes (stack de PRs): a base mais próxima
  const stack = r.overlaps.filter((o) => o.relation === 'ours-contains-theirs').sort((a, b) => (b.stackDepth ?? 0) - (a.stackDepth ?? 0));
  if (stack.length > 0) {
    const base = stack[0]!;
    add({
      kind: 'order',
      level: base.pr ? 'warn' : 'info',
      title: `Mergear ${name(base)} antes desta branch`,
      detail: `Esta branch está empilhada sobre ${stack.length === 1 ? 'ela' : `uma stack de ${stack.length} branches`}: os commits dela entram junto com os seus. Mergeie a base primeiro e depois atualize esta branch.`,
      ref: { branch: base.branch },
    });
  }

  // 2. atualizar a branch (antes de resolver conflitos: o rebase/merge é onde eles aparecem)
  if (primary && (primary.behind >= (opts.warnBehindCommits ?? 30) || (primary.status === 'conflict' && primary.behind > 0))) {
    add({
      kind: 'update',
      level: primary.behind >= (opts.warnBehindCommits ?? 30) ? 'warn' : 'info',
      title: `Atualizar a branch com ${r.primary} (${primary.behind} commit(s) atrás)`,
      detail: `Traga as mudanças de ${r.primary} para a sua branch${primary.status === 'conflict' ? '; os conflitos abaixo vão aparecer nesse passo, e é nele que se resolvem' : ''}. Se a branch já é compartilhada, prefira merge a rebase.`,
      command: `git fetch && git rebase ${upstream(r.primary)}`,
    });
  }

  // 3. conflitos de texto com o destino principal
  for (const c of primary?.conflicts ?? []) {
    if (c.hint === 'regenerate-lockfile') {
      add({
        kind: 'lockfile',
        level: 'warn',
        title: `Regenerar ${c.path} em vez de resolver na mão`,
        detail: 'Conflito em lockfile: aceite a versão do destino e gere de novo com o gerenciador de pacotes, depois commite.',
        file: c.path,
        command: /package-lock/.test(c.path) ? `git checkout --theirs ${c.path} && npm install` : /yarn\.lock/.test(c.path) ? `git checkout --theirs ${c.path} && yarn install` : /pnpm-lock/.test(c.path) ? `git checkout --theirs ${c.path} && pnpm install` : null,
        ref: { conflict: { path: c.path, target: r.primary, hunk: 0 } },
      });
      continue;
    }
    add({
      kind: 'conflict',
      level: 'block',
      title: `Resolver o conflito em ${c.path} (${c.hunks.length} bloco(s))`,
      detail: `A sua branch e ${r.primary} mudaram as mesmas linhas. Veja os dois lados, decida o que fica (muitas vezes as duas intenções) e teste.`,
      file: c.path,
      line: c.hunks[0]?.oursLine ?? null,
      ai: true,
      ref: { conflict: { path: c.path, target: r.primary, hunk: 0 } },
    });
  }

  // 4. testes no resultado do merge
  for (const s of r.semantic) {
    if (s.status === 'failed') {
      const where = s.outputTail ? errorLocation(s.outputTail) : null;
      const by: Record<string, [string, string, 'block' | 'warn' | 'info']> = {
        'semantic-conflict': ['Corrigir o que quebra quando as duas branches se juntam', `Cada lado passa sozinho e a junção com ${s.target} quebra: o código de um lado usa algo que o outro mudou (nome, assinatura, formato).`, 'block'],
        'branch-failing': ['Fazer os testes passarem na sua branch', `Os testes já falham na sua branch, sem o merge com ${s.target}.`, 'warn'],
        'target-failing': [`Avisar quem cuida de ${s.target}: os testes já falham lá`, 'Não é culpa da sua branch, mas mergear em cima de testes quebrados esconde problemas novos.', 'info'],
        'both-failing': ['Fazer os testes voltarem a passar', `Os testes falham na sua branch e em ${s.target}, antes do merge.`, 'warn'],
      };
      const [title, detail, level] = by[s.cause ?? ''] ?? ['Corrigir os testes no resultado do merge', `Os testes falham no merge com ${s.target}.`, 'warn' as const];
      add({ kind: 'tests', level, title, detail: `${detail}${s.command ? ` Rode: ${s.command}.` : ''}`, file: where?.file ?? null, line: where?.line ?? null, command: s.command ?? null, ai: level !== 'info' });
    } else if (s.status === 'flaky') {
      add({ kind: 'tests', level: 'warn', title: 'Estabilizar o teste instável', detail: `Os testes no merge com ${s.target} falharam e passaram ao repetir: um teste instável esconde falhas de verdade.`, command: s.command ?? null });
    }
  }

  // 5 e 6. achados: bloqueios, depois avisos (observações ficam de fora: não pedem ação)
  const max = opts.maxFindings ?? 15;
  const actionable = r.findings.filter((f) => f.level !== 'info');
  for (const f of actionable.slice(0, max)) {
    add({
      kind: 'finding',
      level: f.level,
      title: f.title,
      detail: f.message,
      file: f.file,
      line: f.line,
      evidence: f.evidence,
      ai: f.category !== 'process' && Boolean(f.file),
      ref: { finding: f.id },
    });
  }
  if (actionable.length > max) {
    add({ kind: 'finding', level: 'warn', title: `Mais ${actionable.length - max} achado(s) para conferir`, detail: 'Veja a lista completa na aba Segurança (ou no relatório).' });
  }

  // 7. combinar com quem mexe nos mesmos arquivos
  for (const o of r.overlaps.filter((x) => x.wouldConflict)) {
    add({
      kind: 'coordinate',
      level: 'warn',
      title: `Combinar a ordem de merge com ${name(o)}`,
      detail: `As duas branches vão conflitar${o.conflictFiles.length ? ` em ${o.conflictFiles.join(', ')}` : ''}: quem mergear depois resolve o conflito. Decidam quem entra primeiro.`,
      file: o.conflictFiles[0] ?? null,
      ref: { branch: o.branch },
    });
  }
  const sameFn = [...(primary?.sameFunction ?? []).map((s) => ({ who: r.primary, ...s })), ...r.overlaps.flatMap((o) => o.sameFunctions.map((s) => ({ who: name(o), ...s })))];
  for (const s of sameFn) {
    add({
      kind: 'review',
      level: r.semantic.some((x) => x.status === 'passed') ? 'info' : 'warn',
      title: `Conferir a lógica de ${s.functions.join(', ')} com ${s.who}`,
      detail: `O git junta sem conflito, mas as duas mudaram ${s.functions.length === 1 ? 'a mesma função' : 'as mesmas funções'} em ${s.path}. Leia o resultado combinado.`,
      file: s.path,
    });
  }

  // 8. sugestões que aumentam a cobertura
  const sem = r.coverage.find((c) => c.check === 'semantic');
  const detected = sem?.status === 'skipped' ? /detectei "([^"]+)"/.exec(sem.reason ?? '')?.[1] : undefined;
  if (detected) {
    add({ kind: 'suggestion', level: 'info', title: 'Rodar a análise com os testes', detail: `Sem testes, o conflito que o git não vê (semântico) não é verificado. O projeto parece usar "${detected}".`, command: `safemerge --test-cmd "${detected}"` });
  }

  // 9. fechar o ciclo
  if (steps.length === 0) {
    add({ kind: 'done', level: 'info', title: 'Nada a fazer: pode mergear', detail: 'Nenhum conflito, teste quebrado ou achado que peça ação nas verificações que rodaram.' });
  } else {
    add({ kind: 'recheck', level: 'info', title: 'Analisar de novo', detail: 'Depois dos passos acima, rode a análise outra vez e confira que o veredito mudou.', command: 'safemerge' });
  }
  return steps.map((s, i) => ({ ...s, n: i + 1 }));
}

// ───────────────────────────── ordem de merge (várias branches) ─────────────────────────────

export interface OrderInput {
  branch: string;
  level: Level | 'error';
  /** Branches (desta mesma lista) sobre as quais esta está empilhada. */
  after: string[];
  /** Branches (desta mesma lista) com que esta vai conflitar. */
  conflictsWith: string[];
  /** Branches com migração de mesmo número. */
  migrationWith?: string[];
}

export interface OrderStep {
  n: number;
  branch: string;
  level: Level | 'error';
  /** Precisa entrar depois destas. */
  after: string[];
  conflictsWith: string[];
  note: string;
}

/**
 * Ordem sugerida: respeita as stacks (a base antes) e, entre as livres, põe primeiro quem já pode
 * mergear, depois quem pede atenção e por último quem está bloqueado (precisa de trabalho antes).
 * Em cada par que conflita, quem entra depois é quem resolve o conflito.
 */
export function mergeOrder(rows: OrderInput[]): OrderStep[] {
  const rank = { ok: 0, warn: 1, block: 2, error: 3 } as const;
  const names = new Set(rows.map((r) => r.branch));
  const pending = new Map(rows.map((r) => [r.branch, { ...r, after: r.after.filter((a) => names.has(a) && a !== r.branch) }]));
  const placed: string[] = [];
  const out: OrderStep[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((r) => r.after.every((a) => placed.includes(a)));
    // ciclo (não deveria acontecer em stack): quebra pelo mais simples
    const pool = ready.length > 0 ? ready : [...pending.values()];
    pool.sort((a, b) => rank[a.level] - rank[b.level] || a.branch.localeCompare(b.branch));
    const next = pool[0]!;
    pending.delete(next.branch);
    const earlierConflicts = next.conflictsWith.filter((c) => placed.includes(c));
    const notes: string[] = [];
    if (next.after.length) notes.push(`empilhada: entra depois de ${next.after.join(', ')}`);
    if (earlierConflicts.length) notes.push(`resolve o conflito com ${earlierConflicts.join(', ')} (que entrou antes)`);
    const earlierMigrations = (next.migrationWith ?? []).filter((c) => placed.includes(c));
    if (earlierMigrations.length) notes.push(`renumera a migração (mesmo número que ${earlierMigrations.join(', ')}, que entrou antes)`);
    if (next.level === 'block') notes.push('precisa de trabalho antes (veja o plano da branch)');
    if (next.level === 'error') notes.push('a análise falhou nesta branch');
    out.push({ n: out.length + 1, branch: next.branch, level: next.level, after: next.after, conflictsWith: next.conflictsWith, note: notes.join('; ') || (next.level === 'ok' ? 'pode entrar já' : 'pode entrar depois de conferir os avisos') });
    placed.push(next.branch);
  }
  return out;
}

export function renderPlanMarkdown(plan: PlanStep[], head: string | null, primary: string): string {
  const mark = { block: '❌', warn: '⚠️', info: '·' } as const;
  const out = [`### Plano para mergear \`${head ?? 'HEAD'}\` em \`${primary}\``, ''];
  for (const s of plan) {
    out.push(`${s.n}. ${mark[s.level]} **${s.title}**${s.file ? ` — \`${s.file}${s.line ? `:${s.line}` : ''}\`` : ''}`);
    out.push(`   ${s.detail}`);
    if (s.evidence) out.push(`   Evidência: \`${s.evidence.replace(/`/g, "'")}\``);
    if (s.command) out.push(`   \`${s.command}\``);
  }
  return `${out.join('\n')}\n`;
}

export function renderOrderText(order: OrderStep[], base: string): string {
  const mark = { ok: '✓', warn: '!', block: '✗', error: '?' } as const;
  return [`Ordem de merge sugerida em ${base}:`, ...order.map((s) => `  ${String(s.n).padStart(2)}. ${mark[s.level]} ${s.branch}  · ${s.note}`)].join('\n');
}
