import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { VERSION } from './version.js';
import {
  currentBranch,
  detectBranches,
  fetchRemote,
  listBranches,
  localDivergence,
  pickRemote,
  type BranchRef,
  type Divergence,
} from './branches.js';
import type { Config } from './config.js';
import { noopEmit, type Emit, type Phase, type PhaseStatus } from './events.js';
import { git, mergeCommit, refExists, repoProblem, repoRoot, revParse, shortSha } from './git.js';
import { listOpenPrs, type PrListing } from './github.js';
import { simulateMerge, type MergeResult } from './merge.js';
import { findOverlaps, type OverlapEntry } from './overlap.js';
import { semanticCheck, type SemanticResult } from './semantic.js';
import { SECURITY_CHECKS, type Check, type CheckContext, type CheckOutput } from './checks/index.js';
import { finalizeFindings, type CoverageEntry, type Finding, type FindingDraft } from './findings.js';
import { runTool, type ToolRunner } from './tools.js';
import { classifyConflicts, mergirafAvailable } from './structured.js';

export interface AnalyzeOptions {
  cwd: string;
  cfg: Config;
  /** Branch a analisar. Padrão: a branch atual (ou HEAD). */
  head?: string;
  /** Para onde a branch vai: destino principal do veredito. */
  base?: string;
  /** Lista explícita de destinos. Padrão: as principais detectadas. */
  targets?: string[];
  remote?: string;
  /** Faz `git fetch` antes. Padrão: sim, se houver remoto. */
  fetch?: boolean;
  /** Compara com outras branches/PRs. Padrão: sim. */
  overlap?: boolean;
  /** Associa branches a PRs abertas com o `gh`. Padrão: sim. */
  usePrs?: boolean;
  /** Comando de testes para a checagem semântica. Padrão: o da configuração. */
  testCommand?: string | null;
  /** Comando de build antes dos testes. Padrão: o da configuração. */
  buildCommand?: string | null;
  /** Roda a fase de segurança e deploy. Padrão: sim (se a configuração não desligar). */
  security?: boolean;
  /** Executor de ferramentas externas (injetável nos testes). */
  tools?: ToolRunner;
  /** Verificações de segurança a rodar. Padrão: todas. */
  checks?: Check[];
  emit?: Emit;
  listPrs?: (cwd: string) => PrListing;
  now?: () => number;
}

export type Level = 'ok' | 'warn' | 'block';

export interface Reason {
  level: 'info' | 'warn' | 'block';
  text: string;
}

export interface Verdict {
  level: Level;
  reasons: Reason[];
}

export interface AnalysisReport {
  schema: 2;
  generatedAt: string;
  repo: string;
  head: { name: string | null; ref: string; sha: string; shortSha: string; dirty: boolean };
  remote: string | null;
  fetched: boolean;
  /** Destino que decide o veredito. */
  primary: string;
  targets: MergeResult[];
  overlaps: OverlapEntry[];
  semantic: SemanticResult[];
  summary: ReportSummary;
  /** Achados com id estável (segurança, deploy, o que os testes tocaram). */
  findings: Finding[];
  /** O que cada verificação fez: rodou, pulou, ferramenta ausente ou erro, e por quê. */
  coverage: CoverageEntry[];
  /** Entradas exatas da análise: com elas, o mesmo resultado sai de novo (e dá para ver se o relatório envelheceu). */
  inputs: AnalysisInputs;
  /** Branches (a sua e os destinos) cuja versão local difere da do remoto. */
  divergence: Divergence[];
  warnings: string[];
  verdict: Verdict;
  durationMs: number;
}

/** Números do relatório, calculados uma vez aqui: as saídas só mostram. */
export interface ReportSummary {
  /** Arquivos em conflito com o destino principal. */
  conflictFiles: number;
  /** Destinos (além do principal) com conflito. */
  otherTargetConflicts: number;
  /** Outras branches/PRs que vão conflitar com esta. */
  otherBranchConflicts: number;
  /** PRs em que esta branch está empilhada (precisam entrar antes). */
  stackedOn: number;
  behind: number;
  ahead: number;
  tests: 'passed' | 'failed' | 'flaky' | 'error' | 'skipped' | 'not-configured';
  testsCause: string | null;
  findings: { block: number; warn: number; info: number };
  /** Motivos do veredito por nível (conflitos, testes, achados, avisos de branch): o que o leitor vê na lista. */
  reasons: { block: number; warn: number; info: number };
  coverage: { total: number; ran: number; partial: number; skipped: number; missing: number; error: number };
}

