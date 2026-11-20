import { parseAddedLines } from '../diff.js';
import { clip, type Confidence, type FindingDraft, type Severity } from '../findings.js';
import { git } from '../git.js';

/**
 * Regras internas usadas quando a ferramenta especializada não está instalada. Cobrem os casos mais
 * comuns e de formato inconfundível; a cobertura fica marcada como "parcial", nunca como completa.
 */

// ─── segredos ────────────────────────────────────────────────────────────────────────────────────

interface SecretRule {
  id: string;
  name: string;
  re: RegExp;
  confidence: Confidence;
}

export const SECRET_RULES: SecretRule[] = [
  { id: 'github-token', name: 'token do GitHub', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/, confidence: 'high' },
  { id: 'github-fine-grained', name: 'token do GitHub (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/, confidence: 'high' },
  { id: 'aws-access-key', name: 'chave de acesso da AWS', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, confidence: 'high' },
  { id: 'stripe-live', name: 'chave de produção do Stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, confidence: 'high' },
  { id: 'slack-token', name: 'token do Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, confidence: 'high' },
  { id: 'google-api-key', name: 'chave de API do Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/, confidence: 'high' },
  { id: 'mercadopago-token', name: 'access token do Mercado Pago', re: /\bAPP_USR-\d{10,}-\d{6}-[a-f0-9]{32}-\d+\b/, confidence: 'high' },
  { id: 'asaas-key', name: 'chave de API do Asaas', re: /\$aact_[A-Za-z0-9_=-]{20,}/, confidence: 'high' },
  { id: 'private-key', name: 'chave privada', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/, confidence: 'high' },
  { id: 'npm-token', name: 'token do npm', re: /\bnpm_[A-Za-z0-9]{36}\b/, confidence: 'high' },
  { id: 'sendgrid-key', name: 'chave do SendGrid', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, confidence: 'high' },
  {
    id: 'generic-secret',
    name: 'segredo atribuído no código',
    re: /\b(?:secret|password|passwd|senha|api[_-]?key|access[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s$]{16,}["']/i,
    confidence: 'low',
  },
];

const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.js|.*\.map)$/;

/** Mostra só o começo do segredo: o relatório nunca carrega o valor. */
export function redact(match: string): string {
  return `${match.slice(0, Math.min(6, Math.floor(match.length / 4)))}…(${match.length} caracteres)`;
}

export interface SecretHit {
  rule: SecretRule;
  commit: string;
  file: string;
  line: number;
  redacted: string;
}

/** Procura segredos nas linhas acrescentadas por cada commit de `from..to` (inclusive os apagados depois). */
export function scanSecrets(cwd: string, from: string, to: string): SecretHit[] {
  const res = git(cwd, ['-c', 'core.quotePath=false', 'log', '-p', '--no-color', '--no-ext-diff', '-U0', '--no-renames', '--format=commit %H', `${from}..${to}`], { timeoutMs: 300_000 });
  if (res.code !== 0) return [];
  const hits: SecretHit[] = [];
  const seen = new Set<string>();
  for (const chunk of res.stdout.split(/^commit (?=[0-9a-f]{40}$)/m)) {
    const commit = chunk.slice(0, 40);
    if (!/^[0-9a-f]{40}$/.test(commit)) continue;
    for (const l of parseAddedLines(chunk.slice(41))) {
      if (SKIP_FILE.test(l.file)) continue;
      let specific = false;
      for (const rule of SECRET_RULES) {
        // a regra genérica só vale quando nenhuma específica achou nada na linha
        if (rule.id === 'generic-secret' && specific) continue;
        for (const m of l.text.matchAll(new RegExp(rule.re.source, `${rule.re.flags.replace('g', '')}g`))) {
          if (rule.id !== 'generic-secret') specific = true;
          const key = `${rule.id}:${l.file}:${m[0]}`;
          if (seen.has(key)) continue; // mesmo segredo em vários commits: uma vez só
          seen.add(key);
          hits.push({ rule, commit: commit.slice(0, 7), file: l.file, line: l.line, redacted: redact(m[0]) });
        }
      }
    }
  }
  return hits;
}

export function secretFindings(hits: SecretHit[]): FindingDraft[] {
  return hits.map((h) => ({
    category: 'secret',
    rule: `builtin/${h.rule.id}`,
    title: `Segredo no histórico da branch (${h.rule.name})`,
    message: `Parece um(a) ${h.rule.name}, acrescentado no commit ${h.commit}. Apagar o arquivo não basta: o segredo continua no histórico. Revogue/troque a credencial.`,
    severity: 'high',
    confidence: h.rule.confidence,
    file: h.file,
    line: h.line,
    evidence: `${h.redacted} @${h.commit}`,
    source: 'safemerge (regras internas)',
  }));
}

// ─── workflows do GitHub Actions ─────────────────────────────────────────────────────────────────

const UNTRUSTED = /\$\{\{\s*(github\.event\.(?:issue|pull_request|comment|review|review_comment|discussion|head_commit|commits|pages|workflow_run)[\w.[\]*-]*\.(?:title|body|head\.ref|head\.label|label|message|name|email|default_branch|ref)|github\.head_ref)\s*\}\}/;

/** Regras mínimas para um workflow (quando o zizmor não está instalado). */
export function workflowFindings(file: string, text: string): FindingDraft[] {
  const lines = text.split('\n');
  const out: FindingDraft[] = [];
  const add = (rule: string, title: string, message: string, severity: Severity, confidence: Confidence, line: number) =>
    out.push({ category: 'ci', rule: `builtin/${rule}`, title, message, severity, confidence, file, line, evidence: clip(lines[line - 1] ?? ''), source: 'safemerge (regras internas)' });

  const prt = lines.findIndex((l) => /\bpull_request_target\b/.test(l));
  const checkoutHead = lines.findIndex((l) => /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)\s*\}\}|github\.head_ref/.test(l));
  if (prt >= 0 && checkoutHead >= 0) {
    add(
      'pr-target-checkout',
      'pull_request_target rodando o código do PR',
      'O workflow roda com permissões e segredos do repositório (pull_request_target) e faz checkout do código do PR. Qualquer fork pode executar código com esses segredos. Use pull_request ou não faça checkout do head.',
      'high',
      'high',
      checkoutHead + 1,
    );
  }
  let inRun = false;
  let runIndent = -1;
  lines.forEach((l, i) => {
    const indent = l.length - l.trimStart().length;
    const run = l.match(/^\s*(?:-\s*)?run:\s*(.*)$/);
    if (run) {
      inRun = run[1] === '|' || run[1] === '>' || run[1] === '|-' || run[1] === '>-';
      runIndent = indent;
      if (!inRun && UNTRUSTED.test(run[1]!)) injection(i);
      return;
    }
    if (inRun && l.trim() && indent <= runIndent) inRun = false;
    if (inRun && UNTRUSTED.test(l)) injection(i);
  });
  function injection(i: number) {
    add(
      'template-injection',
      'Texto do PR/issue interpolado num comando do workflow',
      'Um valor controlado por quem abre o PR ou a issue (título, corpo, nome da branch) é colado direto no shell. Um título como "$(curl ... | sh)" executa código. Passe o valor por env: e use "$VAR".',
      prt >= 0 ? 'high' : 'medium',
      'high',
      i + 1,
    );
  }
  const writeAll = lines.findIndex((l) => /^\s*permissions:\s*write-all\b/.test(l));
  if (writeAll >= 0) add('write-all', 'Workflow com permissions: write-all', 'O token do workflow pode escrever em tudo do repositório. Dê só as permissões necessárias.', 'medium', 'high', writeAll + 1);
  return out;
}
