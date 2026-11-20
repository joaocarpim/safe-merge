import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { currentBranch, detectBranches, listBranches, localDivergence, pickRemote } from '../src/branches.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

describe('detectBranches', () => {
  it('acha a padrão pelo remoto, a de integração e ignora branches de feature', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('staging', 'main');
    repo.branch('feature/orcamento', 'dev');
    repo.commit('wip', { 'a.txt': '1\n' });
    repo.withRemote();
    const remote = pickRemote(repo.dir);
    assert.equal(remote, 'origin');
    const found = detectBranches(repo.dir, DEFAULT_CONFIG, listBranches(repo.dir, remote));
    assert.equal(found.default?.name, 'main');
    assert.equal(found.integration?.name, 'dev');
    assert.deepEqual(found.main.map((b) => b.name), ['main', 'dev', 'staging']);
    assert.equal(found.main[0]?.ref, 'refs/remotes/origin/main');
  });

  it('funciona sem remoto, só com branches locais', () => {
    repo = baseRepo();
    repo.branch('develop');
    const found = detectBranches(repo.dir, DEFAULT_CONFIG, listBranches(repo.dir, null));
    assert.equal(found.remote, null);
    assert.equal(found.default?.name, 'main');
    assert.equal(found.integration?.name, 'develop');
  });

  it('usa a main quando não existe branch de integração', () => {
    repo = baseRepo();
    const found = detectBranches(repo.dir, DEFAULT_CONFIG, listBranches(repo.dir, null));
    assert.equal(found.integration?.name, 'main');
  });

  it('respeita padrões da configuração', () => {
    repo = baseRepo();
    repo.branch('release');
    const cfg = mergeConfig(DEFAULT_CONFIG, { mainBranchPatterns: ['main', 'release'], integrationPriority: ['release'] });
    const found = detectBranches(repo.dir, cfg, listBranches(repo.dir, null));
    assert.deepEqual(found.main.map((b) => b.name), ['main', 'release']);
    assert.equal(found.integration?.name, 'release');
  });

  it('lê a branch atual e devolve null com HEAD solto', () => {
    repo = baseRepo();
    assert.equal(currentBranch(repo.dir), 'main');
    repo.git('checkout', '-q', '--detach');
    assert.equal(currentBranch(repo.dir), null);
  });
});

describe('localDivergence', () => {
  it('conta commits só no local e só no remoto para branches com o mesmo nome', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.withRemote();
    repo.commit('local não enviado 1', { 'a.txt': '1\n' });
    repo.commit('local não enviado 2', { 'a.txt': '2\n' });
    const found = localDivergence(repo.dir, 'origin', ['dev', 'main']);
    assert.deepEqual(found, [{ branch: 'dev', localAhead: 2, remoteAhead: 0 }]);
  });

  it('pega o remoto à frente (alguém deu push) e ignora branches só locais ou iguais', () => {
    repo = baseRepo();
    repo.branch('feat');
    repo.withRemote();
    // simula o push de um colega: avança origin/feat sem mexer na feat local
    repo.commit('do colega', { 'b.txt': '1\n' });
    repo.push('feat');
    repo.git('reset', '-q', '--hard', 'HEAD~1');
    repo.branch('so-local');
    const found = localDivergence(repo.dir, 'origin', ['feat', 'main', 'so-local', 'nao-existe']);
    assert.deepEqual(found, [{ branch: 'feat', localAhead: 0, remoteAhead: 1 }]);
  });

  it('sem remoto não há o que comparar', () => {
    repo = baseRepo();
    assert.deepEqual(localDivergence(repo.dir, null, ['main']), []);
  });
});

describe('mergeConfig', () => {
  it('mescla objetos em profundidade e substitui listas', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { overlap: { maxAgeDays: 5 }, integrationPriority: ['x'] });
    assert.equal(merged.overlap.maxAgeDays, 5);
    assert.equal(merged.overlap.ignorePaths.length, DEFAULT_CONFIG.overlap.ignorePaths.length);
    assert.deepEqual(merged.integrationPriority, ['x']);
  });
});
