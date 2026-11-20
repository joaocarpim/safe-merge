import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listBranches } from '../src/branches.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { findOverlaps } from '../src/overlap.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

function run(extra: { nowMs?: number } = {}) {
  const all = listBranches(repo.dir, null).all;
  const primary = all.get('dev')!;
  const exclude = new Set(['main', 'dev', 'feat']);
  const candidates = [...all.values()].filter((b) => !exclude.has(b.name));
  return findOverlaps({ cwd: repo.dir, headRef: 'refs/heads/feat', primary, candidates, prs: [], cfg: DEFAULT_CONFIG, exclude, ...extra });
}

function setup() {
  repo = baseRepo();
  repo.branch('dev');
}

describe('findOverlaps', () => {
  it('aponta outra branch que vai conflitar com a sua', () => {
    setup();
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.branch('fix/desconto', 'dev');
    repo.commit('outra', { 'calc.txt': 'a\nOUTRA\nc\n' });
    const [o] = run();
    assert.equal(o?.branch, 'fix/desconto');
    assert.equal(o?.wouldConflict, true);
    assert.deepEqual(o?.conflictFiles, ['calc.txt']);
    assert.equal(o?.relation, 'independent');
  });

  it('lista branch que mexe no mesmo arquivo mas junta sem conflito', () => {
    setup();
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'TOPO\nb\nc\n' });
    repo.branch('outra', 'dev');
    repo.commit('outra', { 'calc.txt': 'a\nb\nFIM\n' });
    const [o] = run();
    assert.equal(o?.wouldConflict, false);
    assert.deepEqual(o?.sharedFiles, ['calc.txt']);
  });

  it('ignora branch que não toca nos mesmos arquivos', () => {
    setup();
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.branch('longe', 'dev');
    repo.commit('longe', { 'other.txt': 'y\n' });
    assert.deepEqual(run(), []);
  });

  it('ignora lockfiles em comum', () => {
    setup();
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'package-lock.json': '{"a":1}\n' });
    repo.branch('lock', 'dev');
    repo.commit('lock', { 'package-lock.json': '{"b":2}\n' });
    assert.deepEqual(run(), []);
  });

  it('detecta branch empilhada: a sua já carrega os commits dela', () => {
    setup();
    repo.branch('base-pr', 'dev');
    repo.commit('base-pr', { 'other.txt': 'y\n' });
    repo.branch('feat', 'base-pr');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    const [o] = run();
    assert.equal(o?.branch, 'base-pr');
    assert.equal(o?.relation, 'ours-contains-theirs');
    assert.equal(o?.wouldConflict, false);
  });

  it('ignora branch já mergeada no destino', () => {
    setup();
    repo.branch('velha', 'dev');
    repo.commit('velha', { 'calc.txt': 'a\nVELHA\nc\n' });
    repo.checkout('dev');
    repo.git('merge', '-q', '--ff-only', 'velha');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nVELHA\nFEAT\n' });
    assert.deepEqual(run(), []);
  });

  it('ignora branch parada há mais dias que o limite', () => {
    setup();
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.branch('parada', 'dev');
    repo.commit('parada', { 'calc.txt': 'a\nPARADA\nc\n' });
    assert.equal(run().length, 1);
    assert.deepEqual(run({ nowMs: Date.now() + 120 * 86400_000 }), []);
  });

  it('põe quem conflita antes de quem só empilha', () => {
    setup();
    repo.branch('base-pr', 'dev');
    repo.commit('base-pr', { 'other.txt': 'y\n' });
    repo.branch('feat', 'base-pr');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.branch('rival', 'dev');
    repo.commit('rival', { 'calc.txt': 'a\nRIVAL\nc\n' });
    assert.deepEqual(run().map((o) => o.branch), ['rival', 'base-pr']);
  });
});

describe('renomeação', () => {
  it('diz quando a outra branch renomeou um arquivo que você alterou', () => {
    repo = baseRepo();
    repo.commit('servico', { 'src/servico.js': 'um\ndois\ntres\nquatro\ncinco\n' });
    repo.branch('dev');
    repo.branch('renomeia', 'dev');
    repo.git('mv', 'src/servico.js', 'src/orcamento.js');
    repo.git('commit', '-q', '-m', 'renomeia');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'src/servico.js': 'um\ndois\nTRES\nquatro\ncinco\n' });
    const found = findOverlaps({
      cwd: repo.dir,
      headRef: 'HEAD',
      primary: { name: 'dev', ref: 'refs/heads/dev' },
      candidates: [{ name: 'renomeia', ref: 'refs/heads/renomeia' }],
      prs: [],
      cfg: DEFAULT_CONFIG,
      exclude: new Set(['dev', 'feat']),
    });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.renames, [{ from: 'src/servico.js', to: 'src/orcamento.js' }]);
    assert.equal(found[0]!.wouldConflict, false, 'o git leva a sua mudança para o arquivo novo');
  });
});
