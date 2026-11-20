import { compileRegexes } from '../config.js';
import { addedLines, showFile, type AddedLine } from '../diff.js';
import { clip, type FindingDraft } from '../findings.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|py|go|rb|php|java|kt|cs)$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.(go|py|rb)$/i;

// ─── LGPD: dado pessoal em log ───────────────────────────────────────────────────────────────────

const LOG_CALL = /\b(console\.(log|info|warn|error|debug)|logger\.\w+|log\.(info|warn|error|debug|trace)|logging\.\w+|print|println|System\.out\.print\w*|fmt\.Print\w*|Log\.\w+|puts|error_log|var_dump)\s*\(/;
const PII = /\b(cpf|cnpj|rg|email|e_?mail|telefone|celular|phone|whatsapp|endereco|address|cep|data_?nascimento|birth_?date|senha|password|passwd|cartao|card_?number|cvv)\b/i;

/** Linha que manda dado pessoal para log (por nome do campo/variável). Ignora strings fixas sem variável. */
export function piiInLog(text: string): string | null {
  if (!LOG_CALL.test(text)) return null;
  const call = text.slice(text.search(LOG_CALL));
  // remove o texto entre aspas: "e-mail enviado" não é dado pessoal, `user.email` é
  const code = call.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""').replace(/`[^`$]*`/g, '``');
  const m = code.match(PII);
  return m ? m[1]!.toLowerCase() : null;
}

// ─── rota nova sem autenticação ──────────────────────────────────────────────────────────────────

const ROUTE = [
  /\b(app|router|server|api|route)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/, // Express/Fastify/Koa
  /@(app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/, // FastAPI/Flask
  /^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/, // Next.js app router
];

export interface RouteHit {
  method: string;
  path: string;
}

export function routeOf(text: string): RouteHit | null {
  for (const re of ROUTE) {
    const m = text.match(re);
    if (!m) continue;
    if (m.length === 2) return { method: m[1]!, path: '(arquivo)' };
    return { method: m[2]!.toUpperCase(), path: m[3]! };
  }
  return null;
}

// ─── consulta sem filtro de tenant ───────────────────────────────────────────────────────────────

const PRISMA = /\b(?:prisma|db|tx)\.(\w+)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|update|updateMany|delete|deleteMany|count|aggregate|groupBy|upsert)\s*\(/;
const SQL_TABLE = /\b(?:from|update|into|join)\s+["`]?(\w+)["`]?/i;
const ORM_MODEL = /\b(\w+)\.(objects\.(?:filter|all|get|exclude)|query\.(?:filter|all|get)|where|findAll|findOne|findByPk|find)\s*\(/;

/** Junta a linha com as seguintes (até fechar parênteses ou 12 linhas) para ver o filtro completo. */
function statementFrom(lines: AddedLine[], i: number): string {
  let text = '';
  let depth = 0;
  for (let j = i; j < Math.min(lines.length, i + 12); j++) {
    if (j > i && (lines[j]!.file !== lines[i]!.file || lines[j]!.line !== lines[j - 1]!.line + 1)) break;
    text += `${lines[j]!.text}\n`;
    for (const ch of lines[j]!.text) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth <= 0 && j > i) break;
    if (depth <= 0 && /\)\s*;?\s*$/.test(lines[j]!.text)) break;
  }
  return text;
}

export function tenantQueryModel(lines: AddedLine[], i: number, models: Set<string>): string | null {
  const t = lines[i]!.text;
  const m = t.match(PRISMA) ?? t.match(ORM_MODEL);
  const name = m?.[1] ?? (/\b(select|update|delete|insert)\b/i.test(t) ? t.match(SQL_TABLE)?.[1] : undefined);
  if (!name) return null;
  const hit = [...models].find((x) => x.toLowerCase() === name.toLowerCase() || `${x.toLowerCase()}s` === name.toLowerCase());
  return hit ?? null;
}

/**
 * Regras de domínio para SaaS no Brasil (multi-tenant, LGPD). Heurísticas por nome sobre as linhas
 * que a branch acrescenta: sempre com evidência, e com confiança que não bloqueia por padrão.
 */
export const domainCheck: Check = {
  id: 'domain',
  label: 'Regras de domínio (tenant, LGPD, rota sem autenticação)',
  run(ctx: CheckContext): CheckOutput {
    const d = ctx.cfg.domain;
    const lines = addedLines(ctx.cwd, ctx.mergeBase, ctx.headRef).filter((l) => CODE_FILE.test(l.file) && !TEST_FILE.test(l.file));
    if (lines.length === 0) {
      return { coverage: { check: this.id, label: this.label, status: 'skipped', reason: 'nenhuma linha de código nova fora de testes' }, findings: [] };
    }
    const findings: FindingDraft[] = [];
    const publicRoutes = compileRegexes(d.publicRoutes);
    const authRe = new RegExp(`(${d.authMarkers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
    const models = new Set(d.tenantModels);
    const tenantRe = new RegExp(`\\b(${d.tenantFields.join('|')})\\b`, 'i');
    const fileCache = new Map<string, string>();
    const fileText = (f: string) => {
      if (!fileCache.has(f)) fileCache.set(f, showFile(ctx.cwd, ctx.headRef, f) ?? '');
      return fileCache.get(f)!;
    };

    lines.forEach((l, i) => {
      const pii = piiInLog(l.text);
      if (pii) {
        findings.push({
          category: 'lgpd',
          rule: 'pii-in-log',
          title: `Dado pessoal em log (${pii})`,
          message: `A linha manda "${pii}" para um log. Pela LGPD, log não deve guardar dado pessoal: use um id interno ou mascare (ex.: ***.456.789-**).`,
          severity: 'medium',
          confidence: 'medium',
          file: l.file,
          line: l.line,
          evidence: clip(l.text),
          source: 'safemerge',
        });
      }

      const route = routeOf(l.text);
      if (route && !publicRoutes.some((re) => re.test(route.path))) {
        // middleware na própria linha, ou no arquivo (router.use(auth), Depends(...), getServerSession...)
        const inLine = authRe.test(l.text);
        const inFile = authRe.test(fileText(l.file));
        if (!inLine && !inFile) {
          findings.push({
            category: 'auth',
            rule: 'route-without-auth',
            title: `Rota nova sem autenticação: ${route.method} ${route.path}`,
            message: `Nem a linha nem o arquivo citam autenticação (${d.authMarkers.slice(0, 4).join(', ')}…). Se a rota é pública de propósito (webhook, health), inclua em domain.publicRoutes.`,
            severity: 'medium',
            confidence: 'low',
            file: l.file,
            line: l.line,
            evidence: clip(l.text),
            source: 'safemerge',
          });
        }
      }

      if (models.size > 0) {
        const model = tenantQueryModel(lines, i, models);
        if (model && !tenantRe.test(statementFrom(lines, i))) {
          findings.push({
            category: 'tenant',
            rule: 'query-without-tenant',
            title: `Consulta a ${model} sem filtro de tenant`,
            message: `${model} pertence a um tenant, e a consulta não cita ${d.tenantFields.join(' / ')}. Sem esse filtro, uma empresa pode ver ou alterar dados de outra.`,
            severity: 'high',
            confidence: 'low',
            file: l.file,
            line: l.line,
            evidence: clip(l.text),
            source: 'safemerge',
          });
        }
      }
    });

    const notes = [
      models.size === 0 ? 'filtro de tenant não verificado: configure domain.tenantModels' : `${models.size} modelo(s) com tenant`,
      'heurística por nome',
    ];
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason: notes.join('; ') }, findings };
  },
};