export function summarize(r: Pick<AnalysisReport, 'primary' | 'targets' | 'overlaps' | 'semantic' | 'findings' | 'coverage'>): ReportSummary {
  const p = r.targets.find((t) => t.target === r.primary);
  const s = r.semantic[0];
  return {
    conflictFiles: p?.conflicts.length ?? 0,
    otherTargetConflicts: r.targets.filter((t) => t.target !== r.primary && t.status === 'conflict').length,
    otherBranchConflicts: r.overlaps.filter((o) => o.wouldConflict).length,
    stackedOn: r.overlaps.filter((o) => o.relation === 'ours-contains-theirs').length,
    behind: p?.behind ?? 0,
    ahead: p?.ahead ?? 0,
    tests: s ? (s.status as ReportSummary['tests']) : 'not-configured',
    testsCause: s?.cause ?? null,
    findings: {
      block: r.findings.filter((f) => f.level === 'block').length,
      warn: r.findings.filter((f) => f.level === 'warn').length,
      info: r.findings.filter((f) => f.level === 'info').length,
    },
    reasons: { block: 0, warn: 0, info: 0 },
    coverage: {
      total: r.coverage.length,
      ran: r.coverage.filter((c) => c.status === 'ran').length,
      partial: r.coverage.filter((c) => c.status === 'partial').length,
      skipped: r.coverage.filter((c) => c.status === 'skipped').length,
      missing: r.coverage.filter((c) => c.status === 'missing-tool').length,
      error: r.coverage.filter((c) => c.status === 'error').length,
    },
  };
}

