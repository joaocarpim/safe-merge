import type { AnalysisReport } from '../analyze.js';
import { kindLabel } from './common.js';

/** Escape dos comandos de workflow do GitHub Actions (mensagem). */
function data(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape dos comandos de workflow do GitHub Actions (propriedades). */
function prop(s: string): string {
  return data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function command(kind: 'error' | 'warning' | 'notice', props: Record<string, string | number | null | undefined>, message: string): string {
  const p = Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${prop(String(v))}`)
    .join(',');
  return `::${kind}${p ? ` ${p}` : ''}::${data(message)}`;
}

/**
 * Anotações do GitHub Actions: cada achado e cada bloco em conflito vira uma marca na linha do diff
 * do PR. Não precisa de permissão extra (é saída do job).
 */
export function renderGithub(report: AnalysisReport): string {
  const out: string[] = [];
  for (const f of report.findings) {
    const kind = f.level === 'block' ? 'error' : f.level === 'warn' ? 'warning' : 'notice';
    out.push(command(kind, { file: f.file, line: f.line, title: `safemerge ${f.id}: ${f.title}` }, `${f.message}${f.evidence ? `\nevidência: ${f.evidence}` : ''}`));
  }
  for (const t of report.targets) {
    const kind = t.target === report.primary ? 'error' : 'warning';
    for (const c of t.conflicts) {
      const hunks = c.hunks.length > 0 ? c.hunks : [null];
      for (const h of hunks) {
        const who = c.lastTouchOnTarget ? ` Última mudança em ${t.target}: ${c.lastTouchOnTarget.author}, ${c.lastTouchOnTarget.subject} (${c.lastTouchOnTarget.sha}).` : '';
        out.push(
          command(
            kind,
            { file: c.path, line: h?.oursLine, endLine: h?.oursLine ? h.oursLine + Math.max(0, h.oursTotal - 1) : null, title: `safemerge: conflito com ${t.target}` },
            `${kindLabel(c.kind)}.${who}${h ? `\n${t.target}:\n${h.theirs.join('\n')}` : ''}`,
          ),
        );
      }
    }
  }
  const v = report.verdict;
  const title = v.level === 'block' ? 'não mergear' : v.level === 'warn' ? 'mergear com atenção' : 'pode mergear';
  out.push(command(v.level === 'block' ? 'error' : v.level === 'warn' ? 'warning' : 'notice', { title: `safemerge: ${title}` }, v.reasons.filter((r) => r.level !== 'info').map((r) => r.text).join('\n') || 'sem conflitos e sem avisos'));
  return `${out.join('\n')}\n`;
}
