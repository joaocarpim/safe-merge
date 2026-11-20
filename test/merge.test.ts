import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { locateBlock, parseConflictHunks, parseMergeTree, simulateMerge } from '../src/merge.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const target = (name: string) => ({ name, ref: `refs/heads/${name}` });

describe('parseMergeTree', () => {
  it('lê merge limpo (só o tree)', () => {
    const out = parseMergeTree('abc123\0');
    assert.equal(out.tree, 'abc123');
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.records, []);
  });

  it('lê arquivos em conflito e o tipo de cada conflito', () => {
    const raw = ['abc123', 'f.txt', 'g.txt', '', '1', 'f.txt', 'CONFLICT (contents)', 'CONFLICT (content): Merge conflict in f.txt\n', '1', 'g.txt', 'CONFLICT (modify/delete)', 'g.txt deleted in dev\n', ''].join('\0');
    const out = parseMergeTree(raw);
    assert.deepEqual(out.files, ['f.txt', 'g.txt']);
    assert.equal(out.records.length, 2);
    assert.equal(out.records[1]?.type, 'CONFLICT (modify/delete)');
    assert.deepEqual(out.records[1]?.paths, ['g.txt']);
  });
});

describe('parseConflictHunks', () => {
  it('extrai os dois lados e a posição', () => {
    const text = 'a\n<<<<<<< feat\nFEAT\nFEAT2\n=======\nDEV\n>>>>>>> dev\nc\n';
    const [h] = parseConflictHunks(text);
    assert.equal(h?.mergedStart, 2);
    assert.equal(h?.mergedEnd, 7);
    assert.deepEqual(h?.ours, ['FEAT', 'FEAT2']);
    assert.deepEqual(h?.theirs, ['DEV']);
  });

  it('ignora a seção base do estilo diff3', () => {
    const text = '<<<<<<< a\nX\n||||||| base\nB\n=======\nY\n>>>>>>> b\n';
    const [h] = parseConflictHunks(text);
    assert.deepEqual(h?.ours, ['X']);
    assert.deepEqual(h?.theirs, ['Y']);
  });

  it('limita a prévia mas guarda o total', () => {
    const many = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const [h] = parseConflictHunks(`<<<<<<< a\n${many}\n=======\nz\n>>>>>>> b\n`);
    assert.equal(h?.ours.length, 6);
    assert.equal(h?.oursTotal, 20);
  });

  it('devolve vazio sem marcadores', () => {
    assert.deepEqual(parseConflictHunks('sem conflito\n'), []);
  });
});

describe('locateBlock', () => {
  it('acha o bloco contíguo e devolve a linha 1-based', () => {
    assert.equal(locateBlock('a\nb\nc\nd\n', ['c', 'd']), 3);
    assert.equal(locateBlock('a\nb\n', ['b', 'c']), null);
    assert.equal(locateBlock('a\nb\n', []), null);
    assert.equal(locateBlock(null, ['a']), null);
  });

  it('não junta linhas separadas', () => {
    assert.equal(locateBlock('a\nx\nb\n', ['a', 'b']), null);
  });
});

describe('simulateMerge', () => {
  it('merge limpo quando cada lado mexe num arquivo diferente', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev muda other', { 'other.txt': 'y\n' });
    repo.branch('feat', 'main');
    repo.commit('feat muda calc', { 'calc.txt': 'a\nFEAT\nc\n' });
    const r = simulateMerge(repo.dir, 'HEAD', target('dev'));
    assert.equal(r.status, 'clean');
    assert.equal(r.behind, 1);
    assert.equal(r.ahead, 1);
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.autoMerged, []);
  });

  it('detecta conflito, mostra o trecho e quem mexeu no destino', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev reescreve b', { 'calc.txt': 'a\nDEV\nc\n' });
    repo.branch('feat', 'main');
    repo.commit('feat reescreve b', { 'calc.txt': 'a\nFEAT\nc\n' });
    const r = simulateMerge(repo.dir, 'HEAD', target('dev'));
    assert.equal(r.status, 'conflict');
    assert.equal(r.conflicts.length, 1);
    const f = r.conflicts[0]!;
    assert.equal(f.path, 'calc.txt');
    assert.equal(f.kind, 'contents');
    assert.deepEqual(f.hunks[0]?.ours, ['FEAT']);
    assert.deepEqual(f.hunks[0]?.theirs, ['DEV']);
    assert.equal(f.hunks[0]?.oursLine, 2);
    assert.equal(f.hunks[0]?.theirsLine, 2);
    assert.equal(f.lastTouchOnTarget?.author, 'Ana');
    assert.equal(f.lastTouchOnTarget?.subject, 'dev reescreve b');
  });

  it('avisa de arquivo alterado dos dois lados que o git juntou sozinho', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev muda topo', { 'calc.txt': 'TOPO\nb\nc\n' });
    repo.branch('feat', 'main');
    repo.commit('feat muda fim', { 'calc.txt': 'a\nb\nFIM\n' });
    const r = simulateMerge(repo.dir, 'HEAD', target('dev'));
    assert.equal(r.status, 'clean');
    assert.deepEqual(r.autoMerged, ['calc.txt']);
  });

  it('classifica alterado aqui e apagado lá', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.git('rm', '-q', 'other.txt');
    repo.git('commit', '-q', '-m', 'dev apaga other');
    repo.branch('feat', 'main');
    repo.commit('feat altera other', { 'other.txt': 'mudou\n' });
    const r = simulateMerge(repo.dir, 'HEAD', target('dev'));
    assert.equal(r.status, 'conflict');
    assert.equal(r.conflicts[0]?.kind, 'modify/delete');
    assert.deepEqual(r.conflicts[0]?.hunks, []);
  });

  it('não altera a árvore de trabalho nem as branches', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev', { 'calc.txt': 'a\nDEV\nc\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    const before = { head: repo.git('rev-parse', 'HEAD'), dev: repo.git('rev-parse', 'dev'), status: repo.git('status', '--porcelain') };
    simulateMerge(repo.dir, 'HEAD', target('dev'));
    assert.equal(repo.git('rev-parse', 'HEAD'), before.head);
    assert.equal(repo.git('rev-parse', 'dev'), before.dev);
    assert.equal(repo.git('status', '--porcelain'), before.status);
  });

  it('informa históricos sem ponto em comum', () => {
    repo = baseRepo();
    repo.git('checkout', '-q', '--orphan', 'solta');
    repo.git('rm', '-rfq', '.');
    repo.commit('raiz paralela', { 'z.txt': 'z\n' });
    const r = simulateMerge(repo.dir, 'HEAD', target('main'));
    assert.equal(r.status, 'unrelated');
  });
});
