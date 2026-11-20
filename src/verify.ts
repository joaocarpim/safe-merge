import type { AnalysisReport } from './analyze.js';

/**
 * Verificador SEM IA: confere o que um texto (escrito por um modelo) afirma contra o relatório.
 * A IA não pode inventar números: cada id, commit, PR, `arquivo:linha` e contagem citada precisa
 * existir no relatório. O que não confere volta como "não verificado" com o motivo.
 */
export interface Claim {
  text: string;
  kind: 'finding-id' | 'sha' | 'pr' | 'location' | 'count';
  status: 'verified' | 'unverified';
  reason?: string;
}

export interface VerifyResult {
  ok: boolean;
  claims: Claim[];
}

type Unit = 'arquivo' | 'commit' | 'conflito' | 'achado' | 'branch' | 'pr' | 'teste' | 'linha';

const UNIT_WORDS: Array<[RegExp, Unit]> = [
  [/^arquivos?$/i, 'arquivo'],
  [/^commits?$/i, 'commit'],
  [/^conflitos?$/i, 'conflito'],
  [/^(achados?|problemas?|alertas?)$/i, 'achado'],
  [/^(branch|branches|ramos?)$/i, 'branch'],
  [/^(prs?|pull requests?)$/i, 'pr'],
  [/^linhas?$/i, 'linha'],
];

function unitOf(word: string): Unit | null {
  for (const [re, u] of UNIT_WORDS) if (re.test(word)) return u;
  return null;
}

/** Todas as contagens que o relatório sustenta, por unidade. */
export function reportCounts(r: AnalysisReport): Map<Unit, Set<number>> {
  const m = new Map<Unit, Set<number>>();
  const add = (u: Unit, n: number) => {
    if (!m.has(u)) m.set(u, new Set());
    m.get(u)!.add(n);
  };
  let conflictsTotal = 0;
  for (const t of r.targets) {
    add('arquivo', t.conflicts.length);
    add('conflito', t.conflicts.length);
    add('arquivo', t.autoMerged.length);
    add('commit', t.behind);
    add('commit', t.ahead);
    conflictsTotal += t.conflicts.length;
    const hunks = t.conflicts.reduce((n, c) => n + c.hunks.length, 0);
    add('conflito', hunks);
    for (const c of t.conflicts) for (const h of c.hunks) {
      add('linha', h.oursTotal);
      add('linha', h.theirsTotal);
    }
  }
  add('conflito', conflictsTotal);
  add('arquivo', conflictsTotal);
  for (const o of r.overlaps) {
    add('arquivo', o.sharedFiles.length);
    add('arquivo', o.conflictFiles.length);
  }
  const conflicting = r.overlaps.filter((o) => o.wouldConflict);
  add('branch', r.overlaps.length);
  add('branch', conflicting.length);
  add('pr', r.overlaps.filter((o) => o.pr).length);
  add('pr', conflicting.filter((o) => o.pr).length);
  for (const d of r.divergence ?? []) {
    add('commit', d.localAhead);
    add('commit', d.remoteAhead);
  }
  add('achado', r.findings.length);
  for (const level of ['block', 'warn', 'info'] as const) add('achado', r.findings.filter((f) => f.level === level).length);
  for (const c of r.coverage) add('achado', c.findings);
  for (const cat of new Set(r.findings.map((f) => f.category))) add('achado', r.findings.filter((f) => f.category === cat).length);
  add('branch', r.targets.length);
  return m;
}

/** Linhas citáveis por arquivo: achados e blocos de conflito (nos dois lados). */
function knownLocations(r: AnalysisReport): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>();
  const add = (file: string, line: number | null) => {
    if (!m.has(file)) m.set(file, new Set());
    if (line) m.get(file)!.add(line);
  };
  for (const f of r.findings) if (f.file) add(f.file, f.line);
  for (const t of r.targets) {
    for (const c of t.conflicts) {
      add(c.path, null);
      for (const h of c.hunks) {
        add(c.path, h.oursLine);
        add(c.path, h.theirsLine);
      }
    }
    for (const p of t.autoMerged) add(p, null);
  }
  for (const o of r.overlaps) for (const p of [...o.sharedFiles, ...o.conflictFiles]) add(p, null);
  return m;
}

