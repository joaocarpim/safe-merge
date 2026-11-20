import type { AnalysisReport } from '../analyze.js';
import {
  ageLabel,
  confidenceLabel,
  conflictNotes,
  coverageLabel,
  errorExcerpt,
  findingWhere,
  isolationLabel,
  kindLabel,
  overlapName,
  overlapWho,
  plural,
  renameNote,
  sameFunctionNote,
  semanticWhy,
  severityLabel,
  verdictTitle,
} from './common.js';

/** Célula de tabela: sem quebra de linha e sem `|` solto. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
}

/** Saída em Markdown: pensada para colar no chat, em PRs e em issues. */
export function renderMarkdown(report: AnalysisReport): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const v = report.verdict;
  const badge = v.level === 'block' ? '🔴' : v.level === 'warn' ? '🟡' : '🟢';

  line(`## safemerge: \`${report.head.name ?? 'HEAD'}\` → \`${report.primary}\``);
  line(`<sub>commit \`${report.head.shortSha}\`</sub>`);
  line();
  line(`**${badge} ${verdictTitle(v.level)}**`);
  line();
  for (const r of v.reasons) {
    line(`- ${r.level === 'block' ? '❌' : r.level === 'warn' ? '⚠️' : 'ℹ️'} ${r.text}`);
  }
  if (v.reasons.length === 0) line('- ✅ sem conflitos e sem avisos');
  line();

  line('### Merge simulado');
  line();
  line('| Destino | Resultado | Atraso | Conflitos |');
  line('|---|---|---|---|');
  for (const t of report.targets) {
    const result = t.status === 'clean' ? '✅ limpo' : t.status === 'conflict' ? '❌ conflito' : '⚠️ não simulado';
    line(`| \`${t.target}\`${t.target === report.primary ? ' (destino)' : ''} | ${result} | ${t.behind} | ${t.conflicts.length} |`);
  }
  line();

  for (const t of report.targets.filter((x) => x.conflicts.length > 0)) {
    line(`#### Conflitos com \`${t.target}\``);
    line();
    for (const f of t.conflicts.slice(0, 5)) {
      line(`**\`${f.path}\`** (${kindLabel(f.kind)})`);
      for (const n of conflictNotes(f)) line(`> ${n}`);
      const h = f.hunks[0];
      if (h) {
        line();
        line('```diff');
        line(`# sua branch${h.oursLine ? `, a partir da linha ${h.oursLine}` : ''}`);
        for (const l of h.ours) line(`+ ${l}`);
        if (h.base.length > 0) {
          line('# antes (ponto de partida)');
          for (const l of h.base) line(`  ${l}`);
        }
        line(`# ${t.target}${h.theirsLine ? `, a partir da linha ${h.theirsLine}` : ''}`);
        for (const l of h.theirs) line(`- ${l}`);
        line('```');
      }
      if (f.lastTouchOnTarget) {
        const l = f.lastTouchOnTarget;
        line(`> Última mudança em \`${t.target}\`: ${l.author}, ${l.date}: ${l.subject} (\`${l.sha}\`)`);
      }
      line();
    }
  }

  if (report.overlaps.length > 0) {
    line('### Outras branches e PRs nos mesmos arquivos');
    line();
    for (const o of report.overlaps) {
      const files = (o.wouldConflict ? o.conflictFiles : o.sharedFiles).slice(0, 3).map((f) => `\`${f}\``).join(', ');
      const status = o.wouldConflict
        ? `❌ conflita em ${files}`
        : o.relation === 'ours-contains-theirs'
          ? '⚠️ já está dentro desta branch, mergeie-a primeiro'
          : o.relation === 'theirs-contains-ours'
            ? '⚠️ depende desta branch'
            : `mexe em ${files}, junta sem conflito`;
      const ren = [renameNote(o), sameFunctionNote(o.sameFunctions)].filter(Boolean).join('; ');
      line(`- **${overlapName(o)}**${overlapWho(o)}: ${status} (${ageLabel(o.ageDays)})${ren ? `; ${ren}` : ''}`);
    }
    line();
  }

  for (const s of report.semantic) {
    line('### Testes no resultado do merge');
    line();
    if (s.status === 'passed') line(`✅ \`${s.command}\` passou no merge com \`${s.target}\`.`);
    else if (s.status === 'skipped') line(`Pulado: ${s.reason}.`);
    else if (s.status === 'error') line(`⚠️ ${s.reason}`);
    else if (s.status === 'flaky') line(`⚠️ \`${s.command}\` instável: falhou e passou ao repetir (${s.attempts} tentativas). Não acusado como conflito.`);
    else {
      line(`❌ \`${s.command}\` falhou: ${semanticWhy(s)}.`);
      line();
      line('```');
      line(errorExcerpt(s.outputTail, 10).join('\n'));
      line('```');
    }
    if (s.isolation) {
      line();
      line(`<sub>${isolationLabel(s)}</sub>`);
    }
    line();
  }

  if (report.findings.length > 0) {
    line('### Segurança e deploy');
    line();
    line('| | Id | Achado | Onde | Gravidade | Confiança |');
    line('|---|---|---|---|---|---|');
    for (const f of report.findings) {
      const mark = f.level === 'block' ? '❌' : f.level === 'warn' ? '⚠️' : 'ℹ️';
      const where = findingWhere(f);
      line(`| ${mark} | \`${f.id}\` | ${cell(f.title)} | ${where ? `\`${cell(where)}\`` : ''} | ${severityLabel(f.severity)} | ${confidenceLabel(f.confidence)} |`);
    }
    line();
    for (const f of report.findings.filter((x) => x.level !== 'info')) {
      line(`<details><summary><code>${f.id}</code> ${escHtml(f.title)}</summary>`);
      line();
      line(f.message);
      if (f.evidence) {
        line();
        line('```');
        line(f.evidence);
        line('```');
      }
      line();
      line(`Fonte: ${f.source}`);
      line();
      line('</details>');
    }
    line();
  }

  if (report.coverage.length > 0) {
    line('### Cobertura');
    line();
    line('| Verificação | Resultado | Problemas | Detalhe |');
    line('|---|---|---|---|');
    for (const c of report.coverage) {
      const icon = c.status === 'ran' ? '✅' : c.status === 'partial' ? '◐' : c.status === 'skipped' ? '⏭️' : '⚠️';
      line(`| ${cell(c.label)} | ${icon} ${coverageLabel(c.status)} | ${c.status === 'ran' || c.status === 'partial' ? c.findings : '–'} | ${cell(c.reason ?? '')} |`);
    }
    line();
  }

  for (const w of report.warnings) line(`_aviso: ${w}_`);
  line(`_${plural(report.targets.length, 'destino analisado', 'destinos analisados')} · somente leitura_`);
  return `${out.join('\n')}\n`;
}
