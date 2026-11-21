// Contrato de API entre repositórios (front × back): rotas criadas/removidas por uma branch do back e
// chamadas pelo front. Repositórios git de verdade numa pasta temporária.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { clientCalls, crossCheck, normalizePath, serverRoutes } from '../src/contract.ts';
import { workspaceContracts } from '../src/workspace.ts';
import { TestRepo } from './helpers.ts';

describe('contrato: leitura de rotas e chamadas', () => {
  it('normaliza caminhos: host, query, parâmetros e barra final', () => {
    assert.equal(normalizePath('${API_URL}/api/orcamentos/${id}?x=1'), '/api/orcamentos/:p');
    assert.equal(normalizePath('/api/orcamentos/:id/'), '/api/orcamentos/:p');
    assert.equal(normalizePath('api/clientes/<int:pk>/'), '/api/clientes/:p');
    assert.equal(normalizePath('/'), null);
  });

  it('rotas de Express, Nest, FastAPI e Django', () => {
    assert.deepEqual(serverRoutes('src/routes.js', "router.get('/api/os/:id', h)\napp.post(`/api/os`, h)").map((r) => `${r.method} ${r.path}`), ['GET /api/os/:p', 'POST /api/os']);
    assert.deepEqual(serverRoutes('src/os.controller.ts', "@Controller('api/os')\nclass X {\n  @Get(':id')\n  find() {}\n  @Delete(':id')\n  rm() {}\n}").map((r) => `${r.method} ${r.path}`), ['GET /api/os/:p', 'DELETE /api/os/:p']);
    assert.deepEqual(serverRoutes('app/main.py', '@router.get("/api/notas/{nota_id}")\ndef f(): ...').map((r) => `${r.method} ${r.path}`), ['GET /api/notas/:p']);
    assert.deepEqual(serverRoutes('app/urls.py', "urlpatterns = [path('api/clientes/<int:pk>/', v)]").map((r) => `${r.method} ${r.path}`), ['ANY /api/clientes/:p']);
    assert.deepEqual(serverRoutes('src/routes.test.js', "router.get('/api/x', h)"), [], 'arquivo de teste não conta');
  });

  it('chamadas do cliente: fetch (com método), axios e ignora serviço de terceiros', () => {
    const calls = clientCalls('src/api.ts', "fetch(`${BASE}/api/os/${id}`)\nfetch('/api/os', { method: 'POST' })\naxios.delete(`/api/os/${id}`)\nfetch('https://viacep.com.br/ws/01001000/json')");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}:${c.line}`), ['GET /api/os/:p:1', 'POST /api/os:2', 'DELETE /api/os/:p:3']);
  });
});

describe('contrato: back × front', () => {
  const root = mkdtempSync(join(tmpdir(), 'sm-contract-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const mk = (name: string) => {
    const r = new TestRepo(join(root, name));
    mkdirSync(r.dir, { recursive: true });
    r.git('init', '-q', '-b', 'main');
    r.git('config', 'commit.gpgsign', 'false');
    return r;
  };
  const back = mk('backend');
  back.commit('base', { 'src/routes.js': "router.get('/api/os/:id', ver)\nrouter.get('/api/os/:id/pdf', pdf)\n" });
  back.branch('feat/novo-pdf');
  // remove a rota antiga do PDF e cria a de recibo
  back.commit('novo pdf', { 'src/routes.js': "router.get('/api/os/:id', ver)\nrouter.get('/api/os/:id/recibo', recibo)\n" });
  const front = mk('frontend');
  front.commit('base', { 'src/api.ts': "export const pdf = (id) => fetch(`/api/os/${id}/pdf`);\n" });
  front.branch('feat/recibo');
  front.commit('recibo', { 'src/recibo.ts': "export const recibo = (id) => axios.get(`/api/os/${id}/recibo`);\n" });

  it('acha a rota removida que o front usa e a rota nova de que o front depende', () => {
    const issues = crossCheck(
      { name: 'backend', cwd: back.dir, branch: 'feat/novo-pdf', head: 'refs/heads/feat/novo-pdf', base: 'refs/heads/main' },
      { name: 'frontend', cwd: front.dir, branch: 'feat/recibo', head: 'refs/heads/feat/recibo', base: 'refs/heads/main' },
    );
    assert.deepEqual(issues.map((i) => [i.kind, `${i.method} ${i.route}`, `${i.file}:${i.line}`]), [
      ['removed-used', 'GET /api/os/:p/pdf', 'src/api.ts:1'],
      ['new-needed', 'GET /api/os/:p/recibo', 'src/recibo.ts:1'],
    ]);
    assert.match(issues[1]!.message, /O back precisa entrar antes do front/);
  });

  it('a pasta raiz cruza os dois repositórios nas branches atuais', () => {
    const issues = workspaceContracts(root, { allBranches: false });
    assert.deepEqual(issues.map((i) => `${i.kind} ${i.backRepo}/${i.backBranch} → ${i.frontRepo}/${i.frontBranch}`).sort(), [
      'new-needed backend/feat/novo-pdf → frontend/feat/recibo',
      'removed-used backend/feat/novo-pdf → frontend/feat/recibo',
    ]);
  });
});
