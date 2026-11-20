import type { AnalysisReport } from './analyze.js';
import type { Finding } from './findings.js';

/** Resultado de uma ferramenta externa, já tirado do SARIF. */
export interface SarifHit {
  ruleId: string;
  message: string;
  /** `error` | `warning` | `note` | `none` */
  level: string;
  uri: string | null;
  line: number | null;
  snippet: string | null;
  /** Tags e propriedades da regra (semgrep põe confiança nas tags). */
  tags: string[];
  /** `security-severity` da regra, quando a ferramenta informa (0 a 10). */
  securitySeverity: number | null;
  fingerprints: Record<string, string>;
}

interface SarifRule {
  id?: string;
  shortDescription?: { text?: string };
  defaultConfiguration?: { level?: string };
  properties?: { tags?: string[]; 'security-severity'?: string | number };
}

/** Lê SARIF 2.1.0 de qualquer ferramenta (gitleaks, semgrep, zizmor). Entrada inválida vira lista vazia. */
export function parseSarif(json: string): { ok: boolean; hits: SarifHit[] } {
  let doc: { runs?: Array<{ tool?: { driver?: { rules?: SarifRule[] } }; results?: unknown[] }> };
  try {
    doc = JSON.parse(json);
  } catch {
    return { ok: false, hits: [] };
  }
  if (!doc || !Array.isArray(doc.runs)) return { ok: false, hits: [] };
  const hits: SarifHit[] = [];
  for (const run of doc.runs) {
    const rules = new Map<string, SarifRule>();
    for (const r of run.tool?.driver?.rules ?? []) if (r.id) rules.set(r.id, r);
    for (const raw of run.results ?? []) {
      const r = raw as {
        ruleId?: string;
        rule?: { id?: string };
        level?: string;
        message?: { text?: string };
        locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; snippet?: { text?: string } } } }>;
        partialFingerprints?: Record<string, string>;
        properties?: { tags?: string[] };
      };
      const ruleId = r.ruleId ?? r.rule?.id ?? 'desconhecida';
      const rule = rules.get(ruleId);
      const loc = r.locations?.[0]?.physicalLocation;
      const sev = rule?.properties?.['security-severity'];
      hits.push({
        ruleId,
        message: (r.message?.text ?? rule?.shortDescription?.text ?? ruleId).trim(),
        level: r.level ?? rule?.defaultConfiguration?.level ?? 'warning',
        uri: loc?.artifactLocation?.uri ? decodeURIComponent(loc.artifactLocation.uri.replace(/^file:\/\//, '')) : null,
        line: typeof loc?.region?.startLine === 'number' ? loc.region.startLine : null,
        snippet: loc?.region?.snippet?.text?.trim() || null,
        tags: [...(rule?.properties?.tags ?? []), ...(r.properties?.tags ?? [])],
        securitySeverity: sev === undefined ? null : Number(sev),
        fingerprints: r.partialFingerprints ?? {},
      });
    }
  }
  return { ok: true, hits };
}

/** Caminho relativo ao projeto, a partir do que a ferramenta escreveu (absoluto, com barra invertida...). */
export function relativeUri(uri: string | null, roots: string[]): string | null {
  if (!uri) return null;
  let p = decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\\/g, '/').replace(/^\/([A-Za-z]:\/)/, '$1');
  for (const root of roots) {
    const r = root.replace(/\\/g, '/').replace(/\/$/, '');
    if (p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) {
      p = p.slice(r.length + 1);
      break;
    }
  }
  return p.replace(/^\.\//, '');
}

function sarifLevel(level: Finding['level']): 'error' | 'warning' | 'note' {
  return level === 'block' ? 'error' : level === 'warn' ? 'warning' : 'note';
}

/**
 * Exporta o relatório em SARIF 2.1.0: achados e conflitos de merge com arquivo e linha.
 * O GitHub Code Scanning e editores que leem SARIF usam este arquivo.
 */
export function renderSarif(report: AnalysisReport, version: string): string {
  const rules = new Map<string, { id: string; name: string; shortDescription: { text: string } }>();
  const results: unknown[] = [];

  for (const f of report.findings) {
    const ruleId = `${f.category}/${f.rule}`;
    if (!rules.has(ruleId)) rules.set(ruleId, { id: ruleId, name: ruleId, shortDescription: { text: f.title } });
    results.push({
      ruleId,
      level: sarifLevel(f.level),
      message: { text: `[${f.id}] ${f.title}: ${f.message}` },
      ...(f.file
        ? {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: f.file },
                  ...(f.line ? { region: { startLine: f.line, ...(f.evidence ? { snippet: { text: f.evidence } } : {}) } } : {}),
                },
              },
            ],
          }
        : {}),
      partialFingerprints: { safemergeId: f.id },
      properties: { id: f.id, severity: f.severity, confidence: f.confidence, source: f.source },
    });
  }

  for (const t of report.targets) {
    for (const c of t.conflicts) {
      const ruleId = 'merge/conflict';
      if (!rules.has(ruleId)) rules.set(ruleId, { id: ruleId, name: ruleId, shortDescription: { text: 'Conflito de merge previsto' } });
      const hunks = c.hunks.length > 0 ? c.hunks : [null];
      for (const h of hunks) {
        results.push({
          ruleId,
          level: t.target === report.primary ? 'error' : 'warning',
          message: { text: `conflito com ${t.target} em ${c.path} (${c.kind})` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: c.path },
                ...(h?.oursLine ? { region: { startLine: h.oursLine, endLine: h.oursLine + Math.max(0, h.oursTotal - 1) } } : {}),
              },
            },
          ],
          properties: { target: t.target, theirsLine: h?.theirsLine ?? null },
        });
      }
    }
  }

  const doc = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'safemerge', version, rules: [...rules.values()] } },
        results,
      },
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