export interface AnalysisInputs {
  version: string;
  headSha: string;
  targets: Array<{ name: string; ref: string; sha: string }>;
  /** sha1 da configuração efetiva (JSON). */
  configHash: string;
  testCommand: string | null;
  buildCommand: string | null;
  security: boolean;
  overlap: boolean;
  isolation: string;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

function resolveHead(cwd: string, remote: string | null, head?: string): { name: string | null; ref: string } {
  if (!head) {
    const name = currentBranch(cwd);
    if (!name) throw new UsageError('HEAD está solto (sem branch). Informe a branch com --head.');
    return { name, ref: 'HEAD' };
  }
  const candidates = [`refs/heads/${head}`, ...(remote ? [`refs/remotes/${remote}/${head}`] : []), head];
  const ref = candidates.find((c) => refExists(cwd, c));
  if (!ref) throw new UsageError(`branch não encontrada: ${head}`);
  return { name: head, ref };
}

function findTarget(all: Map<string, BranchRef>, name: string): BranchRef {
  const found = all.get(name);
  if (!found) throw new UsageError(`branch de destino não encontrada: ${name}`);
  return found;
}

function elapsed<T>(emit: Emit, phase: Phase, fn: () => { value: T; status: PhaseStatus; summary: string }): T {
  emit({ type: 'phase.start', phase });
  const started = Date.now();
  const { value, status, summary } = fn();
  emit({ type: 'phase.end', phase, status, ms: Date.now() - started, summary });
  return value;
}

/** O que os testes tocaram vira observação (nunca bloqueio): observar antes de bloquear. */
function observedFindings(r: SemanticResult): FindingDraft[] {
  const o = r.observed;
  if (!o) return [];
  const out: FindingDraft[] = [];
  const base = { category: 'runtime', file: null, line: null, confidence: 'high', source: 'strace' } as const;
  for (const addr of o.network) {
    out.push({ ...base, rule: 'network', title: 'Testes tentaram acessar a rede', message: `conexão para ${addr} durante os testes do merge com ${r.target}`, severity: 'low', evidence: `connect ${addr}` });
  }
  for (const file of o.files) {
    out.push({ ...base, rule: 'file-outside', title: 'Testes abriram arquivo fora do projeto', message: `${file} foi aberto durante os testes`, severity: 'info', evidence: `openat ${file}` });
  }
  for (const proc of o.processes) {
    out.push({ ...base, rule: 'process', title: 'Testes executaram um programa', message: `${proc} foi executado durante os testes`, severity: 'info', evidence: `execve ${proc}` });
  }
  return out;
}

type VerdictInput = Pick<AnalysisReport, 'primary' | 'targets' | 'overlaps' | 'semantic' | 'head' | 'warnings'> & Partial<Pick<AnalysisReport, 'remote'>> & Partial<Pick<AnalysisReport, 'findings' | 'coverage'>>;

export function buildVerdict(report: VerdictInput, cfg: Config): Verdict {
  const reasons: Reason[] = [];
  const add = (level: Reason['level'], text: string) => reasons.push({ level, text });
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  for (const t of report.targets) {
    const isPrimary = t.target === report.primary;
    if (t.status === 'conflict') {
      const onlyLockfiles = t.conflicts.every((c) => c.hint === 'regenerate-lockfile');
      const text = onlyLockfiles
        ? `conflito só em lockfile com ${t.target} (${t.conflicts.map((c) => c.path).join(', ')}): regenere depois do merge, não resolva na mão`
        : `${plural(t.conflicts.length, 'arquivo em conflito', 'arquivos em conflito')} com ${t.target}`;
      add(isPrimary && !onlyLockfiles ? 'block' : 'warn', text);
    } else if (t.status === 'unrelated' || t.status === 'error') {
      add(isPrimary ? 'warn' : 'info', `não consegui simular o merge com ${t.target}: ${t.error ?? 'erro desconhecido'}`);
    }
    if (isPrimary && t.status === 'conflict') {
      const locks = t.conflicts.filter((c) => c.hint === 'regenerate-lockfile');
      if (locks.length > 0 && locks.length < t.conflicts.length) add('info', `conflito em ${locks.map((c) => c.path).join(', ')}: não resolva na mão; depois do merge, regenere (ex.: npm install) e commite`);
      const lineOnly = t.conflicts.filter((c) => c.structured?.result === 'line-only');
      if (lineOnly.length > 0) {
        add('info', `${plural(lineOnly.length, 'conflito é', 'conflitos são')} só de linha (${lineOnly.map((c) => c.path).join(', ')}): o Mergiraf junta pela estrutura do código; configurado como driver de merge, o git resolveria`);
      }
    }
    if (isPrimary && t.status !== 'error' && t.status !== 'unrelated' && t.ahead === 0) {
      add('info', `a branch não tem nenhum commit que ${t.target} ainda não tenha: não há nada a mergear`);
    }
    if (isPrimary && (t.sameFunction?.length ?? 0) > 0) {
      const what = t.sameFunction.map((s) => `${s.functions.join(', ')} (${s.path})`).join('; ');
      const testsPassed = report.semantic.some((x) => x.status === 'passed');
      add(testsPassed ? 'info' : 'warn', `o git junta sozinho, mas a sua branch e ${t.target} alteraram a mesma função: ${what}. Confira a lógica${testsPassed ? ' (os testes no merge passaram)' : ' (rode com --test-cmd para testar o merge)'}`);
    }
    if (isPrimary && (t.renamedOnTarget?.length ?? 0) > 0) {
      add('info', `${t.target} renomeou ${t.renamedOnTarget.map((r) => `${r.from} → ${r.to}`).join(', ')}; suas mudanças vão para o arquivo novo (confira o resultado)`);
    }
    if (isPrimary && t.status !== 'error' && t.status !== 'unrelated') {
      if (t.behind >= cfg.warnBehindCommits) {
        const upstream = report.remote ? `${report.remote}/${t.target}` : t.target;
        add('warn', `a branch está ${plural(t.behind, 'commit atrás', 'commits atrás')} de ${t.target}; atualize antes de abrir a PR (git rebase ${upstream}, ou git merge ${upstream} se a branch já é compartilhada)`);
      }
      if (t.autoMerged.length > 0) {
        add('info', `${plural(t.autoMerged.length, 'arquivo alterado', 'arquivos alterados')} dos dois lados e juntado${t.autoMerged.length === 1 ? '' : 's'} sozinho pelo git; vale conferir`);
      }
    }
  }

  const conflicting = report.overlaps.filter((o) => o.wouldConflict);
  if (conflicting.length > 0) {
    const names = conflicting.map((o) => (o.pr ? `#${o.pr.number}` : o.branch)).join(', ');
    add('warn', `${plural(conflicting.length, 'outra branch vai conflitar', 'outras branches vão conflitar')} com esta: ${names}`);
  }
  for (const o of report.overlaps.filter((x) => (x.sameFunctions?.length ?? 0) > 0)) {
    const what = o.sameFunctions.map((s) => `${s.functions.join(', ')} (${s.path})`).join('; ');
    add('warn', `${o.pr ? `#${o.pr.number}` : o.branch} também altera ${what}: o git junta sem conflito, mas quem mergear depois deve conferir a lógica`);
  }
  for (const o of report.overlaps.filter((x) => x.relation === 'ours-contains-theirs')) {
    add('warn', `PR empilhado: esta branch está sobre ${o.pr ? `#${o.pr.number}` : o.branch}, que precisa ser mergeada primeiro`);
  }

  for (const s of report.semantic) {
    if (s.status === 'failed') {
      if (s.cause === 'semantic-conflict') {
        add('block', `o merge com ${s.target} é limpo no texto, mas os testes quebram no resultado combinado`);
      } else if (s.cause === 'target-failing') {
        add('info', `os testes já falham em ${s.target}, antes do seu merge`);
      } else if (s.cause === 'branch-failing') {
        add('warn', `os testes falham na sua branch, não só no merge com ${s.target}`);
      } else {
        add('warn', `os testes falham no resultado do merge com ${s.target}`);
      }
    } else if (s.status === 'flaky') {
      add('warn', `os testes no merge com ${s.target} falharam e passaram ao repetir: teste instável, não acusado como conflito`);
    } else if (s.status === 'error') {
      add('warn', `não consegui rodar os testes do resultado do merge: ${s.reason ?? 'erro desconhecido'}`);
    }
  }

  for (const f of report.findings ?? []) {
    if (f.level === 'info') continue;
    const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
    add(f.level, `[${f.id}] ${f.title}${where}`);
  }
  const infos = (report.findings ?? []).filter((f) => f.level === 'info').length;
  if (infos > 0) add('info', `${plural(infos, 'observação', 'observações')} de segurança e deploy sem gravidade para aviso; veja a seção de achados`);

  const partial = (report.coverage ?? []).filter((c) => c.status === 'partial');
  if (partial.length > 0) add('info', `${plural(partial.length, 'verificação com cobertura parcial', 'verificações com cobertura parcial')} (regras internas no lugar da ferramenta): ${partial.map((c) => c.label).join(', ')}`);
  const uncovered = (report.coverage ?? []).filter((c) => c.status === 'missing-tool' || c.status === 'error');
  if (uncovered.length > 0) {
    add('info', `${plural(uncovered.length, 'verificação sem cobertura', 'verificações sem cobertura')}: ${uncovered.map((c) => c.label).join(', ')}`);
  }

  if (report.head.dirty) add('info', 'há alterações não commitadas; a análise considera só o que está commitado');

  const rank = { block: 0, warn: 1, info: 2 } as const;
  reasons.sort((a, b) => rank[a.level] - rank[b.level]);

  const level: Level = reasons.some((r) => r.level === 'block') ? 'block' : reasons.some((r) => r.level === 'warn') ? 'warn' : 'ok';
  return { level, reasons };
}

export function analyze(opts: AnalyzeOptions): AnalysisReport {
  const started = Date.now();
  const emit = opts.emit ?? noopEmit;
  { const problem = repoProblem(opts.cwd); if (problem) throw new UsageError(problem); }
  const cwd = repoRoot(opts.cwd);
  const cfg = opts.cfg;
  const warnings: string[] = [];

  const remote = pickRemote(cwd, opts.remote);
  if (opts.remote && !remote) throw new UsageError(`remoto não encontrado: ${opts.remote}`);

  let fetched = false;
  if (remote && opts.fetch !== false) {
    const res = fetchRemote(cwd, remote);
    fetched = res.ok;
    if (!res.ok) warnings.push(`não consegui atualizar ${remote} (${res.message.split('\n')[0] ?? 'erro'}); usando o que já está local`);
  } else if (!remote) {
    warnings.push('repositório sem remoto: comparando só com branches locais');
  }

  const head = resolveHead(cwd, remote, opts.head);
  const headSha = revParse(cwd, head.ref);
  const dirty = head.ref === 'HEAD' && git(cwd, ['status', '--porcelain']).stdout.trim() !== '';

  const branchMap = listBranches(cwd, remote);
  const detected = detectBranches(cwd, cfg, branchMap);

  const explicit = opts.targets?.length ? opts.targets.map((n) => findTarget(branchMap.all, n)) : null;
  const mainList = (explicit ?? detected.main).filter((b) => b.name !== head.name);
  const baseCandidate = opts.base
    ? findTarget(branchMap.all, opts.base)
    : [detected.integration, detected.default, mainList[0]].find((b): b is BranchRef => !!b && b.name !== head.name);
  if (!baseCandidate) throw new UsageError('não achei nenhuma branch principal para comparar. Use --base <branch>.');
  const primary = baseCandidate;
  const targets = [primary, ...mainList.filter((b) => b.name !== primary.name)];

  const divergence = localDivergence(cwd, remote, [...(head.name ? [head.name] : []), ...targets.map((t) => t.name)]);
  for (const d of divergence) {
    const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;
    if (d.branch === head.name) {
      if (d.remoteAhead > 0) {
        warnings.push(
          `${remote}/${d.branch} tem ${commits(d.remoteAhead)} que a sua ${d.branch} local não tem; a análise usa a local. Rode git pull para incluir`,
        );
      }
    } else if (d.localAhead > 0) {
      const verb = d.localAhead === 1 ? 'não está' : 'não estão';
      warnings.push(
        `seu ${d.branch} local tem ${commits(d.localAhead)} que ${verb} em ${remote}/${d.branch}; a comparação usa ${remote}/${d.branch} e ignora ${d.localAhead === 1 ? 'esse commit' : 'esses commits'}`,
      );
    }
  }

  emit({ type: 'run.start', head: head.name ?? head.ref, headSha: shortSha(headSha), targets: targets.map((t) => t.name) });

  elapsed(emit, 'branches', () => ({
    value: undefined,
    status: 'ok',
    summary: `destino ${primary.name}; comparando com ${targets.map((t) => t.name).join(', ')}`,
  }));

  const merges = elapsed(emit, 'merge', () => {
    const results = targets.map((t) => {
      const r = simulateMerge(cwd, head.ref, t);
      emit({ type: 'merge.result', target: r.target, status: r.status, conflicts: r.conflicts.length, behind: r.behind });
      return r;
    });
    const primaryResult = results.find((r) => r.target === primary.name);
    const status: PhaseStatus = primaryResult?.status === 'conflict' ? 'block' : results.some((r) => r.status === 'conflict') ? 'warn' : 'ok';
    return { value: results, status, summary: results.map((r) => `${r.target}: ${r.status}`).join(' · ') };
  });

  let overlaps: OverlapEntry[] = [];
  if (opts.overlap !== false) {
    overlaps = elapsed(emit, 'overlap', () => {
      let prs: PrListing = { prs: [] };
      if (opts.usePrs !== false && remote) {
        prs = (opts.listPrs ?? listOpenPrs)(cwd);
        if (prs.warning) warnings.push(prs.warning);
      }
      const mainNames = new Set(detected.main.map((b) => b.name));
      const exclude = new Set([...mainNames, ...(head.name ? [head.name] : [])]);
      const candidates = [...branchMap.all.values()].filter((b) => !exclude.has(b.name));
      const found = findOverlaps({ cwd, headRef: head.ref, primary, candidates, prs: prs.prs, cfg, exclude, nowMs: opts.now?.() });
      for (const o of found) {
        emit({ type: 'overlap.result', branch: o.branch, wouldConflict: o.wouldConflict, shared: o.sharedFiles.length });
      }
      const status: PhaseStatus = found.some((o) => o.wouldConflict) ? 'warn' : 'ok';
      return { value: found, status, summary: `${found.length} branch(es) mexem nos mesmos arquivos` };
    });
  }

  const tools = opts.tools ?? runTool;
  const coverage: CoverageEntry[] = [];
  const drafts: FindingDraft[] = [];
  const cover = (c: Omit<CoverageEntry, 'findings'>, findings = 0) => coverage.push({ ...c, findings });

  const primaryMerge = merges.find((m) => m.target === primary.name);
  cover(
    primaryMerge && (primaryMerge.status === 'clean' || primaryMerge.status === 'conflict')
      ? { check: 'merge', label: 'Merge simulado', status: 'ran', reason: `${merges.length} destino(s)` }
      : { check: 'merge', label: 'Merge simulado', status: 'error', reason: primaryMerge?.error ?? 'não simulado' },
    merges.reduce((n, m) => n + m.conflicts.length, 0),
  );
  cover(
    opts.overlap === false
      ? { check: 'overlap', label: 'Outras branches e PRs', status: 'skipped', reason: 'desligado (--no-overlap)' }
      : { check: 'overlap', label: 'Outras branches e PRs', status: 'ran' },
    overlaps.filter((o) => o.wouldConflict).length,
  );

  const contentConflicts = primaryMerge?.conflicts.filter((c) => c.kind === 'contents' && !c.hint) ?? [];
  if (!cfg.mergiraf.enabled) {
    cover({ check: 'mergiraf', label: 'Merge estruturado (Mergiraf)', status: 'skipped', reason: 'desligado na configuração' });
  } else if (contentConflicts.length === 0) {
    cover({ check: 'mergiraf', label: 'Merge estruturado (Mergiraf)', status: 'skipped', reason: 'nenhum conflito de conteúdo com o destino' });
  } else if (!mergirafAvailable(tools, cfg)) {
    cover({ check: 'mergiraf', label: 'Merge estruturado (Mergiraf)', status: 'missing-tool', reason: 'mergiraf não instalado (https://mergiraf.org): não dá para separar conflito real de conflito só de linha' });
  } else {
    classifyConflicts(cwd, head.ref, primaryMerge!, tools, cfg);
    const lineOnly = contentConflicts.filter((c) => c.structured?.result === 'line-only').length;
    cover({ check: 'mergiraf', label: 'Merge estruturado (Mergiraf)', status: 'ran', reason: `${lineOnly} de ${contentConflicts.length} conflito(s) só de linha` });
  }

  const command = opts.testCommand === undefined ? cfg.semantic.command : opts.testCommand;
  const build =opts.buildCommand === undefined ? cfg.semantic.buildCommand : opts.buildCommand;
  const semantic: SemanticResult[] = [];
  if (command) {
    const result = elapsed(emit, 'semantic', () => {
      const r = semanticCheck(cwd, head.ref, primary, cfg, command, { tools, buildCommand: build });
      emit({ type: 'semantic.result', target: r.target, status: r.status, cause: r.cause });
      const status: PhaseStatus = r.status === 'passed' ? 'ok' : r.status === 'skipped' ? 'skipped' : r.cause === 'semantic-conflict' ? 'block' : r.status === 'failed' || r.status === 'flaky' ? 'warn' : 'error';
      return { value: r, status, summary: r.status };
    });
    semantic.push(result);
    cover(
      result.status === 'skipped'
        ? { check: 'semantic', label: 'Testes no resultado do merge', status: 'skipped', reason: result.reason }
        : result.status === 'error'
          ? { check: 'semantic', label: 'Testes no resultado do merge', status: 'error', reason: result.reason }
          : { check: 'semantic', label: 'Testes no resultado do merge', status: 'ran', reason: `${build ? `${build} && ` : ''}${command}` },
      result.status === 'failed' ? 1 : 0,
    );
    const iso = result.isolation;
    if (iso) {
      cover(
        iso.mode === 'docker'
          ? { check: 'isolation', label: 'Testes isolados (container sem rede)', status: 'ran', reason: `docker --network none, imagem ${cfg.isolation.image}` }
          : { check: 'isolation', label: 'Testes isolados (container sem rede)', status: 'skipped', reason: `sem isolamento: ${iso.reason ?? 'modo local'}${iso.envWithheld.length ? `; ${iso.envWithheld.length} variável(is) com cara de credencial não repassada(s)` : ''}` },
      );
      cover(
        iso.traced
          ? { check: 'trace', label: 'Registro do que os testes tocaram (strace)', status: 'ran' }
          : { check: 'trace', label: 'Registro do que os testes tocaram (strace)', status: iso.traceReason === 'strace não instalado' ? 'missing-tool' : 'skipped', reason: iso.traceReason },
        result.observed ? result.observed.network.length + result.observed.files.length + result.observed.processes.length : 0,
      );
      drafts.push(...observedFindings(result));
    }
  } else {
    cover({ check: 'semantic', label: 'Testes no resultado do merge', status: 'skipped', reason: 'sem comando de testes (--test-cmd ou semantic.command)' });
  }

  if (opts.security === false || !cfg.security.enabled) {
    cover({ check: 'security', label: 'Segurança e deploy', status: 'skipped', reason: 'desligado (--no-security ou security.enabled = false)' });
  } else if (!primaryMerge?.mergeBase) {
    cover({ check: 'security', label: 'Segurança e deploy', status: 'error', reason: `sem ponto de partida comum com ${primary.name}` });
  } else {
    const mb = primaryMerge.mergeBase;
    elapsed(emit, 'security', () => {
      const others = [...branchMap.all.values()].filter((b) => b.name !== head.name && b.name !== primary.name);
      const mergedCommit = primaryMerge.status === 'clean' ? mergeCommit(cwd, head.ref, primary.ref) : null;
      const ctx: CheckContext = { cwd, headRef: head.ref, headSha, target: primary, mergeBase: mb, mergedCommit, others, cfg, tools };
      let total = 0;
      for (const check of opts.checks ?? SECURITY_CHECKS) {
        const t0 = Date.now();
        let out: CheckOutput;
        try {
          out = check.run(ctx);
        } catch (err) {
          out = { coverage: { check: check.id, label: check.label, status: 'error', reason: (err as Error).message.split('\n')[0] }, findings: [] };
        }
        cover({ ...out.coverage, ms: Date.now() - t0 }, out.findings.length);
        drafts.push(...out.findings);
        total += out.findings.length;
        emit({ type: 'security.result', check: check.id, status: out.coverage.status, findings: out.findings.length });
      }
      return { value: undefined, status: total > 0 ? 'warn' : 'ok', summary: `${total} achado(s) em ${(opts.checks ?? SECURITY_CHECKS).length} verificações` };
    });
  }

  const findings = finalizeFindings(drafts, cfg.security);

  const report: AnalysisReport = {
    schema: 2,
    generatedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
    repo: basename(cwd),
    head: { name: head.name, ref: head.ref, sha: headSha, shortSha: shortSha(headSha), dirty },
    remote,
    fetched,
    primary: primary.name,
    targets: merges,
    overlaps,
    semantic,
    findings,
    coverage,
    summary: summarize({ primary: primary.name, targets: merges, overlaps, semantic, findings, coverage }),
    inputs: {
      version: VERSION,
      headSha,
      targets: targets.map((t) => ({ name: t.name, ref: t.ref, sha: revParse(cwd, t.ref) })),
      configHash: createHash('sha1').update(JSON.stringify(cfg)).digest('hex'),
      testCommand: command ?? null,
      buildCommand: build ?? null,
      security: opts.security !== false && cfg.security.enabled,
      overlap: opts.overlap !== false,
      isolation: cfg.isolation.mode,
    },
    divergence,
    warnings,
    verdict: { level: 'ok', reasons: [] },
    durationMs: 0,
  };
  report.verdict = buildVerdict(report, cfg);
  for (const r of report.verdict.reasons) report.summary.reasons[r.level]++;
  report.durationMs = Date.now() - started;
  emit({ type: 'run.end', level: report.verdict.level, reasons: report.verdict.reasons.filter((r) => r.level !== 'info').map((r) => r.text) });
  return report;
}
