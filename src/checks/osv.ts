import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findLine, showFile, touchedFiles } from '../diff.js';
import type { FindingDraft, Severity } from '../findings.js';
import { firstLine } from '../tools.js';
import { withTempDir } from '../worktree.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

/** Lockfiles e manifestos que o OSV-Scanner lê. */
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|poetry\.lock|Pipfile\.lock|uv\.lock|go\.mod|Cargo\.lock|composer\.lock|Gemfile\.lock|pom\.xml|gradle\.lockfile|pubspec\.lock|mix\.lock)$/;

export interface OsvVuln {
  ecosystem: string;
  name: string;
  version: string;
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
}

function severityOf(maxSeverity: string | undefined, dbSeverity: string | undefined): Severity {
  const n = maxSeverity ? Number.parseFloat(maxSeverity) : Number.NaN;
  if (Number.isFinite(n)) return n >= 9 ? 'critical' : n >= 7 ? 'high' : n >= 4 ? 'medium' : 'low';
  const s = (dbSeverity ?? '').toUpperCase();
  if (s === 'CRITICAL') return 'critical';
  if (s === 'HIGH') return 'high';
  if (s === 'MODERATE' || s === 'MEDIUM') return 'medium';
  if (s === 'LOW') return 'low';
  return 'medium'; // sem gravidade informada: não esconde, mas também não bloqueia sozinho
}

interface OsvJson {
  results?: Array<{
    packages?: Array<{
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: Array<{ id?: string; summary?: string; aliases?: string[]; database_specific?: { severity?: string } }>;
      groups?: Array<{ ids?: string[]; max_severity?: string }>;
    }>;
  }>;
}

/** Interpreta `osv-scanner --format json`. Uma entrada por grupo (aliases da mesma falha contam uma vez). */
export function parseOsv(json: string): { ok: boolean; vulns: OsvVuln[] } {
  let doc: OsvJson;
  try {
    doc = JSON.parse(json) as OsvJson;
  } catch {
    return { ok: false, vulns: [] };
  }
  const vulns: OsvVuln[] = [];
  for (const r of doc.results ?? []) {
    for (const p of r.packages ?? []) {
      const name = p.package?.name ?? '?';
      const byId = new Map((p.vulnerabilities ?? []).map((v) => [v.id ?? '', v]));
      const groups = p.groups?.length ? p.groups : (p.vulnerabilities ?? []).map((v) => ({ ids: [v.id ?? ''], max_severity: undefined }));
      for (const g of groups) {
        const ids = (g.ids ?? []).filter(Boolean);
        const main = ids.map((id) => byId.get(id)).find(Boolean);
        if (!ids[0]) continue;
        vulns.push({
          ecosystem: p.package?.ecosystem ?? '',
          name,
          version: p.package?.version ?? '?',
          id: ids[0],
          aliases: [...new Set([...ids.slice(1), ...(main?.aliases ?? [])])],
          summary: main?.summary ?? '',
          severity: severityOf(g.max_severity, main?.database_specific?.severity),
        });
      }
    }
  }
  return { ok: true, vulns };
}

/** Falhas que existem depois e não existiam antes (por pacote e id, ignorando a versão). */
export function newVulns(before: OsvVuln[], after: OsvVuln[]): OsvVuln[] {
  const key = (v: OsvVuln) => `${v.ecosystem}:${v.name}:${[v.id, ...v.aliases].sort()[0]}`;
  const old = new Set(before.map(key));
  return after.filter((v) => !old.has(key(v)));
}

export const osvCheck: Check = {
  id: 'cve',
  label: 'Vulnerabilidade nova em dependência (OSV-Scanner)',
  run(ctx: CheckContext): CheckOutput {
    const files = touchedFiles(ctx.cwd, ctx.mergeBase, ctx.headRef).filter((f) => LOCKFILE.test(f));
    if (files.length === 0) {
      return { coverage: { check: this.id, label: this.label, status: 'skipped', reason: 'nenhum lockfile ou manifesto de dependências mudou' }, findings: [] };
    }
    const tool = ctx.cfg.security.tools.osvScanner;
    const findings: FindingDraft[] = [];
    let scanned = 0;
    for (const file of files) {
      const after = showFile(ctx.cwd, ctx.headRef, file, 100_000_000);
      if (after === null) continue;
      const before = showFile(ctx.cwd, ctx.mergeBase, file, 100_000_000);
      const scan = (text: string | null): { missing: boolean; ok: boolean; vulns: OsvVuln[]; error?: string } => {
        if (text === null) return { missing: false, ok: true, vulns: [] };
        return withTempDir((tmp) => {
          const dir = join(tmp, 'x');
          mkdirSync(dir);
          const path = join(dir, basename(file));
          writeFileSync(path, text);
          const res = ctx.tools(tool, ['--format', 'json', '--lockfile', path], { cwd: dir, timeoutMs: 300_000 });
          if (res.missing) return { missing: true, ok: false, vulns: [] };
          if (res.code === 128) return { missing: false, ok: true, vulns: [] }; // nenhum pacote encontrado
          const parsed = parseOsv(res.stdout);
          if (!parsed.ok || (res.code !== 0 && res.code !== 1)) return { missing: false, ok: false, vulns: [], error: `osv-scanner saiu com ${res.code}: ${firstLine(res.stderr) || 'sem mensagem'}` };
          return { missing: false, ok: true, vulns: parsed.vulns };
        });
      };
      const a = scan(after);
      if (a.missing) return { coverage: { check: this.id, label: this.label, status: 'missing-tool', reason: 'osv-scanner não instalado (https://google.github.io/osv-scanner/)' }, findings: [] };
      if (!a.ok) return { coverage: { check: this.id, label: this.label, status: 'error', reason: a.error }, findings: [] };
      const b = scan(before);
      if (!b.ok) return { coverage: { check: this.id, label: this.label, status: 'error', reason: b.error }, findings: [] };
      scanned++;
      for (const v of newVulns(b.vulns, a.vulns)) {
        const line = findLine(after, `"node_modules/${v.name}"`) ?? findLine(after, v.name) ?? 1;
        const aliases = v.aliases.filter((x) => x.startsWith('CVE-'));
        findings.push({
          category: 'supply-chain',
          rule: 'new-vulnerability',
          title: `Vulnerabilidade nova: ${v.name}@${v.version}`,
          message: `${v.id}${aliases.length ? ` (${aliases.join(', ')})` : ''}${v.summary ? `: ${v.summary}` : ''}. Não existia no ponto de partida: entrou com esta branch. Veja https://osv.dev/vulnerability/${v.id}`,
          severity: v.severity,
          confidence: 'high',
          file,
          line,
          evidence: `${v.name}@${v.version}: ${v.id}`,
          source: 'osv-scanner',
        });
      }
    }
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason: `${scanned} arquivo(s) comparado(s) com o ponto de partida; consulta a base OSV na internet` }, findings };
  },
};
