import type { AnalysisReport } from '../analyze.js';
import {
  ageLabel,
  confidenceLabel,
  conflictNotes,
  coverageLabel,
  errorExcerpt,
  findingWhere,
  headLabel,
  isolationLabel,
  kindLabel,
  overlapName,
  overlapWho,
  plural,
  renameNote,
  sameFunctionNote,
  seconds,
  semanticWhy,
  severityLabel,
  verdictTitle,
} from './common.js';

export interface TextOptions {
  color: boolean;
  /** Quantos conflitos detalhar por destino. */
  maxConflicts?: number;
}

function palette(color: boolean) {
  const wrap = (code: string) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

/** Saída para o terminal: legível sem cor, e com cor quando o terminal permite. */
export function renderText(report: AnalysisReport, opts: TextOptions): string {
  const c = palette(opts.color);
  const maxConflicts = opts.maxConflicts ?? 5;
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const rule = '─'.repeat(64);

  line(`${c.bold('safemerge')} · ${c.cyan(headLabel(report))} → ${c.cyan(report.primary)}`);
  line(c.dim(rule));
  line();

  const v = report.verdict;
  const verdictColor = v.level === 'block' ? c.red : v.level === 'warn' ? c.yellow : c.green;
  const icon = v.level === 'block' ? '✗' : v.level === 'warn' ? '!' : '✓';
  // veredito em uma linha forte, resumo logo abaixo (estilo transcrição de ferramenta)
  const word = { block: 'Não mergear', warn: 'Mergear com atenção', ok: 'Pode mergear' }[v.level];
  line(`${verdictColor('⏺')} ${c.bold(verdictColor(word))}  ${c.dim(`(${verdictTitle(v.level)})`)}`);
  const s = report.summary;
  if (s) {
    const n = (k: number, tone: (x: string) => string) => (k > 0 ? tone(String(k)) : c.green('0'));
    const tests = s.tests === 'passed' ? c.green('✓ passaram') : s.tests === 'failed' ? c.red('✗ falharam') : s.tests === 'flaky' ? c.yellow('~ instáveis') : s.tests === 'error' ? c.yellow('! erro') : c.dim('– não rodaram');
    const cov = `${s.coverage.ran + s.coverage.partial}/${s.coverage.total}${s.coverage.partial ? ` (${s.coverage.partial} parcial)` : ''}${s.coverage.missing + s.coverage.error ? c.yellow(` ${s.coverage.missing + s.coverage.error} sem cobertura`) : ''}`;
    line(
      `  ${c.dim('⎿')}  bloqueios ${n(s.reasons.block, c.red)} · avisos ${n(s.reasons.warn, c.yellow)} · conflitos ${n(s.conflictFiles, c.red)} · outros PRs ${n(s.otherBranchConflicts, c.yellow)} · testes ${tests} · cobertura ${cov}`,
    );
  }
  line();
  for (const r of v.reasons) {
    const mark = r.level === 'block' ? c.red('✗') : r.level === 'warn' ? c.yellow('!') : c.dim('·');
    line(`  ${mark} ${r.text}`);
  }
  if (v.reasons.length === 0) line(`  ${c.green('✓')} sem conflitos e sem avisos`);
  line();

  line(c.bold('MERGE SIMULADO'));
  for (const t of report.targets) {
    const name = t.target.padEnd(10);
    const behind = t.behind > 0 ? ` · ${plural(t.behind, 'commit atrás', 'commits atrás')}` : '';
    if (t.status === 'clean') {
      line(`  ${name} ${c.green('✓ limpo')}${c.dim(behind)}`);
    } else if (t.status === 'conflict') {
      line(`  ${name} ${c.red('✗ conflito')} ${plural(t.conflicts.length, 'arquivo', 'arquivos')}${c.dim(behind)}`);
    } else {
      line(`  ${name} ${c.yellow('! não simulado')} ${c.dim(t.error ?? '')}`);
    }
    for (const f of t.conflicts.slice(0, maxConflicts)) {
      line(`    ${f.path} ${c.dim(`(${kindLabel(f.kind)})`)}`);
      for (const n of conflictNotes(f)) line(`      ${c.yellow('→')} ${n}`);
      for (const h of f.hunks.slice(0, 2)) {
        const at = (l: number | null) => (l ? ` · linha ${l}` : '');
        line(c.dim(`      sua branch${at(h.oursLine)} | ${t.target}${at(h.theirsLine)}`));
        for (const l of h.ours) line(`      ${c.cyan('sua branch')} │ ${l}`);
        if (h.oursTotal > h.ours.length) line(c.dim(`      … mais ${h.oursTotal - h.ours.length} linhas`));
        for (const l of h.base) line(c.dim(`      ${'antes'.padEnd(10)} │ ${l}`));
        if (h.baseTotal > h.base.length) line(c.dim(`      … mais ${h.baseTotal - h.base.length} linhas`));
        for (const l of h.theirs) line(`      ${c.yellow(t.target.padEnd(10))} │ ${l}`);
        if (h.theirsTotal > h.theirs.length) line(c.dim(`      … mais ${h.theirsTotal - h.theirs.length} linhas`));
      }
      if (f.lastTouchOnTarget) {
        const l = f.lastTouchOnTarget;
        line(c.dim(`      última mudança em ${t.target}: ${l.author} · ${l.date} · ${l.subject} (${l.sha})`));
      }
    }
    if (t.conflicts.length > maxConflicts) line(c.dim(`    … e mais ${t.conflicts.length - maxConflicts} arquivos`));
    if (t.target === report.primary && t.sameFunction?.length) line(c.yellow(`    ${sameFunctionNote(t.sameFunction)}`));
    if (t.target === report.primary && t.autoMerged.length > 0) {
      line(c.dim(`    juntados sozinhos (alterados dos dois lados): ${t.autoMerged.slice(0, 5).join(', ')}${t.autoMerged.length > 5 ? '…' : ''}`));
    }
  }
  line();

  if (report.overlaps.length > 0) {
    line(c.bold('OUTRAS BRANCHES E PRS NOS MESMOS ARQUIVOS'));
    for (const o of report.overlaps) {
      const when = c.dim(ageLabel(o.ageDays));
      const ren = renameNote(o);
      if (o.wouldConflict) {
        line(`  ${c.red('✗')} ${overlapName(o)}${overlapWho(o)} ${c.red('conflita')} em ${o.conflictFiles.slice(0, 3).join(', ')} ${when}`);
      } else if (o.relation === 'ours-contains-theirs') {
        line(`  ${c.yellow('!')} ${overlapName(o)}${overlapWho(o)} já está dentro desta branch: mergeie-a primeiro ${when}`);
      } else if (o.relation === 'theirs-contains-ours') {
        line(`  ${c.yellow('!')} ${overlapName(o)}${overlapWho(o)} depende desta branch ${when}`);
      } else {
        line(`  ${c.dim('·')} ${overlapName(o)}${overlapWho(o)} mexe em ${o.sharedFiles.slice(0, 3).join(', ')}, mas junta sem conflito ${when}`);
      }
      if (ren) line(c.dim(`      ${ren}: suas mudanças vão para o arquivo novo`));
      const same = sameFunctionNote(o.sameFunctions);
      if (same) line(c.yellow(`      ${same}`));
    }
    line();
  }

  for (const s of report.semantic) {
    line(c.bold('TESTES NO RESULTADO DO MERGE'));
    const dur = s.durationMs ? ` ${c.dim(seconds(s.durationMs))}` : '';
    if (s.status === 'passed') line(`  ${c.green('✓')} ${s.target}: passou${dur}`);
    else if (s.status === 'skipped') line(`  ${c.dim('·')} ${s.target}: pulado (${s.reason})`);
    else if (s.status === 'error') line(`  ${c.yellow('!')} ${s.target}: ${s.reason}`);
    else if (s.status === 'flaky') {
      line(`  ${c.yellow('!')} ${s.target}: instável, falhou e passou ao repetir (${s.attempts} tentativas)${dur}`);
      for (const l of errorExcerpt(s.outputTail)) line(c.dim(`      ${l}`));
    } else {
      line(`  ${c.red('✗')} ${s.target}: falhou, ${semanticWhy(s)}${dur}`);
      for (const l of errorExcerpt(s.outputTail)) line(c.dim(`      ${l}`));
    }
    if (s.isolation) line(c.dim(`    ${isolationLabel(s)}`));
    line();
  }

  if (report.findings.length > 0) {
    line(c.bold('SEGURANÇA E DEPLOY'));
    for (const f of report.findings) {
      const mark = f.level === 'block' ? c.red('✗') : f.level === 'warn' ? c.yellow('!') : c.dim('·');
      const where = findingWhere(f);
      line(`  ${mark} ${c.bold(f.id)} ${f.title}${where ? ` ${c.cyan(where)}` : ''}`);
      line(c.dim(`      gravidade ${severityLabel(f.severity)} · confiança ${confidenceLabel(f.confidence)} · ${f.source}`));
      line(`      ${f.message}`);
      if (f.evidence) line(c.dim(`      evidência: ${f.evidence}`));
    }
    line();
  }

  if (report.coverage.length > 0) {
    line(c.bold('COBERTURA'));
    for (const cv of report.coverage) {
      const mark = cv.status === 'ran' ? c.green('✓') : cv.status === 'partial' ? c.cyan('◐') : cv.status === 'skipped' ? c.dim('·') : c.yellow('!');
      const count = cv.status === 'ran' || cv.status === 'partial' ? ` · ${plural(cv.findings, 'problema', 'problemas')}` : '';
      line(`  ${mark} ${cv.label}: ${coverageLabel(cv.status)}${count}${cv.reason ? c.dim(` (${cv.reason})`) : ''}`);
    }
    line();
  }

  const plan = report.plan ?? [];
  if (plan.length > 0 && report.verdict.level !== 'ok') {
    line(c.bold('PLANO PARA MERGEAR'));
    for (const s of plan) {
      const mark = s.level === 'block' ? c.red('✗') : s.level === 'warn' ? c.yellow('!') : c.dim('·');
      line(`  ${String(s.n).padStart(2)}. ${mark} ${s.title}${s.file ? c.dim(` (${s.file}${s.line ? `:${s.line}` : ''})`) : ''}`);
      if (s.command) line(`      ${c.cyan(s.command)}`);
    }
    line();
  }

  for (const w of report.warnings) line(c.dim(`aviso: ${w}`));
  line(c.dim(`${seconds(report.durationMs)} · somente leitura: nenhuma branch foi alterada`));
  return `${out.join('\n')}\n`;
}
