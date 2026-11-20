import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { errorExcerpt } from '../src/render/common.ts';
import { semanticCheck } from '../src/semantic.ts';
import type { ToolRunner } from '../src/tools.ts';
import { TestRepo } from './helpers.ts';

/** Sem Docker, mesmo que a máquina tenha: o teste fica igual em qualquer lugar. */
const LOCAL = mergeConfig(DEFAULT_CONFIG, { isolation: { mode: 'none' } });

let repo: TestRepo;
afterEach(() => repo?.destroy());

const CHECK = "const fs=require('fs');for(const f of fs.readdirSync('src').filter((n)=>n.endsWith('.js'))){require('./src/'+f)}\n";
const CMD = 'node check.js';
const dev = { name: 'dev', ref: 'refs/heads/dev' };

function project(): void {
  repo = new TestRepo();
  repo.commit('base', { 'check.js': CHECK, 'src/lib.js': 'exports.soma = (a, b) => a + b;\n', 'src/notas.txt': 'x\n' });
  repo.branch('dev');
}

describe('semanticCheck', () => {
  it('pega o conflito que o git não vê: merge limpo no texto, quebra na junção', () => {
    project();
    repo.commit('dev renomeia soma para somar', { 'src/lib.js': 'exports.somar = (a, b) => a + b;\n' });
    repo.branch('feat', 'main');
    repo.commit('feat usa soma', { 'src/usa.js': "const { soma } = require('./lib');\nif (soma(1, 2) !== 3) throw new Error('soma errada');\n" });
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, CMD);
    assert.equal(r.status, 'failed');
    assert.equal(r.cause, 'semantic-conflict');
    assert.match(r.outputTail, /soma is not a function/);
    assert.ok(!r.outputTail.includes('safemerge-'), 'caminho da pasta temporária não deve vazar');
    assert.match(r.outputTail, /\.[\\/]src[\\/]usa\.js/); // no Windows o separador é "\"
  });

  it('passa quando a junção está saudável', () => {
    project();
    repo.commit('dev mexe em notas', { 'src/notas.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat usa soma', { 'src/usa.js': "require('./lib').soma(1, 2);\n" });
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, CMD);
    assert.equal(r.status, 'passed');
    assert.equal(r.exitCode, 0);
  });

  it('diz que o destino já estava quebrado, sem culpar a sua branch', () => {
    project();
    repo.commit('dev quebrado', { 'src/quebrado.js': "throw new Error('dev quebrada');\n" });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/ok.js': 'module.exports = 1;\n' });
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, CMD);
    assert.equal(r.status, 'failed');
    assert.equal(r.cause, 'target-failing');
  });

  it('diz que a sua branch já falha sozinha', () => {
    project();
    repo.commit('dev', { 'src/notas.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat quebrada', { 'src/quebrada.js': "throw new Error('feat quebrada');\n" });
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, CMD);
    assert.equal(r.status, 'failed');
    assert.equal(r.cause, 'branch-failing');
  });

  it('pula quando não há comando', () => {
    project();
    repo.branch('feat', 'main');
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, null);
    assert.equal(r.status, 'skipped');
  });

  it('pula quando já existe conflito de texto', () => {
    project();
    repo.commit('dev', { 'src/notas.txt': 'DEV\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/notas.txt': 'FEAT\n' });
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, CMD);
    assert.equal(r.status, 'skipped');
    assert.match(r.reason ?? '', /conflito de texto/);
  });

  it('teste que falha e passa ao repetir é instável, não conflito', () => {
    project();
    repo.commit('dev', { 'src/notas.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/a.js': 'module.exports = 1;\n' });
    // falha na 1ª execução e passa na 2ª: o contador fica fora da cópia temporária
    const counter = join(mkdtempSync(join(tmpdir(), 'sm-flaky-')), 'n');
    writeFileSync(counter, '0');
    const flaky = `node -e "const fs=require('fs');const p=${JSON.stringify(counter).replace(/"/g, "'")};const n=+fs.readFileSync(p,'utf8')+1;fs.writeFileSync(p,String(n));process.exit(n===1?1:0)"`;
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, flaky);
    assert.equal(r.status, 'flaky');
    assert.equal(r.attempts, 2);
    rmSync(dirname(counter), { recursive: true, force: true });
  });

  it('roda o build antes dos testes e diz quando foi o build que quebrou', () => {
    project();
    repo.commit('dev renomeia soma para somar', { 'src/lib.js': 'exports.somar = (a, b) => a + b;\n' });
    repo.branch('feat', 'main');
    repo.commit('feat usa soma', { 'src/usa.js': "const { soma } = require('./lib');\nsoma(1, 2);\n" });
    const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, 'node -e "process.exit(0)"', { buildCommand: CMD });
    assert.equal(r.status, 'failed');
    assert.equal(r.stage, 'build');
    assert.equal(r.cause, 'semantic-conflict');
  });

  it('no Docker: container sem rede, cópia montada em /work e sem repassar o ambiente', () => {
    project();
    repo.commit('dev', { 'src/notas.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/a.js': 'module.exports = 1;\n' });
    const calls: string[][] = [];
    const docker: ToolRunner = (cmd, args) => {
      calls.push(args);
      return { missing: false, code: 0, stdout: args[0] === 'info' ? 'linux' : '', stderr: '', timedOut: false };
    };
    const r = semanticCheck(repo.dir, 'HEAD', dev, DEFAULT_CONFIG, CMD, { tools: docker });
    assert.equal(r.status, 'passed');
    assert.equal(r.isolation?.mode, 'docker');
    const run = calls.find((a) => a[0] === 'run')!;
    assert.deepEqual(run.slice(0, 4), ['run', '--rm', '--network', 'none']);
    assert.ok(run.some((a) => a.endsWith(':/work')));
    assert.equal(run.at(-1), CMD);
    assert.ok(!run.includes('--env-file') && !run.some((a) => /TOKEN|KEY/.test(a)));
  });

  it('docker run que falha por infraestrutura (imagem, daemon) é erro, nunca "testes falharam"', () => {
    project();
    repo.commit('dev', { 'src/notas.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/a.js': 'module.exports = 1;\n' });
    const quebrado: ToolRunner = (cmd, args) => ({
      missing: false,
      code: args[0] === 'info' ? 0 : 125,
      stdout: args[0] === 'info' ? 'linux' : '',
      stderr: args[0] === 'info' ? '' : 'docker: no matching manifest for windows/amd64 in the manifest list entries',
      timedOut: false,
    });
    const r = semanticCheck(repo.dir, 'HEAD', dev, DEFAULT_CONFIG, CMD, { tools: quebrado });
    assert.equal(r.status, 'error');
    assert.match(r.reason ?? '', /Docker não conseguiu rodar a imagem/);
    assert.equal(r.cause, undefined);
  });

  it('modo local: testes não recebem tokens do ambiente', () => {
    project();
    repo.commit('dev', { 'src/notas.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/a.js': 'module.exports = 1;\n' });
    process.env.SM_TEST_GITHUB_TOKEN = 'nao-pode-vazar';
    try {
      const r = semanticCheck(repo.dir, 'HEAD', dev, LOCAL, 'node -e "process.exit(process.env.SM_TEST_GITHUB_TOKEN ? 1 : 0)"');
      assert.equal(r.status, 'passed');
      assert.ok(r.isolation?.envWithheld.includes('SM_TEST_GITHUB_TOKEN'));
    } finally {
      delete process.env.SM_TEST_GITHUB_TOKEN;
    }
  });

  it('não deixa cópias temporárias nem altera o repositório', () => {
    project();
    repo.commit('dev', { 'src/notas.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/a.js': 'module.exports = 1;\n' });
    const before = { head: repo.git('rev-parse', 'HEAD'), status: repo.git('status', '--porcelain'), branches: repo.git('branch', '--list') };
    semanticCheck(repo.dir, 'HEAD', dev, LOCAL, CMD);
    assert.equal(repo.git('worktree', 'list').split('\n').length, 1);
    assert.equal(repo.git('rev-parse', 'HEAD'), before.head);
    assert.equal(repo.git('status', '--porcelain'), before.status);
    assert.equal(repo.git('branch', '--list'), before.branches);
  });
});

describe('errorExcerpt', () => {
  const trace = ['./src/a.js:2', 'const x = f(1);', '          ^', '', 'TypeError: f is not a function', '    at a (./src/a.js:2:11)', '    at b', '    at c', '    at d', '    at e', '', 'Node.js v22'].join('\n');

  it('começa no código que quebrou e inclui a linha do erro, não o fim do stack', () => {
    const out = errorExcerpt(trace);
    assert.ok(out.some((l) => l.includes('TypeError: f is not a function')));
    assert.ok(out[0]?.includes('const x') || out[0]?.includes('^') || out[0]?.includes('./src/a.js'));
    assert.ok(out.length <= 8);
  });

  it('sem linha de erro reconhecível, mostra o final', () => {
    assert.deepEqual(errorExcerpt('a\nb\nc\nd', 2), ['c', 'd']);
  });
});
