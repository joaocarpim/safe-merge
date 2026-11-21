// Vários repositórios numa pasta (front e back): acha todos e analisa ao mesmo tempo, rodando a CLI de verdade.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { analyzeWorkspace, findRepos, renderWorkspaceMarkdown, renderWorkspaceText, workspaceLevel } from '../src/workspace.ts';
import { TestRepo } from './helpers.ts';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const cli = { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), CLI] };

const root = mkdtempSync(join(tmpdir(), 'sm-ws-'));
after(() => rmSync(root, { recursive: true, force: true }));

// back: branch com conflito com main · front: branch limpa
const back = new TestRepo(join(root, 'backend'));
const front = new TestRepo(join(root, 'apps', 'frontend'));
for (const r of [back, front]) {
  mkdirSync(r.dir, { recursive: true });
  r.git('init', '-q', '-b', 'main');
  r.git('config', 'commit.gpgsign', 'false');
}
back.commit('base', { 'api.py': 'a\nb\nc\n' });
back.branch('feat/api');
back.commit('api', { 'api.py': 'A\nb\nc\n' });
back.checkout('main');
back.commit('main mudou', { 'api.py': 'Z\nb\nc\n' });
back.checkout('feat/api');
front.commit('base', { 'tela.ts': 'x\n' });
front.branch('feat/tela');
front.commit('tela', { 'nova.ts': 'export const y = 1;\n' });
mkdirSync(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });

describe('workspace: vários repositórios de uma vez', () => {
  it('acha os repositórios (até 3 níveis), com a branch, sem entrar em node_modules', () => {
    assert.deepEqual(findRepos(root).map((r) => [r.relative, r.branch]), [['apps/frontend', 'feat/tela'], ['backend', 'feat/api']]);
  });

  it('analisa todos em paralelo e junta: o veredito geral é o mais grave', async () => {
    const w = await analyzeWorkspace({ root, allBranches: false, forward: ['--no-fetch', '--no-security'], jobs: 4, depth: 3, cli });
    const byRepo = Object.fromEntries(w.entries.map((e) => [e.repo.relative, e.error ?? e.report!.verdict.level]));
    assert.deepEqual(byRepo, { 'apps/frontend': 'ok', backend: 'block' });
    assert.equal(workspaceLevel(w), 'block');
    const text = renderWorkspaceText(w);
    assert.match(text, /2 repositório\(s\)/);
    assert.match(text, /backend \(feat\/api\) → main {2}✗ NÃO MERGEAR/);
    assert.match(text, /1 arquivo em conflito com main/);
    assert.match(renderWorkspaceMarkdown(w), /\| apps\/frontend \| `feat\/tela` → `main` \| ✓ PODE MERGEAR \| 0 \| 0 \|/);
  });

  it('com --all-branches roda a matriz de cada repositório', async () => {
    const w = await analyzeWorkspace({ root, allBranches: true, forward: ['--no-fetch', '--no-security'], jobs: 2, depth: 3, cli });
    const back = w.entries.find((e) => e.repo.relative === 'backend')!;
    assert.deepEqual(back.matrix!.rows.map((r) => [r.branch, r.level]), [['feat/api', 'block']]);
  });

  it('rodar safemerge na pasta raiz (que não é repositório) entra sozinho nesse modo', () => {
    let out = '';
    try {
      execFileSync(cli.command, [...cli.args, '--no-fetch', '--no-security'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out = (err as { stdout: string }).stdout; // sai com 1: o back não pode ser mergeado
    }
    assert.match(out, /safemerge · 2 repositório\(s\)/);
    assert.match(out, /backend \(feat\/api\) → main {2}✗ NÃO MERGEAR/);
    assert.match(out, /apps\/frontend \(feat\/tela\) → main {2}✓ PODE MERGEAR/);
  });
});
