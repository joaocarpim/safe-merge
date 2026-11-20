import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lineAt, showFile, touchedFiles } from '../diff.js';
import { clip, type Confidence, type FindingDraft, type Severity } from '../findings.js';
import { parseSarif, relativeUri, type SarifHit } from '../sarif.js';
import { git } from '../git.js';
import { SECRET_RULES, scanSecrets, secretFindings, workflowFindings } from './builtin-rules.js';
import { firstLine } from '../tools.js';
import { withTempDir, withWorktree } from '../worktree.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

function levelToSeverity(level: string, securitySeverity: number | null): Severity {
  if (securitySeverity !== null && Number.isFinite(securitySeverity)) {
    return securitySeverity >= 9 ? 'critical' : securitySeverity >= 7 ? 'high' : securitySeverity >= 4 ? 'medium' : 'low';
  }
  return level === 'error' ? 'high' : level === 'warning' ? 'medium' : level === 'note' ? 'low' : 'info';
}

function missing(check: Check, tool: string, url: string): CheckOutput {
  return { coverage: { check: check.id, label: check.label, status: 'missing-tool', reason: `${tool} não instalado (${url})` }, findings: [] };
}

function failed(check: Check, tool: string, code: number, stderr: string): CheckOutput {
  return { coverage: { check: check.id, label: check.label, status: 'error', reason: `${tool} saiu com ${code}: ${firstLine(stderr) || 'sem mensagem'}` }, findings: [] };
}

/** Evidência: o trecho que a ferramenta mostrou ou, sem ele, a linha do arquivo na sua branch. */
function evidenceFor(ctx: CheckContext, hit: SarifHit, file: string | null, rev = ctx.headRef): string | null {
  if (hit.snippet) return clip(hit.snippet);
  if (!file || !hit.line) return null;
  const text = lineAt(showFile(ctx.cwd, rev, file), hit.line);
  return text?.trim() ? clip(text) : null;
}

// ─── gitleaks: segredos em todos os commits da branch ───────────────────────────────────────────

export function gitleaksFindings(sarif: string): { ok: boolean; findings: FindingDraft[] } {
  const { ok, hits } = parseSarif(sarif);
  const findings = hits.map((h): FindingDraft => {
    const commit = h.fingerprints.commitSha?.slice(0, 7);
    const generic = /generic/i.test(h.ruleId);
    return {
      category: 'secret',
      rule: h.ruleId,
      title: 'Segredo no histórico da branch',
      message: `${h.message}${commit ? ` (commit ${commit})` : ''}. Apagar o arquivo não basta: o segredo continua no histórico. Revogue/troque a credencial.`,
      severity: 'high',
      confidence: generic ? 'medium' : 'high',
      file: relativeUri(h.uri, []),
      line: h.line,
      // gitleaks roda com --redact: o trecho já vem com o segredo trocado por REDACTED
      evidence: h.snippet ? clip(`${h.snippet}${commit ? ` @${commit}` : ''}`) : commit ? `${h.ruleId} @${commit}` : null,
      source: 'gitleaks',
    };
  });
  return { ok, findings };
}

export const secretsCheck: Check = {
  id: 'secrets',
  label: 'Segredos nos commits da branch (gitleaks)',
  run(ctx: CheckContext): CheckOutput {
    const tool = ctx.cfg.security.tools.gitleaks;
    return withTempDir((tmp) => {
      const report = join(tmp, 'gitleaks.sarif');
      const res = ctx.tools(
        tool,
        ['git', '--log-opts', `${ctx.mergeBase}..${ctx.headSha}`, '--report-format', 'sarif', '--report-path', report, '--redact', '--no-banner', '--exit-code', '0', ctx.cwd],
        { cwd: ctx.cwd },
      );
      if (res.missing) {
        const findings = secretFindings(scanSecrets(ctx.cwd, ctx.mergeBase, ctx.headSha));
        return {
          coverage: { check: this.id, label: this.label, status: 'partial', reason: `gitleaks não instalado: usei ${SECRET_RULES.length} padrões internos nos commits ${ctx.mergeBase.slice(0, 7)}..${ctx.headSha.slice(0, 7)} (instale o gitleaks para a cobertura completa)` },
          findings,
        };
      }
      const text = existsSync(report) ? readFileSync(report, 'utf8') : res.stdout;
      const { ok, findings } = gitleaksFindings(text);
      if (res.code !== 0 || !ok) return failed(this, 'gitleaks', res.code, res.stderr);
      return { coverage: { check: this.id, label: this.label, status: 'ran', reason: `commits ${ctx.mergeBase.slice(0, 7)}..${ctx.headSha.slice(0, 7)}` }, findings };
    });
  },
};

// ─── zizmor: workflows de CI alterados ──────────────────────────────────────────────────────────

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export function zizmorFindings(ctx: CheckContext, sarif: string, roots: string[]): { ok: boolean; findings: FindingDraft[] } {
  const { ok, hits } = parseSarif(sarif);
  const findings = hits.map((h): FindingDraft => {
    const rel = relativeUri(h.uri, roots);
    const idx = rel ? rel.indexOf('.github/workflows/') : -1;
    const file = rel && idx >= 0 ? rel.slice(idx) : rel;
    const confTag = h.tags.find((t) => /confidence/i.test(t)) ?? '';
    const confidence: Confidence = /high/i.test(confTag) ? 'high' : /low/i.test(confTag) ? 'low' : 'medium';
    return {
      category: 'ci',
      rule: h.ruleId,
      title: 'Workflow de CI perigoso',
      message: h.message,
      severity: levelToSeverity(h.level, h.securitySeverity),
      confidence,
      file,
      line: h.line,
      evidence: evidenceFor(ctx, h, file),
      source: 'zizmor',
    };
  });
  return { ok, findings };
}

