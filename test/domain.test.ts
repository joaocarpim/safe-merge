import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { domainCheck, piiInLog, routeOf, tenantQueryModel } from '../src/checks/domain.ts';
import type { CheckContext } from '../src/checks/types.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { finalizeFindings } from '../src/findings.ts';
import type { ToolRunner } from '../src/tools.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const noTools: ToolRunner = () => ({ missing: true, code: 127, stdout: '', stderr: '', timedOut: false });
const cfg = mergeConfig(DEFAULT_CONFIG, { domain: { tenantModels: ['Orcamento', 'Cliente'] } });

function ctx(): CheckContext {
  return {
    cwd: repo.dir,
    headRef: 'HEAD',
    headSha: repo.git('rev-parse', 'HEAD'),
    target: { name: 'dev', ref: 'refs/heads/dev' },
    mergeBase: repo.git('merge-base', 'HEAD', 'dev'),
    others: [],
    cfg,
    tools: noTools,
  };
}

describe('LGPD: dado pessoal em log', () => {
  it('pega variável com dado pessoal e ignora texto fixo', () => {
    assert.equal(piiInLog('console.log("cliente", cliente.cpf)'), 'cpf');
    assert.equal(piiInLog('logger.info(`enviando para ${user.email}`)'), 'email');
    assert.equal(piiInLog("logging.warning('falha %s', telefone)"), 'telefone');
    assert.equal(piiInLog('console.log("e-mail enviado com sucesso")'), null);
    assert.equal(piiInLog('console.log("CPF inválido")'), null);
    assert.equal(piiInLog('const cpf = limpar(cpf)'), null, 'sem chamada de log');
  });
});

describe('rota sem autenticação', () => {
  it('reconhece rotas de Express, FastAPI e Next.js', () => {
    assert.deepEqual(routeOf("router.post('/orcamentos/:id/aprovar', async (req, res) => {"), { method: 'POST', path: '/orcamentos/:id/aprovar' });
    assert.deepEqual(routeOf('@app.get("/clientes")'), { method: 'GET', path: '/clientes' });
    assert.deepEqual(routeOf('export async function DELETE(req: Request) {'), { method: 'DELETE', path: '(arquivo)' });
    assert.equal(routeOf('const x = router'), null);
  });
});

describe('consulta sem tenant', () => {
  const at = (text: string, ...more: string[]) => [text, ...more].map((t, i) => ({ file: 'a.ts', line: i + 1, text: t }));
  const models = new Set(['Orcamento']);
  it('reconhece Prisma, SQL e ORM pelo nome do modelo', () => {
    assert.equal(tenantQueryModel(at('const o = await prisma.orcamento.findMany({'), 0, models), 'Orcamento');
    assert.equal(tenantQueryModel(at('db.query("select * from orcamentos where id = $1", [id])'), 0, models), 'Orcamento');
    assert.equal(tenantQueryModel(at('Orcamento.objects.filter(status="aberto")'), 0, models), 'Orcamento');
    assert.equal(tenantQueryModel(at('prisma.usuario.findMany()'), 0, models), null);
  });
});

describe('regras de domínio no repositório', () => {
  it('acusa log com CPF, rota sem auth e consulta sem tenant; respeita filtro, auth e rota pública', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', {
      'src/rotas/orcamento.ts': [
        "router.post('/orcamentos/:id/aprovar', async (req, res) => {",
        '  const o = await prisma.orcamento.findFirst({',
        '    where: { id: req.params.id },',
        '  });',
        '  const c = await prisma.cliente.findMany({',
        '    where: { tenantId: req.user.tenantId },',
        '  });',
        "  console.log('aprovado por', req.body.cpf);",
        '});',
        "router.post('/webhooks/pix', handler);",
      ].join('\n'),
      'src/rotas/seguro.ts': "router.use(requireAuth);\nrouter.get('/clientes', listar);\n",
    });
    const out = domainCheck.run(ctx());
    const got = out.findings.map((f) => `${f.rule}:${f.file}:${f.line}`).sort();
    assert.deepEqual(got, [
      'pii-in-log:src/rotas/orcamento.ts:8',
      'query-without-tenant:src/rotas/orcamento.ts:2',
      'route-without-auth:src/rotas/orcamento.ts:1',
    ]);
    // heurísticas: avisam, não bloqueiam com a configuração padrão
    for (const f of finalizeFindings(out.findings, cfg.security)) assert.notEqual(f.level, 'block', f.rule);
  });

  it('sem tenantModels a regra de tenant não roda e a cobertura diz isso', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'src/a.ts': 'prisma.orcamento.findMany()\n' });
    const out = domainCheck.run({ ...ctx(), cfg: DEFAULT_CONFIG });
    assert.equal(out.findings.length, 0);
    assert.match(out.coverage.reason ?? '', /configure domain\.tenantModels/);
  });
});
