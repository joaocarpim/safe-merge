import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { matrix, renderMatrixMarkdown, renderMatrixText } from '../src/matrix.ts';
import type { ToolRunner } from '../src/tools.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const noTools: ToolRunner = () => ({ missing: true, code: 127, stdout: '', stderr: '', timedOut: false });
const LOCK = (extra: string) => `{\n  "lockfileVersion": 3,\n  "packages": {\n    "": {}${extra}\n  }\n}\n`;

describe('matrix', () => {
  it('uma linha por branch aberta, ordenada por gravidade, com contagem por categoria', () => {
    repo = baseRepo();
    repo.commit('lock', { 'package-lock.json': LOCK('') });
    repo.branch('dev');
    repo.commit('dev reescreve b', { 'calc.txt': 'a\nDEV\nc\n' });
    repo.branch('feat/conflito', 'main');
    repo.commit('conflito', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.branch('feat/limpa', 'dev');
    repo.commit('limpa', { 'outro.txt': 'x\n' });
    repo.branch('feat/dep', 'dev');
    repo.commit('dep', { 'package-lock.json': LOCK(',\n    "node_modules/x": { "version": "1.0.0", "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz", "integrity": "sha512-A", "hasInstallScript": true }') });
    repo.branch('feat/ja-mergeada', 'dev');
    repo.checkout('dev');

    const m = matrix({ cwd: repo.dir, cfg: DEFAULT_CONFIG, limit: 10, fetch: false, tools: noTools });
    assert.equal(m.base, 'dev');
    assert.deepEqual(m.rows.map((r) => `${r.branch}:${r.level}`), ['feat/conflito:block', 'feat/dep:block', 'feat/limpa:ok']);
    assert.equal(m.rows[0]!.conflicts, 1);
    assert.deepEqual(m.rows[1]!.cells['supply-chain'], { block: 1, warn: 0 });
    assert.ok(m.skipped.some((s) => s.branch === 'feat/ja-mergeada' && /já mergeada/.test(s.reason)));
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'dev', 'não troca de branch');

    const text = renderMatrixText(m);
    assert.match(text, /feat\/dep\s+✗ não mergear/);
    assert.match(renderMatrixMarkdown(m), /\| `feat\/conflito` \| 🔴 não mergear \| 1 \|/);
  });

  it('respeita o limite e diz quem ficou de fora', () => {
    repo = baseRepo();
    repo.branch('dev');
    for (const n of ['a', 'b', 'c']) {
      repo.branch(`f/${n}`, 'dev');
      repo.commit(n, { [`${n}.txt`]: n });
    }
    const m = matrix({ cwd: repo.dir, cfg: DEFAULT_CONFIG, limit: 2, fetch: false, tools: noTools, security: false });
    assert.equal(m.rows.length, 2);
    assert.ok(m.skipped.some((s) => s.branch === 'f/c' && /--limit/.test(s.reason)));
  });
});
