import { clip, type Confidence, type FindingDraft, type Severity } from '../findings.js';
import { git } from '../git.js';
import { TEST_FILE } from './hygiene.js';
import { GENERATED, isCommentLine } from './paths.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

/**
 * Riscos clássicos de produção no código que a branch acrescenta: o que um revisor sênior olha antes de
 * liberar (N+1, HTTP sem timeout, exceção engolida, contador sem lock, idempotência, transação longa,
 * SQL destrutivo, migração irreversível, reformatação em massa). Heurísticas por texto, com a linha como
 * evidência e confiança que avisa sem bloquear (exceto onde o padrão é inequívoco).
 */

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|py|go|rb|php|java|kt|cs|dart)$/;
const MIGRATION = /(^|\/)(migrations?|db\/migrate|db\/migration|prisma\/migrations|supabase\/migrations)\/|\.sql$/;
const BATCH_PATH = /(^|\/)(tasks?|jobs?|workers?|scripts?|seeds?|seeders|commands?|management\/commands)\/|(Job|Scheduler|Seeder)\.(java|kt|ts|js)$/;

const LOOP = /^(\s*)(for\b|while\b|.*\.forEach\s*\(|.*\.map\s*\(\s*(async\s*)?\(?)/;
// chamadas de banco comuns a qualquer linguagem (cliente, repositório, SQL cru)
const QUERY_COMMON = /cursor\.execute|\b(prisma|db|tx|knex|repository|repo|entityManager|em|jdbcTemplate|queryRunner|manager|session)\s*\.\s*(\w+\s*\.\s*)?(find\w*|findUnique|findFirst|save\w*|delete\w*|update\w*|insert\w*|count|exists\w*|query\w*|create\w*|upsert|persist|merge|remove|get)\s*\(|\$queryRaw|createQuery\(|SELECT\s.+\sFROM\s/i;
// ORM de Python/Ruby: .filter() e .count() só são banco nessas linguagens (em JS/TS são métodos de array)
const QUERY_ORM = /\.objects\b|\.(filter|exclude|aggregate)\(|\.(save|delete|count|exists)\(\)|\.(update_or_create|get_or_create|bulk_create|bulk_update)\(/;
const LOCK = /select_for_update|with_for_update|FOR UPDATE|advisory_lock|@Lock\(|PESSIMISTIC_|@Version\b|synchronized|ReentrantLock|Mutex|redlock|\.acquire\(|\$transaction\(.*isolationLevel|SERIALIZABLE/i;
const HTTP = /\b(requests|httpx|session|client)\.(get|post|put|patch|delete|request)\(|urlopen\(|\baxios(\.(get|post|put|patch|delete|request))?\s*\(|(?<![\w.])fetch\s*\(|restTemplate\.(getFor\w+|postFor\w+|put|delete|exchange|execute)\s*\(|webClient\s*\.\s*(get|post|put|patch|delete|method)\s*\(|http\.(Get|Post|NewRequest)\(|\.newCall\s*\(/;
const TIMEOUT = /timeout|Timeout|deadline|AbortSignal|AbortController|signal\s*:|context\.WithTimeout|responseTimeout|connectTimeout|readTimeout/;
const CATCH = /^\s*\}?\s*(except\b[^:]*:|catch\s*(\([^)]*\))?\s*\{?|rescue\b.*)\s*$/;
// engolir = não fazer nada. `return`/comentário depois do catch é tratamento (ou vem o tratamento depois do comentário)
const SWALLOW = /^\s*(pass|continue|\.\.\.|\})\s*$/;
// próximo número calculado a partir de outro registro (ultimo.numero + 1). `i += 1` de laço local não conta.
const COUNTER = /\b(version|versao|numero|number|sequence|seq)\w*\s*=\s*[\w[\]"']+\.[\w.[\]"']+\s*\+\s*1|aggregate\([^)]*Max\(|Max\(\s*["']?(version|numero|number|sequence)/i;
const IDEMP = /idempot/i;
const EXTERNAL_WRITE = /(gateway|client|api|http|provider|sdk|service|processor|stripe|psp|pix|mercadopago|asaas)\w*\.\w*(pay|charge|capture|transfer|payout|refund|create|send|post|execute|cobr)\w*\s*\(/i;
const TX = /transaction\.atomic|@Transactional|\$transaction\(|\.transaction\(|beginTransaction\(|BEGIN\b/;
const HEAVY_IO = /readFileSync|\.read\(\)|open\(|requests\.|httpx\.|axios\.|fetch\(|restTemplate\.|webClient\.|HttpClient|urlopen\(|sleep\(/;
const LIST_FIELD = /(?<![\w])(ListField|ArrayField|ListSerializer)\(|z\.array\(|@RequestBody\s+List<|Joi\.array\(|t\.array\(/;
const LIST_BOUND = /max_length|max_items|max_num|maxItems|@Size\(|@ArrayMaxSize|\.max\(\s*\d|\.length\(\s*\d/;
// TRUNCATE só em maiúsculas: "truncate" minúsculo é a classe CSS do Tailwind
const DESTRUCTIVE_CI = /\bDROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b|\bDELETE\s+FROM\s+\w+\s*;?\s*$/i;
const DESTRUCTIVE_CS = /\.objects\.all\(\)\.delete\(\)|\bdeleteMany\(\s*\)|\bTRUNCATE\s+\w+\s*;?\s*$/;
const DESTRUCTIVE = { test: (s: string) => DESTRUCTIVE_CI.test(s) || DESTRUCTIVE_CS.test(s) };
const IRREVERSIBLE = /RunPython\([^,)]+\)\s*$|reverse_code\s*=\s*None|irreversible|raise\s+(ActiveRecord::)?IrreversibleMigration/;

interface Row {
  kind: '+' | ' ';
  line: number;
  text: string;
}

/** Diff com contexto, por arquivo: linhas acrescentadas e de contexto, com a linha na versão nova. */
export function parseRows(diff: string): Map<string, { rows: Row[]; added: string; removed: string }> {
  const files = new Map<string, { rows: Row[]; added: string; removed: string }>();
  let cur: { rows: Row[]; added: string; removed: string } | null = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l.startsWith('+++ ')) {
      const p = l.slice(4);
      cur = p === '/dev/null' ? null : { rows: [], added: '', removed: '' };
      if (cur) files.set(p.replace(/^b\//, ''), cur);
      continue;
    }
    if (l.startsWith('--- ') || l.startsWith('diff --git') || l.startsWith('index ')) continue;
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('+')) {
      cur.rows.push({ kind: '+', line, text: l.slice(1) });
      cur.added += `${l.slice(1)}\n`;
      line++;
    } else if (l.startsWith('-')) {
      cur.removed += `${l.slice(1)}\n`;
    } else if (l.startsWith(' ')) {
      cur.rows.push({ kind: ' ', line, text: l.slice(1) });
      line++;
    }
  }
  return files;
}

type Add = (rule: string, title: string, message: string, severity: Severity, confidence: Confidence, row: Row) => void;

function fileRisks(path: string, f: { rows: Row[]; added: string; removed: string }, add: Add): void {
  const added = f.rows.filter((r) => r.kind === '+' && !isCommentLine(r.text));
  const migration = MIGRATION.test(path);

  if (migration) {
    for (const r of added) {
      if (DESTRUCTIVE.test(r.text)) add('destructive-migration', 'Migração destrutiva', 'A migração apaga tabela, coluna ou dados. Confirme backup e a ordem do deploy (código novo antes de remover a coluna, por exemplo).', 'medium', 'high', r);
      if (IRREVERSIBLE.test(r.text)) add('irreversible-migration', 'Migração sem volta', 'A migração não tem como ser desfeita (sem reverse/down). Se o deploy der errado, não há rollback automático.', 'low', 'high', r);
    }
    return;
  }
  if (!CODE_FILE.test(path) || TEST_FILE.test(path) || GENERATED.test(path)) return;
  const QUERY = /\.(py|rb)$/.test(path) ? new RegExp(`${QUERY_COMMON.source}|${QUERY_ORM.source}`, 'i') : QUERY_COMMON;
  const hasLock = LOCK.test(f.added);

  // contador/versão calculado sem lock
  if (!hasLock) {
    const r = added.find((x) => COUNTER.test(x.text));
    if (r) add('counter-without-lock', 'Contador ou versão calculado sem lock', 'Ler o maior número e somar 1 sem lock: duas requisições simultâneas geram o mesmo número (unique estoura ou dado duplica). Use sequence do banco, SELECT … FOR UPDATE ou update atômico.', 'medium', 'medium', r);
  }

  // idempotência conferida sem reservar a chave antes da chamada externa
  if (IDEMP.test(f.added) && EXTERNAL_WRITE.test(f.added) && !hasLock && !/\.(tsx|jsx|dart|vue|svelte)$/.test(path)) {
    const r = added.find((x) => EXTERNAL_WRITE.test(x.text));
    if (r) add('idempotency-race', 'Idempotência sem reservar a chave antes da chamada externa', 'A chave de idempotência é conferida, mas não é reservada (lock/insert único) antes de chamar o provedor: dois envios simultâneos executam a cobrança/pagamento duas vezes.', 'high', 'low', r);
  }

  // N+1: consulta dentro de laço (jobs e scripts fazem de propósito)
  if (!BATCH_PATH.test(path)) {
    let loopIndent: number | null = null;
    for (const r of f.rows) {
      const t = r.text.replace(/\s+$/, '');
      if (!t.trim()) continue;
      const indent = t.length - t.trimStart().length;
      if (loopIndent !== null && indent <= loopIndent && !/^\s*[}\])]/.test(t)) loopIndent = null;
      const m = t.match(LOOP);
      if (m && loopIndent === null) {
        loopIndent = indent;
        continue;
      }
      if (loopIndent !== null && r.kind === '+' && indent > loopIndent && QUERY.test(t) && !LOCK.test(t)) {
        add('query-in-loop', 'Consulta ao banco dentro de laço (N+1)', 'Uma ida ao banco por item do laço: com mil itens, mil consultas. Busque tudo de uma vez (IN, include/select_related, createMany/bulk).', 'medium', 'medium', r);
        break;
      }
    }
  }

  // transação com lock segurando IO pesado
  if (TX.test(f.added) && hasLock && HEAVY_IO.test(f.added)) {
    const r = added.find((x) => TX.test(x.text));
    if (r) add('long-transaction', 'Transação com lock segurando I/O', 'A transação trava linhas e, dentro dela, faz chamada HTTP/arquivo/espera: a linha fica presa por segundos e outras requisições enfileiram. Faça o trabalho lento fora da transação.', 'medium', 'medium', r);
  }

  // HTTP sem timeout
  for (const r of added) {
    if (!HTTP.test(r.text) || TIMEOUT.test(r.text)) continue;
    const i = f.added.indexOf(r.text);
    if (TIMEOUT.test(f.added.slice(i, i + 400))) continue;
    add('http-without-timeout', 'Chamada HTTP sem timeout', 'Se o serviço do outro lado travar, esta requisição (e o worker) fica presa até cair. Defina timeout (AbortSignal.timeout, timeout=, connectTimeout).', 'medium', 'medium', r);
    break;
  }

  // exceção engolida
  for (let i = 0; i < f.rows.length - 1; i++) {
    const r = f.rows[i]!;
    if (!CATCH.test(r.text)) continue;
    const next = f.rows.slice(i + 1).find((x) => x.text.trim() !== '' && !isCommentLine(x.text));
    if (next && next.kind === '+' && SWALLOW.test(next.text) && (r.kind === '+' || next.kind === '+')) {
      add('swallowed-exception', 'Exceção capturada e descartada', 'O erro é capturado e ignorado: a falha some sem log nem reação, e o problema aparece longe da causa.', 'medium', 'medium', r.kind === '+' ? r : next);
      break;
    }
  }

  // lista de entrada sem limite
  if (/serializer|schema|dto|request|payload|validator|validation/i.test(path)) {
    const r = added.find((x) => LIST_FIELD.test(x.text) && !LIST_BOUND.test(x.text));
    if (r) add('unbounded-list', 'Lista de entrada sem limite de tamanho', 'Se esta lista é de ENTRADA, um payload com milhares de itens vira milhares de linhas/consultas: defina um máximo (max_length, .max(n), @Size). Em serializer de saída não precisa.', 'low', 'low', r);
  }

  // SQL destrutivo fora de migração
  const d = added.find((x) => DESTRUCTIVE.test(x.text));
  if (d) add('destructive-sql', 'Comando destrutivo no código', 'DROP/TRUNCATE/delete sem filtro no código da aplicação. Confirme que é intencional e que tem filtro e proteção.', 'medium', 'medium', d);
}

/** Arquivos só reformatados (conteúdo igual ignorando espaços) misturados com a mudança real. */
export function churnFiles(files: Map<string, { added: string; removed: string }>): string[] {
  return [...files.entries()]
    .filter(([p, f]) => CODE_FILE.test(p) && f.added && f.removed && f.added.replace(/\s+/g, '') === f.removed.replace(/\s+/g, ''))
    .map(([p]) => p)
    .sort();
}

export function riskFindings(diff: string, churnThreshold = 3): FindingDraft[] {
  const files = parseRows(diff);
  const churn = new Set(churnFiles(files));
  const out: FindingDraft[] = [];
  for (const [path, f] of files) {
    if (churn.has(path)) continue;
    fileRisks(path, f, (rule, title, message, severity, confidence, row) =>
      out.push({ category: 'risk', rule, title, message, severity, confidence, file: path, line: row.line, evidence: clip(row.text), source: 'safemerge' }),
    );
  }
  if (churn.size >= churnThreshold) {
    const list = [...churn];
    out.push({
      category: 'risk',
      rule: 'formatting-churn',
      title: 'Reformatação em massa misturada com a mudança',
      message: `${list.length} arquivo(s) só reformatados, sem mudança de comportamento: ${list.slice(0, 4).join(', ')}${list.length > 4 ? '…' : ''}. Separe em outro PR: isso esconde a mudança real no meio do diff e aumenta conflito com outras branches.`,
      severity: list.length >= 10 ? 'medium' : 'low',
      confidence: 'high',
      file: list[0]!,
      line: 1,
      evidence: `${list.length} arquivo(s) com conteúdo igual ignorando espaços`,
      source: 'safemerge',
    });
  }
  return out;
}

export const riskCheck: Check = {
  id: 'risk',
  label: 'Riscos de produção (N+1, HTTP sem timeout, exceção engolida, lock, idempotência, migração destrutiva)',
  run(ctx: CheckContext): CheckOutput {
    const res = git(ctx.cwd, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U6', '--no-renames', ctx.mergeBase, ctx.headRef]);
    if (res.code !== 0) return { coverage: { check: this.id, label: this.label, status: 'error', reason: res.stderr.trim().split('\n')[0] }, findings: [] };
    const findings = riskFindings(res.stdout);
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason: 'heurísticas por texto (JS/TS, Python, Java/Kotlin, Go, Ruby, PHP, Dart)' }, findings };
  },
};
