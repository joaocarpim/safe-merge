import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forbiddenFileFindings, hygieneFindings } from '../src/checks/hygiene.ts';
import { riskFindings } from '../src/checks/risk.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { finalizeFindings } from '../src/findings.ts';

const L = (file: string, ...texts: string[]) => texts.map((text, i) => ({ file, line: i + 1, text }));
const rules = (f: Array<{ rule: string }>) => f.map((x) => x.rule).sort();

/** Monta um diff unificado com contexto: linhas com "+" são novas, as outras são contexto. */
function diff(file: string, lines: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +1,${lines.length} @@`, ...lines.map((l) => (l.startsWith('+') ? l : ` ${l}`))].join('\n');
}

describe('higiene do código novo', () => {
  it('acha depuração, SQL concatenado, TLS desligado, comparação insegura, URL local e any', () => {
    const got = hygieneFindings(
      L(
        'src/pagamento.ts',
        'console.log("pedido", pedido);',
        'const r = await db.query("SELECT * FROM pedido WHERE id = " + id);',
        'const agent = new https.Agent({ rejectUnauthorized: false });',
        'if (signature === req.headers["x-sig"]) ok();',
        'const api = "http://localhost:3000/pix";',
        'function f(x: any) {}',
        '// TODO: tratar estorno',
      ),
    );
    assert.deepEqual(rules(got), ['debug-leftover', 'hardcoded-local-url', 'new-todo', 'sql-concat', 'tls-or-auth-disabled', 'type-escape', 'unsafe-secret-compare']);
  });

  it('respeita onde cada regra vale: console.log em teste e .only fora de teste não contam', () => {
    assert.deepEqual(rules(hygieneFindings(L('test/pagamento.test.ts', 'console.log(x)', 'it.only("cobra", () => {})'))), ['focused-or-skipped-test']);
    assert.deepEqual(hygieneFindings(L('src/a.ts', 'it.only("x")')), []);
    assert.deepEqual(hygieneFindings(L('docs/guia.md', 'Título', '=======')), [], 'sublinhado de título em Markdown não é marcador de conflito');
    assert.deepEqual(rules(hygieneFindings(L('src/a.ts', '<<<<<<< HEAD'))), ['conflict-marker']);
  });

  it('SQL parametrizado não é acusado', () => {
    assert.deepEqual(hygieneFindings(L('src/a.ts', 'db.query("SELECT * FROM pedido WHERE id = $1", [id]);', 'prisma.$queryRaw`SELECT 1`;')), []);
  });

  it('marcador de conflito e SQL concatenado bloqueiam; o resto avisa', () => {
    const f = finalizeFindings(hygieneFindings(L('src/a.ts', '>>>>>>> dev', 'cursor.execute(f"SELECT * FROM t WHERE id={id}")', 'console.log(1)')), DEFAULT_CONFIG.security);
    const level = Object.fromEntries(f.map((x) => [x.rule, x.level]));
    assert.deepEqual(level, { 'conflict-marker': 'block', 'sql-concat': 'block', 'debug-leftover': 'warn' });
  });

  it('arquivo proibido commitado bloqueia (.env, chave, credencial)', () => {
    const f = finalizeFindings(forbiddenFileFindings(['.env', 'certs/server.pem', 'src/a.ts', 'config/credentials.json', '.env.example']), DEFAULT_CONFIG.security);
    assert.deepEqual(f.map((x) => x.file).sort(), ['.env', 'certs/server.pem', 'config/credentials.json']);
    assert.ok(f.every((x) => x.level === 'block'));
  });
});

describe('riscos de produção', () => {
  it('N+1: consulta dentro de laço (também quando o laço já existia)', () => {
    const got = riskFindings(diff('src/services/os.ts', ['for (const os of ordens) {', '+  const cliente = await prisma.cliente.findUnique({ where: { id: os.clienteId } });', '}']));
    assert.deepEqual(rules(got), ['query-in-loop']);
    assert.equal(got[0]!.line, 2);
    assert.deepEqual(riskFindings(diff('src/jobs/recalcular.ts', ['for (const o of x) {', '+  await prisma.os.update({ where: { id: o.id }, data: {} });', '}'])), [], 'job faz de propósito');
  });

  it('HTTP sem timeout; com timeout não acusa', () => {
    assert.deepEqual(rules(riskFindings(diff('src/pix.ts', ['+const r = await fetch(url, { method: "POST" });']))), ['http-without-timeout']);
    assert.deepEqual(riskFindings(diff('src/pix.ts', ['+const r = await fetch(url, { signal: AbortSignal.timeout(5000) });'])), []);
    assert.deepEqual(rules(riskFindings(diff('app/pix.py', ['+r = requests.post(url, json=payload)']))), ['http-without-timeout']);
  });

  it('exceção engolida (JS e Python)', () => {
    assert.deepEqual(rules(riskFindings(diff('src/a.ts', ['+try {', '+  await cobrar();', '+} catch (e) {', '+}']))), ['swallowed-exception']);
    assert.deepEqual(rules(riskFindings(diff('app/a.py', ['+try:', '+    cobrar()', '+except Exception:', '+    pass']))), ['swallowed-exception']);
    assert.deepEqual(riskFindings(diff('src/a.ts', ['+try {', '+  await cobrar();', '+} catch (e) {', '+  logger.error(e);', '+}'])), []);
  });

  it('contador sem lock e idempotência sem reserva', () => {
    assert.deepEqual(rules(riskFindings(diff('src/orcamento.ts', ['+const numero = ultimo.numero + 1;']))), ['counter-without-lock']);
    assert.deepEqual(
      rules(riskFindings(diff('src/cobranca.ts', ['+const existe = await repo.findByIdempotencyKey(chave);', '+if (!existe) await pixClient.createCharge(dados);']))),
      ['idempotency-race'],
    );
  });

  it('migração destrutiva e sem volta; reformatação em massa', () => {
    assert.deepEqual(rules(riskFindings(diff('prisma/migrations/2026_x/migration.sql', ['+ALTER TABLE "Cliente" DROP COLUMN "cpf";']))), ['destructive-migration']);
    const fmt = ['a', 'b', 'c'].map((n) => [`diff --git a/src/${n}.ts b/src/${n}.ts`, `--- a/src/${n}.ts`, `+++ b/src/${n}.ts`, '@@ -1 +1 @@', '-const x={a:1}', '+const x = { a: 1 }'].join('\n')).join('\n');
    assert.deepEqual(rules(riskFindings(fmt)), ['formatting-churn']);
  });

  it('código de teste não entra nos riscos', () => {
    assert.deepEqual(riskFindings(diff('test/pix.test.ts', ['+const r = await fetch(url);'])), []);
  });
});

describe('SQL concatenado com aspas de outro tipo dentro da string', () => {
  it('pega o formato do Prisma com Postgres (aspas duplas dentro de aspas simples)', () => {
    assert.deepEqual(rules(hygieneFindings(L('src/a.js', `prisma.$queryRawUnsafe('SELECT * FROM "OrdemServico" WHERE "tenantId" = ' + tenantId);`))), ['sql-concat']);
    assert.deepEqual(rules(hygieneFindings(L('src/a.js', `db.query("SELECT * FROM t WHERE nome = '" + nome + "'");`))), ['sql-concat']);
    assert.deepEqual(hygieneFindings(L('src/a.js', `prisma.$queryRawUnsafe('SELECT * FROM "T" WHERE id = $1', id);`)), []);
  });
});
