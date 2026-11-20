/**
 * Bateria offline dos agentes: respostas de modelo ROTEIRIZADAS (escritas à mão, como um modelo
 * responderia) passam pelos verificadores sem IA. Nenhuma chamada de API: roda no CI de graça.
 * Cobre os dois jeitos de a IA errar que o safemerge precisa pegar: inventar fatos no resumo e
 * propor uma resolução de conflito que não funciona.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { analyze, type AnalysisReport } from '../src/analyze.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { verifyResolution } from '../src/resolution.ts';
import type { ToolRunner } from '../src/tools.ts';
import { verifyText } from '../src/verify.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const noTools: ToolRunner = () => ({ missing: true, code: 127, stdout: '', stderr: '', timedOut: false });
const LOCAL = mergeConfig(DEFAULT_CONFIG, { isolation: { mode: 'none' } });
const dev = { name: 'dev', ref: 'refs/heads/dev' };

const LOCK = (extra: string) =>
  `{\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "app" }${extra}\n  }\n}\n`;

/** Conflito em src/calc.js com a dev + pacote novo com script de instalação. */
function scenario(): AnalysisReport {
  repo = baseRepo();
  repo.commit('base', {
    'src/calc.js': 'function soma(a, b) {\n  return a + b;\n}\nmodule.exports = { soma };\n',
    'test.js': "const { soma } = require('./src/calc');\nif (soma(2, 3) !== 5) { console.error('soma errada'); process.exit(1); }\n",
    'package-lock.json': LOCK(''),
  });
  repo.branch('dev');
  repo.commit('dev: soma com Number', { 'src/calc.js': 'function soma(a, b) {\n  return Number(a) + Number(b);\n}\nmodule.exports = { soma };\n' });
  repo.branch('feat', 'main');
  repo.commit('feat: soma arredonda', {
    'src/calc.js': 'function soma(a, b) {\n  return Math.round(a + b);\n}\nmodule.exports = { soma };\n',
    'package-lock.json': LOCK(',\n    "node_modules/x": { "version": "1.0.0", "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz", "integrity": "sha512-A", "hasInstallScript": true }'),
  });
  return analyze({ cwd: repo.dir, cfg: LOCAL, fetch: false, usePrs: false, tools: noTools });
}

