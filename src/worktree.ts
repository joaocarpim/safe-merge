import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitOut } from './git.js';

/**
 * Cria uma cópia temporária (git worktree, HEAD solto) do commit, roda `fn` nela e apaga tudo no fim.
 * As branches, o índice e a árvore de trabalho do usuário não são tocados.
 */
export function withWorktree<T>(repoDir: string, commit: string, fn: (dir: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'safemerge-'));
  const dir = join(tmp, 'wt');
  try {
    gitOut(repoDir, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
    return fn(dir);
  } finally {
    git(repoDir, ['worktree', 'remove', '--force', dir]);
    rmSync(tmp, { recursive: true, force: true });
    git(repoDir, ['worktree', 'prune']);
  }
}

/** Pasta temporária apagada no fim. */
export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'safemerge-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
