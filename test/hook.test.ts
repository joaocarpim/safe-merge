import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { HOOK_MARK, installHook } from '../src/hook.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const CLI = join(import.meta.dirname, '../src/cli.ts');
const COMMAND = [process.execPath, '--import', import.meta.resolve('tsx'), CLI];

function push(branch: string): { status: number | null; stderr: string } {
  const r = spawnSync('git', ['push', '-q', 'origin', branch], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { status: r.status, stderr: r.stderr };
}

describe('hook pre-push', () => {
  it('instala, e não sobrescreve hook de outra ferramenta sem --force', () => {
    repo = baseRepo();
    const hooks = join(repo.dir, '.git', 'hooks');
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho outro\n');
    assert.throws(() => installHook(repo.dir, COMMAND), /já existe um hook pre-push/);
    const res = installHook(repo.dir, COMMAND, { force: true });
    assert.ok(readFileSync(res.path, 'utf8').includes(HOOK_MARK));
    assert.ok(existsSync(join(hooks, 'pre-push.antes-do-safemerge')));
    installHook(repo.dir, COMMAND); // reinstalar o próprio hook não exige --force
  });

  it('bloqueia o push de uma branch que conflita com o destino e libera a que está limpa', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev reescreve b', { 'calc.txt': 'a\nDEV\nc\n' });
    repo.withRemote();
    repo.branch('feat', 'main');
    repo.commit('feat reescreve b', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.branch('limpa', 'dev');
    repo.commit('limpa', { 'outro.txt': 'x\n' });
    installHook(repo.dir, COMMAND, { timeoutSec: 60 });

    const blocked = push('feat');
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /Push cancelado/);
    const ok = push('limpa');
    assert.equal(ok.status, 0, ok.stderr);
  });
});
