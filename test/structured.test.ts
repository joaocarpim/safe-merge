import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { analyze } from '../src/analyze.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { simulateMerge } from '../src/merge.ts';
import { renderMarkdown } from '../src/render/markdown.ts';
import { renderText } from '../src/render/text.ts';
import { renderReplay, replay } from '../src/structured.ts';
import type { ToolRunner } from '../src/tools.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const quiet = { fetch: false, usePrs: false, security: false } as const;
const done = { missing: false, code: 0, stdout: '1.0.0', stderr: '', timedOut: false };
const dev = { name: 'dev', ref: 'refs/heads/dev' };

/** Mergiraf falso: devolve `resolve(left, right)` ou, se ele der null, sobra conflito. */
function fakeMergiraf(resolve: (left: string, right: string) => string | null): ToolRunner {
  return (cmd, args) => {
    if (cmd !== 'mergiraf') return { missing: true, code: 127, stdout: '', stderr: '', timedOut: false };
    if (args[0] === '--version') return done;
    const [, , left, right, , out] = args as [string, string, string, string, string, string];
    const merged = resolve(readFileSync(left, 'utf8'), readFileSync(right, 'utf8'));
    writeFileSync(out, merged ?? '<<<<<<< left\nx\n=======\ny\n>>>>>>> right\n');
    return { ...done, code: merged === null ? 1 : 0, stdout: '' };
  };
}

function conflict(): void {
  repo = baseRepo();
  repo.branch('dev');
  repo.commit('dev reescreve b', { 'calc.txt': 'a\nDEV\nc\n' });
  repo.branch('feat', 'main');
  repo.commit('feat reescreve b', { 'calc.txt': 'a\nFEAT\nc\n' });
}

describe('merge estruturado', () => {
  it('mostra como o trecho era no ponto de partida (zdiff3)', () => {
    conflict();
    const r = simulateMerge(repo.dir, 'HEAD', dev);
    const h = r.conflicts[0]!.hunks[0]!;
    assert.deepEqual(h.ours, ['FEAT']);
    assert.deepEqual(h.base, ['b']);
    assert.deepEqual(h.theirs, ['DEV']);
    assert.match(renderText(analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet }), { color: false }), /antes\s+│ b/);
  });

  it('conflito em lockfile sugere regenerar em vez de resolver na mão', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev lock', { 'package-lock.json': '{"a":1}\n' });
    repo.branch('feat', 'main');
    repo.commit('feat lock', { 'package-lock.json': '{"a":2}\n' });
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.equal(r.targets[0]!.conflicts[0]!.hint, 'regenerate-lockfile');
    assert.ok(r.verdict.reasons.some((x) => /regenere/.test(x.text)));
    assert.match(renderMarkdown(r), /regenere depois do merge/);
  });

  it('Mergiraf separa conflito só de linha de conflito real', () => {
    conflict();
    const lineOnly = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet, tools: fakeMergiraf(() => 'a\nFEAT e DEV\nc\n') });
    assert.equal(lineOnly.targets[0]!.conflicts[0]!.structured?.result, 'line-only');
    assert.equal(lineOnly.coverage.find((c) => c.check === 'mergiraf')?.status, 'ran');
    assert.ok(lineOnly.verdict.reasons.some((x) => /só de linha/.test(x.text)));
    assert.equal(lineOnly.verdict.level, 'block', 'o git ainda conflita: continua bloqueando');

    const real = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet, tools: fakeMergiraf(() => null) });
    assert.equal(real.targets[0]!.conflicts[0]!.structured?.result, 'real');
  });

  it('sem Mergiraf: sem cobertura, sem classificar', () => {
    conflict();
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet, tools: () => ({ missing: true, code: 127, stdout: '', stderr: '', timedOut: false }) });
    assert.equal(r.coverage.find((c) => c.check === 'mergiraf')?.status, 'missing-tool');
    assert.equal(r.targets[0]!.conflicts[0]!.structured, undefined);
  });
});

describe('replay', () => {
  /** `git merge` que para em conflito (sai com erro de propósito). */
  function mergeWithConflict(branch: string, message: string): void {
    assert.throws(() => repo.git('merge', '-q', branch, '-m', message));
  }

  /** Dois merges antigos com conflito, resolvidos pelo dev como "A+B" e "X". */
  function history(): void {
    repo = baseRepo();
    repo.branch('a');
    repo.commit('a', { 'calc.txt': 'a\nA\nc\n' });
    repo.branch('b', 'main');
    repo.commit('b', { 'calc.txt': 'a\nB\nc\n' });
    repo.checkout('main');
    repo.git('merge', '-q', 'a');
    mergeWithConflict('b', 'merge b');
    // fica em conflito: o "dev" resolve
    repo.write('calc.txt', 'a\nA+B\nc\n');
    repo.git('add', 'calc.txt');
    repo.git('commit', '-q', '--no-edit');
    repo.branch('c');
    repo.commit('c', { 'other.txt': 'C\n' });
    repo.branch('d', 'main');
    repo.commit('d', { 'other.txt': 'D\n' });
    repo.checkout('main');
    repo.git('merge', '-q', 'd');
    mergeWithConflict('c', 'merge c');
    repo.write('other.txt', 'X\n');
    repo.git('add', 'other.txt');
    repo.git('commit', '-q', '--no-edit');
    // merge sem conflito, para contar
    repo.branch('e');
    repo.commit('e', { 'e.txt': 'e\n' });
    repo.checkout('main');
    repo.git('merge', '-q', '--no-ff', 'e', '-m', 'merge e');
  }

  it('conta merges e conflitos do git, e compara o Mergiraf com o que o dev commitou', () => {
    history();
    const tools = fakeMergiraf((left, right) => (left.includes('A') || right.includes('A') ? 'a\nA+B\nc\n' : 'Y\n'));
    const s = replay(repo.dir, { limit: 50, tools, cfg: DEFAULT_CONFIG });
    assert.equal(s.mergesWithConflict, 2);
    assert.equal(s.conflictFiles, 2);
    assert.ok(s.merges >= 3);
    assert.deepEqual(s.mergiraf, { available: true, same: 1, different: 1, unresolved: 0, errors: 0 });
    const text = renderReplay(s);
    assert.match(text, /conflitos que somem sem merge diferente: 1 de 2/);
    assert.match(text, /other\.txt/);
  });

  it('sem Mergiraf conta só os conflitos do git e diz que não tem cobertura', () => {
    history();
    const s = replay(repo.dir, { limit: 50, tools: () => ({ missing: true, code: 127, stdout: '', stderr: '', timedOut: false }), cfg: DEFAULT_CONFIG });
    assert.equal(s.mergiraf.available, false);
    assert.equal(s.mergesWithConflict, 2);
    assert.match(renderReplay(s), /sem cobertura/);
  });

  it('não altera o repositório', () => {
    history();
    const before = repo.git('status', '--porcelain') + repo.git('rev-parse', 'HEAD');
    replay(repo.dir, { limit: 50, tools: fakeMergiraf(() => 'z'), cfg: DEFAULT_CONFIG });
    assert.equal(repo.git('status', '--porcelain') + repo.git('rev-parse', 'HEAD'), before);
  });
});
