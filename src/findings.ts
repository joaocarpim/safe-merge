import { createHash } from 'node:crypto';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'high' | 'medium' | 'low';
export type FindingLevel = 'block' | 'warn' | 'info';

/**
 * Um problema encontrado por uma verificação. O `id` é estável: não depende da linha (que muda quando
 * o arquivo é editado acima), só de categoria, regra, arquivo e evidência.
 */
export interface Finding {
  id: string;
  /** `secret`, `supply-chain`, `ci`, `sast`, `migration`, `env`, `coverage-gap`, `runtime`, `semantic`. */
  category: string;
  /** Regra dentro da categoria (ex.: `install-script`). */
  rule: string;
  title: string;
  message: string;
  severity: Severity;
  confidence: Confidence;
  file: string | null;
  line: number | null;
  /** Trecho conferido que sustenta o achado. Sem evidência, o achado nunca bloqueia. */
  evidence: string | null;
  /** Quem achou: `safemerge` ou o nome da ferramenta externa. */
  source: string;
  /** Calculado pelo núcleo a partir da configuração; os renderizadores só leem. */
  level: FindingLevel;
}

export type FindingDraft = Omit<Finding, 'id' | 'level'>;

/** `partial`: rodou com regras internas no lugar da ferramenta especializada (cobertura menor). */
export type CoverageStatus = 'ran' | 'partial' | 'skipped' | 'missing-tool' | 'error';

/** O que cada verificação fez. "0 achados" só vale para verificações com status `ran`. */
export interface CoverageEntry {
  check: string;
  label: string;
  status: CoverageStatus;
  reason?: string;
  findings: number;
  ms?: number;
}

export interface BlockPolicy {
  /** Gravidade mínima para bloquear. */
  blockSeverity: Severity;
  /** Confiança mínima para bloquear. */
  blockConfidence: Confidence;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** Só pode bloquear o que tem arquivo, linha e evidência. */
export function hasEvidence(f: Pick<Finding, 'file' | 'line' | 'evidence'>): boolean {
  return Boolean(f.file) && typeof f.line === 'number' && f.line > 0 && Boolean(f.evidence?.trim());
}

export function findingLevel(f: FindingDraft, policy: BlockPolicy): FindingLevel {
  if (f.severity === 'info') return 'info';
  const strong = SEVERITY_RANK[f.severity] >= SEVERITY_RANK[policy.blockSeverity] && CONFIDENCE_RANK[f.confidence] >= CONFIDENCE_RANK[policy.blockConfidence];
  if (strong && hasEvidence(f)) return 'block';
  // baixa confiança = heurística que erra: observação, não aviso (só aviso se a gravidade for alta)
  if (f.confidence === 'low' && SEVERITY_RANK[f.severity] < SEVERITY_RANK.high) return 'info';
  return 'warn';
}

export function findingId(f: Pick<FindingDraft, 'category' | 'rule' | 'file' | 'evidence' | 'message'>): string {
  const evidence = (f.evidence ?? f.message).replace(/\s+/g, ' ').trim();
  const hash = createHash('sha1').update([f.category, f.rule, f.file ?? '', evidence].join('\u0000')).digest('hex');
  return `SM-${hash.slice(0, 8)}`;
}

/** Dá id e nível aos rascunhos e remove duplicatas (mesmo id). Ordena por nível e gravidade. */
export function finalizeFindings(drafts: FindingDraft[], policy: BlockPolicy): Finding[] {
  const seen = new Map<string, Finding>();
  for (const d of drafts) {
    const id = findingId(d);
    if (!seen.has(id)) seen.set(id, { ...d, id, level: findingLevel(d, policy) });
  }
  const levelRank = { block: 0, warn: 1, info: 2 } as const;
  return [...seen.values()].sort(
    (a, b) => levelRank[a.level] - levelRank[b.level] || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id),
  );
}

/** Evidência de uma linha, curta e sem quebras, para caber em qualquer saída. */
export function clip(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