export function verifyText(text: string, report: AnalysisReport): VerifyResult {
  const claims: Claim[] = [];
  const json = JSON.stringify(report);
  const ids = new Set(report.findings.map((f) => f.id));
  const prs = new Set(report.overlaps.flatMap((o) => (o.pr ? [o.pr.number] : [])));
  const counts = reportCounts(report);
  const locations = knownLocations(report);
  const seen = new Set<string>();
  const push = (c: Claim) => {
    const key = `${c.kind}:${c.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push(c);
    }
  };

  for (const m of text.matchAll(/\bSM-[0-9a-f]{8}\b/g)) {
    push({ text: m[0], kind: 'finding-id', ...(ids.has(m[0]) ? { status: 'verified' } : { status: 'unverified', reason: 'id de achado que não existe no relatório' }) });
  }
  const withoutIds = text.replace(/\bSM-[0-9a-f]{8}\b/g, ' ');
  for (const m of withoutIds.matchAll(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g)) {
    push({ text: m[0], kind: 'sha', ...(json.includes(m[0]) ? { status: 'verified' } : { status: 'unverified', reason: 'commit que não aparece no relatório' }) });
  }
  for (const m of text.matchAll(/(?<![\w&])#(\d{1,6})\b/g)) {
    const n = Number(m[1]);
    push({ text: m[0], kind: 'pr', ...(prs.has(n) ? { status: 'verified' } : { status: 'unverified', reason: 'PR que não aparece no relatório' }) });
  }
  for (const m of text.matchAll(/(?<![\w/.-])([\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8}):(\d+)\b/g)) {
    const file = m[1]!;
    const line = Number(m[2]);
    const known = locations.get(file);
    const status: Claim['status'] = known?.has(line) ? 'verified' : 'unverified';
    push({ text: m[0], kind: 'location', status, ...(status === 'unverified' ? { reason: known ? `${file} está no relatório, mas não a linha ${line}` : `${file} não aparece no relatório` } : {}) });
  }
  for (const m of text.matchAll(/\b(\d{1,6})\s+(?:(?:novos?|novas?|outras?|outros?)\s+)?([A-Za-zÀ-ú]+(?:\s+requests?)?)/g)) {
    const unit = unitOf(m[2]!);
    if (!unit) continue;
    const n = Number(m[1]);
    const ok = counts.get(unit)?.has(n) ?? false;
    push({ text: m[0].trim(), kind: 'count', ...(ok ? { status: 'verified' } : { status: 'unverified', reason: `nenhuma contagem de ${unit} igual a ${n} no relatório` }) });
  }
  return { ok: claims.every((c) => c.status === 'verified'), claims };
}

/** Branches que andaram desde o relatório (o resultado pode não valer mais). */
export function staleRefs(report: AnalysisReport, resolve: (ref: string) => string | null): string[] {
  const out: string[] = [];
  for (const t of report.inputs?.targets ?? []) {
    const now = resolve(t.ref);
    if (now && now !== t.sha) out.push(`${t.name} mudou desde o relatório (${t.sha.slice(0, 7)} → ${now.slice(0, 7)})`);
  }
  return out;
}

export function renderVerify(v: VerifyResult): string {
  const out: string[] = [];
  out.push(v.ok ? `✓ tudo confere com o relatório (${v.claims.length} afirmação(ões) verificada(s))` : '✗ há afirmações que não conferem com o relatório');
  for (const c of v.claims) out.push(`  ${c.status === 'verified' ? '✓' : '✗'} ${c.kind.padEnd(10)} ${c.text}${c.reason ? `: ${c.reason}` : ''}`);
  return `${out.join('\n')}\n`;
}
