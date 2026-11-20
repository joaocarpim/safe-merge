import type { AnalysisReport, Level } from '../analyze.js';
import type { CoverageEntry, Finding } from '../findings.js';
import type { ConflictFile } from '../merge.js';
import type { OverlapEntry } from '../overlap.js';
import type { SemanticResult } from '../semantic.js';

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    contents: 'conteúdo',
    'modify/delete': 'alterado aqui, apagado lá',
    'add/add': 'criado nos dois lados',
    'rename/delete': 'renomeado × apagado',
    'rename/rename': 'renomeado nos dois lados',
    'file/directory': 'arquivo × pasta',
    binary: 'binário',
  };
  return map[kind] ?? kind;
}

export function severityLabel(s: Finding['severity']): string {
  return { critical: 'crítica', high: 'alta', medium: 'média', low: 'baixa', info: 'info' }[s];
}

export function confidenceLabel(c: Finding['confidence']): string {
  return { high: 'alta', medium: 'média', low: 'baixa' }[c];
}

export function coverageLabel(s: CoverageEntry['status']): string {
  return { ran: 'rodou', partial: 'parcial', skipped: 'pulou', 'missing-tool': 'ferramenta ausente', error: 'erro' }[s];
}

export function findingWhere(f: Finding): string {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '';
}

export function semanticWhy(s: SemanticResult): string {
  const stage = s.stage === 'build' ? 'o build' : 'os testes';
  if (s.cause === 'semantic-conflict') return `conflito semântico: cada lado passa sozinho, ${stage} quebra${s.stage === 'build' ? '' : 'm'} na junção`;
  if (s.cause === 'target-failing') return `já falhava em ${s.target}`;
  if (s.cause === 'branch-failing') return 'a sua branch já falha sozinha';
  return 'falha nos dois lados';
}

export function isolationLabel(s: SemanticResult): string {
  const iso = s.isolation;
  if (!iso) return '';
  if (iso.mode === 'docker') return 'isolado: container sem rede';
  return `sem isolamento${iso.envWithheld.length ? `; ambiente limpo (${iso.envWithheld.length} credencial(is) não repassada(s))` : '; ambiente limpo'}`;
}

/** Notas de um arquivo em conflito: lockfile e resultado do Mergiraf. */
export function conflictNotes(c: ConflictFile): string[] {
  const notes: string[] = [];
  if (c.hint === 'regenerate-lockfile') notes.push('lockfile: regenere depois do merge, não resolva na mão');
  if (c.structured?.result === 'line-only') notes.push('Mergiraf: conflito só de linha, junta pela estrutura');
  else if (c.structured?.result === 'real') notes.push('Mergiraf: conflito real, as mudanças se contradizem');
  else if (c.structured?.result === 'error') notes.push(`Mergiraf: não rodou (${c.structured.detail ?? 'erro'})`);
  return notes;
}

export function verdictTitle(level: Level): string {
  return level === 'block' ? 'NÃO MERGEAR' : level === 'warn' ? 'MERGEAR COM ATENÇÃO' : 'PODE MERGEAR';
}

export function headLabel(report: AnalysisReport): string {
  return `${report.head.name ?? 'HEAD'} (${report.head.shortSha})`;
}

export function overlapName(o: OverlapEntry): string {
  return o.pr ? `#${o.pr.number} ${o.branch}` : o.branch;
}

export function overlapWho(o: OverlapEntry): string {
  const who = o.pr?.author ?? o.lastCommit?.author;
  return who ? ` (${who})` : '';
}

/** Funções alteradas pelos dois lados (o git junta sozinho, mas a lógica pode colidir). */
export function sameFunctionNote(list: Array<{ path: string; functions: string[] }> | undefined): string {
  if (!list?.length) return '';
  return `mesma função alterada pelos dois lados: ${list.map((s) => `${s.functions.join(', ')} em ${s.path}`).join('; ')}`;
}

/** Renomeações que a outra branch fez em arquivos que você alterou. */
export function renameNote(o: OverlapEntry): string {
  if (!o.renames?.length) return '';
  return `renomeou ${o.renames.slice(0, 3).map((r) => `${r.from} → ${r.to}`).join(', ')}`;
}

export function ageLabel(days: number): string {
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  return `há ${days} dias`;
}

export function seconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

const ERROR_LINE = /\b(\w*Error|Exception|FAIL(ED)?|AssertionError|panic|fatal)\b|✗|✘|not ok|erro/i;

/**
 * Trecho mais útil da saída de um comando que falhou: a primeira linha de erro com um pouco de
 * contexto antes (o código que quebrou) e depois. O fim do stack trace quase nunca diz o motivo.
 */
export function errorExcerpt(tail: string, max = 8): string[] {
  const lines = tail.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const idx = lines.findIndex((l) => ERROR_LINE.test(l));
  if (idx === -1) return lines.slice(-max);
  const start = Math.max(0, idx - 3);
  return lines.slice(start, start + max);
}
