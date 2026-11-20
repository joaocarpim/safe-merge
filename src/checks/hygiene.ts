import { addedLines, touchedFiles, type AddedLine } from '../diff.js';
import { clip, type Confidence, type FindingDraft, type Severity } from '../findings.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|py|go|rb|php|java|kt|cs|dart|rs)$/;
export const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$|(^|\/)src\/test\/|(Test|Tests|IT)\.(java|kt)$|(^|\/)conftest\.py$/i;
const SCRIPT_FILE = /(^|\/)(scripts?|bin|tools|seeds?|seeders|migrations?)\//;

interface Rule {
  id: string;
  title: string;
  message: string;
  re: RegExp;
  severity: Severity;
  confidence: Confidence;
  /** Onde a regra vale: código de produção (padrão), só testes, ou qualquer arquivo de código. */
  where?: 'prod' | 'test' | 'any' | 'all-files';
}

/**
 * Higiene do código novo: o que um revisor atento pega no diff. Só linhas acrescentadas, com a linha
 * como evidência. Cada regra diz onde vale (código de produção, testes, qualquer arquivo).
 */
export const HYGIENE_RULES: Rule[] = [
  {
    id: 'conflict-marker',
    title: 'Marcador de conflito commitado',
    message: 'A linha é um marcador de conflito (<<<<<<<, ======= ou >>>>>>>) que entrou no commit: o arquivo não compila ou faz outra coisa.',
    re: /^(<{7}|>{7})( |$)|^={7}$/,
    severity: 'high',
    confidence: 'high',
    where: 'all-files',
  },
  {
    id: 'sql-concat',
    title: 'SQL montado com concatenação ou interpolação',
    message: 'A consulta junta texto e variável na mão: risco de SQL injection. Use parâmetros ($1, ?, :nome) ou o query builder.',
    // a string pode ter aspas de outro tipo dentro ('… "Tabela" …'): a aspa que fecha é a mesma que abriu
    re: /(execute|executemany|raw|query|createQuery|createNativeQuery|\$queryRawUnsafe|\$executeRawUnsafe|jdbcTemplate\.(query|update|execute))\s*\(\s*(f["']|(["'`])(?:(?!\4).)*\b(select|insert|update|delete|where|from)\b(?:(?!\4).)*\4\s*(\+|%(?!s)|\.format\()|`[^`]*\b(select|insert|update|delete|where|from)\b[^`]*\$\{|\w+\s*\+\s*["']\s*\b(and|or|where)\b|String\.format\()|\$(queryRawUnsafe|executeRawUnsafe)\s*\(.*(\+|\$\{)/i,
    severity: 'high',
    confidence: 'medium',
  },
  {
    id: 'tls-or-auth-disabled',
    title: 'Verificação de TLS ou de autenticação desligada',
    message: 'O código desliga uma proteção (certificado TLS, CSRF ou permissão). Em produção isso abre a porta para ataque; se for só para desenvolvimento, isole por ambiente.',
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=?\s*["']?0|verify\s*=\s*False|@csrf_exempt|\bcsrf_exempt\b|permission_classes\s*=\s*\[\s*AllowAny|InsecureSkipVerify\s*:\s*true|cors\(\s*\{[^}]*origin\s*:\s*["']\*["']/,
    severity: 'medium',
    confidence: 'high',
  },
  {
    id: 'unsafe-secret-compare',
    title: 'Comparação de segredo com ==',
    message: 'Comparar assinatura/token com == vaza informação pelo tempo de resposta. Use comparação de tempo constante (crypto.timingSafeEqual, hmac.compare_digest, MessageDigest.isEqual).',
    re: /\b\w*(signature|hmac|token|secret|digest)\w*\s*(===?|!==?)\s*\w/i,
    severity: 'medium',
    confidence: 'medium',
  },
  {
    id: 'debug-leftover',
    title: 'Código de depuração esquecido',
    message: 'Saída ou parada de depuração em código de produção. Use o logger do projeto ou remova.',
    re: /(?<![\w.])(console\.(log|debug|dir|trace)\s*\(|debugger\s*;|pdb\.set_trace\(|breakpoint\(\)|binding\.pry\b|System\.(out|err)\.print\w*\(|\.printStackTrace\(\)|var_dump\(|dd\()/,
    severity: 'low',
    confidence: 'high',
  },
  {
    id: 'focused-or-skipped-test',
    title: 'Teste focado ou pulado',
    message: '.only faz a suíte rodar só este teste (os outros deixam de rodar no CI); .skip desliga um teste sem explicação.',
    re: /\b(describe|it|test|context)\.(only|skip)\s*\(|\bf(it|describe)\s*\(|@pytest\.mark\.skip\b|@Disabled\b|@Ignore\b/,
    severity: 'medium',
    confidence: 'high',
    where: 'test',
  },
  {
    id: 'hardcoded-local-url',
    title: 'URL local ou IP fixo no código',
    message: 'Endereço de máquina local ou IP fixo vai quebrar em outro ambiente. Leia de configuração/variável de ambiente.',
    re: /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?/,
    severity: 'low',
    confidence: 'high',
  },
  {
    id: 'type-escape',
    title: 'Tipagem desligada (any / @ts-ignore)',
    message: 'any e @ts-ignore desligam o verificador de tipos naquele ponto: erros passam para produção.',
    re: /:\s*any\b|\bas any\b|@ts-(ignore|nocheck)\b|#\s*type:\s*ignore\b/,
    severity: 'low',
    confidence: 'medium',
  },
  {
    id: 'new-todo',
    title: 'Pendência nova no código (TODO/FIXME)',
    message: 'A branch deixa uma pendência registrada no código. Vale um card ou resolver antes do merge.',
    re: /(?<![A-Za-z])(TODO|FIXME|XXX|HACK)(?![A-Za-z])/,
    severity: 'info',
    confidence: 'high',
    where: 'any',
  },
];

const FORBIDDEN_FILES: Array<[RegExp, string]> = [
  [/(^|\/)\.env$|(^|\/)\.env\.(local|production|prod|staging)$/, 'arquivo .env com configuração real'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/, 'chave ou certificado'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, 'chave SSH privada'],
  [/(^|\/)(credentials|service[-_]?account[^/]*|firebase-adminsdk[^/]*)\.json$/, 'credencial de nuvem'],
  [/(^|\/)\.npmrc$|(^|\/)\.pypirc$|(^|\/)\.netrc$/, 'arquivo com token de registro'],
];

function applies(rule: Rule, file: string): boolean {
  const isTest = TEST_FILE.test(file);
  switch (rule.where ?? 'prod') {
    case 'all-files':
      // texto (Markdown etc.) usa ======= como sublinhado de título
      return !/\.(md|markdown|rst|adoc|txt)$/i.test(file);
    case 'test':
      return isTest && CODE_FILE.test(file);
    case 'any':
      return CODE_FILE.test(file);
    default:
      return CODE_FILE.test(file) && !isTest && !SCRIPT_FILE.test(file);
  }
}

/** Achados de higiene nas linhas acrescentadas (no máximo `perFile` por regra e arquivo). */
export function hygieneFindings(lines: AddedLine[], perFile = 3): FindingDraft[] {
  const out: FindingDraft[] = [];
  const count = new Map<string, number>();
  for (const l of lines) {
    if (/\.(min\.js|map|lock)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(l.file)) continue;
    for (const rule of HYGIENE_RULES) {
      if (!applies(rule, l.file) || !rule.re.test(l.text)) continue;
      const key = `${rule.id}:${l.file}`;
      const n = count.get(key) ?? 0;
      if (n >= perFile) continue;
      count.set(key, n + 1);
      out.push({ category: 'hygiene', rule: rule.id, title: rule.title, message: rule.message, severity: rule.severity, confidence: rule.confidence, file: l.file, line: l.line, evidence: clip(l.text), source: 'safemerge' });
    }
  }
  return out;
}

export function forbiddenFileFindings(files: string[]): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const f of files) {
    const hit = FORBIDDEN_FILES.find(([re]) => re.test(f));
    if (!hit) continue;
    out.push({
      category: 'secret',
      rule: 'forbidden-file',
      title: `Arquivo que não deveria ir para o repositório: ${hit[1]}`,
      message: `${f} entrou na branch. Mesmo apagado depois, fica no histórico: remova do histórico, revogue o que houver nele e coloque no .gitignore.`,
      severity: 'high',
      confidence: 'high',
      file: f,
      line: 1,
      evidence: `arquivo adicionado: ${f}`,
      source: 'safemerge',
    });
  }
  return out;
}

export const hygieneCheck: Check = {
  id: 'hygiene',
  label: 'Higiene do código novo (depuração, SQL, TLS, testes focados, arquivos proibidos)',
  run(ctx: CheckContext): CheckOutput {
    const lines = addedLines(ctx.cwd, ctx.mergeBase, ctx.headRef);
    const files = touchedFiles(ctx.cwd, ctx.mergeBase, ctx.headRef);
    const findings = [...forbiddenFileFindings(files), ...hygieneFindings(lines)];
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason: `${HYGIENE_RULES.length} regras nas linhas novas + arquivos proibidos` }, findings };
  },
};