describe('bateria offline: resumo escrito pela IA', () => {
  it('resposta fiel ao relatório passa em tudo', () => {
    const r = scenario();
    const id = r.findings.find((f) => f.rule === 'install-script')!.id;
    const sha = r.targets[0]!.conflicts[0]!.lastTouchOnTarget!.sha;
    const line = r.targets[0]!.conflicts[0]!.hunks[0]!.oursLine;
    const resposta = `**Não mergear.** Há 1 arquivo em conflito com dev (src/calc.js:${line}), mexido por último no commit ${sha}.
Também há o achado ${id}: um pacote novo com script de instalação no package-lock.`;
    const v = verifyText(resposta, r);
    assert.ok(v.ok, JSON.stringify(v.claims.filter((c) => c.status !== 'verified')));
    assert.deepEqual(new Set(v.claims.map((c) => c.kind)), new Set(['count', 'location', 'sha', 'finding-id']));
  });

  const alucinacoes: Array<[string, string, RegExp]> = [
    ['id de achado inventado', 'Corrija o achado SM-deadbeef antes do merge.', /SM-deadbeef/],
    ['contagem errada', 'São 3 arquivos em conflito com dev.', /3 arquivos/],
    ['linha que não está no relatório', 'O conflito está em src/calc.js:40.', /src\/calc\.js:40/],
    ['arquivo que não está no relatório', 'Veja src/pagamento.js:2.', /src\/pagamento\.js:2/],
    ['PR inventado', 'Isso conflita também com o PR #77.', /#77/],
    ['commit inventado', 'O problema veio do commit a1b2c3d.', /a1b2c3d/],
  ];
  for (const [nome, resposta, pega] of alucinacoes) {
    it(`pega ${nome}`, () => {
      const r = scenario();
      const v = verifyText(resposta, r);
      assert.equal(v.ok, false);
      assert.ok(v.claims.some((c) => c.status === 'unverified' && pega.test(c.text)), JSON.stringify(v.claims));
    });
  }
});

describe('bateria offline: proposta de resolução escrita pela IA', () => {
  const TEST = 'node test.js';
  const propor = (corpo: string) => `function soma(a, b) {\n${corpo}\n}\nmodule.exports = { soma };\n`;
  const verificar = (proposals: Record<string, string>, testCommand: string | null = TEST) =>
    verifyResolution({ repoDir: repo.dir, headRef: 'HEAD', target: dev, proposals, cfg: LOCAL, tools: noTools, testCommand });

  it('proposta que junta os dois lados e passa nos testes: verificada', () => {
    scenario();
    const r = verificar({ 'src/calc.js': propor('  return Math.round(Number(a) + Number(b));') });
    assert.equal(r.status, 'verified', JSON.stringify(r.checks));
  });

  it('proposta com marcador de conflito esquecido: falhou', () => {
    scenario();
    const r = verificar({ 'src/calc.js': propor('<<<<<<< HEAD\n  return Math.round(a + b);\n=======\n  return Number(a) + Number(b);\n>>>>>>> dev') });
    assert.equal(r.status, 'failed');
    assert.ok(r.checks.some((c) => c.name.startsWith('marcadores') && !c.ok));
  });

  it('proposta com erro de sintaxe: falhou antes de rodar os testes', () => {
    scenario();
    const r = verificar({ 'src/calc.js': propor('  return Math.round(Number(a) + Number(b);') });
    assert.equal(r.status, 'failed');
    assert.ok(r.checks.some((c) => c.name.startsWith('sintaxe') && !c.ok));
    assert.ok(!r.checks.some((c) => c.name.startsWith('testes')));
  });

  it('proposta que compila mas quebra o comportamento: falhou nos testes', () => {
    scenario();
    const r = verificar({ 'src/calc.js': propor('  return Number(a) - Number(b);') });
    assert.equal(r.status, 'failed');
    assert.ok(r.checks.some((c) => c.name.startsWith('testes') && !c.ok && /soma errada/.test(c.detail ?? '')));
  });

  it('proposta que esquece um arquivo em conflito: incompleta', () => {
    scenario();
    assert.equal(verificar({}).status, 'incomplete');
  });

  it('proposta que mexe em arquivo sem conflito: falhou (fora do escopo)', () => {
    scenario();
    const r = verificar({ 'src/calc.js': propor('  return Math.round(Number(a) + Number(b));'), 'test.js': 'process.exit(0)\n' });
    assert.equal(r.status, 'failed');
    assert.ok(r.checks.some((c) => c.name === 'escopo' && !c.ok));
  });

  it('sem comando de testes nunca é "verificada"', () => {
    scenario();
    assert.equal(verificar({ 'src/calc.js': propor('  return Math.round(Number(a) + Number(b));') }, null).status, 'unverified');
  });

  it('verificar não aplica nada no repositório', () => {
    scenario();
    const before = repo.git('status', '--porcelain') + repo.git('rev-parse', 'HEAD') + repo.git('worktree', 'list');
    verificar({ 'src/calc.js': propor('  return 1;') });
    assert.equal(repo.git('status', '--porcelain') + repo.git('rev-parse', 'HEAD') + repo.git('worktree', 'list'), before);
  });
});

describe('entradas da análise', () => {
  it('o relatório guarda versão, commits exatos e hash da configuração, e detecta quando ficou velho', async () => {
    const { staleRefs } = await import('../src/verify.ts');
    const r = scenario();
    assert.equal(r.inputs.headSha, repo.git('rev-parse', 'HEAD'));
    assert.deepEqual(r.inputs.targets.map((t) => t.name), ['dev', 'main'].filter((n) => r.targets.some((x) => x.target === n)));
    assert.match(r.inputs.configHash, /^[0-9a-f]{40}$/);
    const resolve = (ref: string) => repo.git('rev-parse', ref);
    assert.deepEqual(staleRefs(r, resolve), []);
    repo.checkout('dev');
    repo.commit('dev andou', { 'novo.txt': 'x\n' });
    assert.match(staleRefs(r, resolve)[0] ?? '', /^dev mudou desde o relatório/);
  });
});

describe('pedido para a IA (--format prompt)', () => {
  it('traz as regras, os trechos e os ids, e não contém nada que o verify-text recuse', async () => {
    const { renderPrompt } = await import('../src/render/prompt.ts');
    const r = scenario();
    const prompt = renderPrompt(r, { reportPath: 'r.json' });
    assert.match(prompt, /Não aplique nenhuma mudança sem eu confirmar/);
    assert.match(prompt, /safemerge verify-resolution --target dev --file/);
    assert.match(prompt, /safemerge verify-text --report "r.json"/);
    assert.match(prompt, /### src\/calc\.js/);
    for (const f of r.findings.filter((x) => x.level !== 'info')) assert.ok(prompt.includes(f.id), f.id);
    const v = verifyText(prompt, r);
    assert.ok(v.ok, JSON.stringify(v.claims.filter((c) => c.status !== 'verified')));
  });
});