export const workflowsCheck: Check = {
  id: 'workflows',
  label: 'Workflows de CI alterados (zizmor)',
  run(ctx: CheckContext): CheckOutput {
    const files = touchedFiles(ctx.cwd, ctx.mergeBase, ctx.headRef).filter((f) => WORKFLOW.test(f));
    if (files.length === 0) {
      return { coverage: { check: this.id, label: this.label, status: 'skipped', reason: 'nenhum workflow em .github/workflows mudou' }, findings: [] };
    }
    return withTempDir((tmp) => {
      // zizmor lê arquivos do disco: grava a versão da sua branch numa pasta temporária
      const paths: string[] = [];
      for (const f of files) {
        const text = showFile(ctx.cwd, ctx.headRef, f);
        if (text === null) continue;
        const out = join(tmp, f);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, text);
        paths.push(out);
      }
      const res = ctx.tools(ctx.cfg.security.tools.zizmor, ['--format', 'sarif', '--offline', ...paths], { cwd: tmp });
      if (res.missing) {
        const findings = files.flatMap((f) => workflowFindings(f, showFile(ctx.cwd, ctx.headRef, f) ?? ''));
        return {
          coverage: { check: this.id, label: this.label, status: 'partial', reason: `zizmor não instalado: usei regras internas (pull_request_target, injeção de template, write-all) em ${files.length} workflow(s); instale o zizmor para a cobertura completa` },
          findings,
        };
      }
      const { ok, findings } = zizmorFindings(ctx, res.stdout, [tmp]);
      // zizmor sai com 10–14 quando encontra problemas; o que importa é o SARIF ser válido
      if (!ok) return failed(this, 'zizmor', res.code, res.stderr);
      return { coverage: { check: this.id, label: this.label, status: 'ran', reason: `${files.length} workflow(s): ${files.join(', ')}` }, findings };
    });
  },
};

// ─── semgrep: SAST só no que a branch introduziu ────────────────────────────────────────────────

export function semgrepFindings(ctx: CheckContext, sarif: string, roots: string[], rev = ctx.headRef): { ok: boolean; findings: FindingDraft[] } {
  const { ok, hits } = parseSarif(sarif);
  const findings = hits.map((h): FindingDraft => {
    const file = relativeUri(h.uri, roots);
    const tags = h.tags.join(' ');
    const confidence: Confidence = /HIGH CONFIDENCE/i.test(tags) ? 'high' : /MEDIUM CONFIDENCE/i.test(tags) ? 'medium' : 'low';
    return {
      category: 'sast',
      rule: h.ruleId,
      title: 'Padrão inseguro no código novo',
      message: h.message,
      severity: levelToSeverity(h.level, h.securitySeverity),
      confidence,
      file,
      line: h.line,
      evidence: evidenceFor(ctx, h, file, rev),
      source: 'semgrep',
    };
  });
  return { ok, findings };
}

export const sastCheck: Check = {
  id: 'sast',
  label: 'SAST no código novo (semgrep)',
  run(ctx: CheckContext): CheckOutput {
    const probe = ctx.tools(ctx.cfg.security.tools.semgrep, ['--version'], { cwd: ctx.cwd, timeoutMs: 30_000 });
    if (probe.missing) return missing(this, 'semgrep', 'https://semgrep.dev/docs/getting-started/');
    // Merge limpo: escaneia o resultado do merge contra o destino (pega o que surge da combinação).
    // Com conflito: escaneia a sua branch contra o ponto de partida.
    const merged = ctx.mergedCommit ?? null;
    const scanRev = merged ?? ctx.headSha;
    const baseline = merged ? ctx.target.ref : ctx.mergeBase;
    const baselineSha = merged ? (git(ctx.cwd, ['rev-parse', ctx.target.ref]).stdout.trim() || ctx.target.ref) : ctx.mergeBase;
    // --baseline-commit precisa de uma cópia do commit escaneado: usa worktree temporária
    return withWorktree(ctx.cwd, scanRev, (dir) => {
      const res = ctx.tools(
        ctx.cfg.security.tools.semgrep,
        ['scan', '--config', ctx.cfg.security.semgrepConfig, '--sarif', '--baseline-commit', baselineSha, '--metrics', 'off', '--quiet', '--disable-version-check'],
        { cwd: dir, timeoutMs: 900_000 },
      );
      if (res.missing) return missing(this, 'semgrep', 'https://semgrep.dev/docs/getting-started/');
      const { ok, findings } = semgrepFindings(ctx, res.stdout, [dir], scanRev);
      if (!ok || res.code > 1) return failed(this, 'semgrep', res.code, res.stderr);
      const what = merged ? `resultado do merge contra ${ctx.target.name}` : `sua branch desde ${baseline.slice(0, 7)} (há conflito com ${ctx.target.name})`;
      return { coverage: { check: this.id, label: this.label, status: 'ran', reason: `regras ${ctx.cfg.security.semgrepConfig}, só achados novos: ${what}` }, findings };
    });
  },
};
