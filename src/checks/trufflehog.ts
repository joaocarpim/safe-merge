import { pathToFileURL } from 'node:url';
import type { FindingDraft } from '../findings.js';
import { firstLine } from '../tools.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

export interface TruffleHit {
  detector: string;
  commit: string;
  file: string | null;
  line: number | null;
}

/**
 * Lê a saída NDJSON de `trufflehog git --json --only-verified`. Guarda só detector, commit, arquivo e
 * linha: os campos Raw/Redacted têm o segredo e nunca entram no relatório.
 */
export function parseTrufflehog(ndjson: string): TruffleHit[] {
  const out: TruffleHit[] = [];
  for (const line of ndjson.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line) as { Verified?: boolean; DetectorName?: string; SourceMetadata?: { Data?: { Git?: { commit?: string; file?: string; line?: number } } } };
      if (r.Verified !== true) continue;
      const git = r.SourceMetadata?.Data?.Git;
      out.push({ detector: r.DetectorName ?? 'desconhecido', commit: (git?.commit ?? '').slice(0, 7), file: git?.file ?? null, line: typeof git?.line === 'number' ? git.line : null });
    } catch {
      /* linha de log, não de resultado */
    }
  }
  return out;
}

/**
 * Segredo ATIVO (TruffleHog com verificação). Desligado por padrão: verificar significa usar a credencial
 * contra o provedor, o que pode aparecer no log de auditoria dele. Ligue com security.verifySecrets.
 */
export const activeSecretsCheck: Check = {
  id: 'active-secrets',
  label: 'Segredo ativo nos commits (TruffleHog)',
  run(ctx: CheckContext): CheckOutput {
    if (!ctx.cfg.security.verifySecrets) {
      return {
        coverage: { check: this.id, label: this.label, status: 'skipped', reason: 'desligado: verificar contata o provedor do segredo (pode gerar alerta no log de auditoria). Ligue com security.verifySecrets' },
        findings: [],
      };
    }
    const res = ctx.tools(
      ctx.cfg.security.tools.trufflehog,
      ['git', pathToFileURL(ctx.cwd).href, '--since-commit', ctx.mergeBase, '--branch', ctx.headSha, '--only-verified', '--json', '--no-update'],
      { cwd: ctx.cwd, timeoutMs: 900_000 },
    );
    if (res.missing) return { coverage: { check: this.id, label: this.label, status: 'missing-tool', reason: 'trufflehog não instalado (https://github.com/trufflesecurity/trufflehog)' }, findings: [] };
    if (res.code !== 0 && res.code !== 183) {
      return { coverage: { check: this.id, label: this.label, status: 'error', reason: `trufflehog saiu com ${res.code}: ${firstLine(res.stderr) || 'sem mensagem'}` }, findings: [] };
    }
    const findings: FindingDraft[] = parseTrufflehog(res.stdout).map((h) => ({
      category: 'secret',
      rule: 'active-secret',
      title: `Segredo ATIVO no histórico (${h.detector})`,
      message: `O TruffleHog confirmou com o provedor que a credencial ${h.detector} do commit ${h.commit} funciona. Revogue agora; apagar do código não basta.`,
      severity: 'critical',
      confidence: 'high',
      file: h.file,
      line: h.line,
      evidence: `${h.detector} verificado no commit ${h.commit}`,
      source: 'trufflehog',
    }));
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason: `commits ${ctx.mergeBase.slice(0, 7)}..${ctx.headSha.slice(0, 7)}, só segredos confirmados` }, findings };
  },
};
