import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ana',
  GIT_AUTHOR_EMAIL: 'ana@example.com',
  GIT_COMMITTER_NAME: 'Ana',
  GIT_COMMITTER_EMAIL: 'ana@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  LC_ALL: 'C',
};

export class TestRepo {
  readonly dir: string;
  private readonly cleanup: string[];

  constructor(dir?: string, cleanup: string[] = []) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), 'sm-test-'));
    this.cleanup = cleanup.length ? cleanup : [this.dir];
    if (!dir) {
      this.git('init', '-q', '-b', 'main');
      this.git('config', 'commit.gpgsign', 'false');
    }
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, env: ENV, encoding: 'utf8' }).trim();
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  /** Escreve arquivos e faz um commit. */
  commit(message: string, files: Record<string, string>): string {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  /** Cria a branch a partir de `from` e muda para ela. */
  branch(name: string, from = 'main'): void {
    this.git('checkout', '-q', '-b', name, from);
  }

  checkout(name: string): void {
    this.git('checkout', '-q', name);
  }

  /** Cria um remoto "origin" (repositório bare) com tudo o que existe agora e o liga a este. */
  withRemote(): void {
    const bare = mkdtempSync(join(tmpdir(), 'sm-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: ENV });
    this.cleanup.push(bare);
    this.git('remote', 'add', 'origin', bare);
    this.git('push', '-q', 'origin', '--all');
    this.git('fetch', '-q', 'origin');
    this.git('remote', 'set-head', 'origin', 'main');
  }

  push(branch: string): void {
    this.git('push', '-q', 'origin', branch);
    this.git('fetch', '-q', 'origin');
  }

  destroy(): void {
    for (const d of this.cleanup) rmSync(d, { recursive: true, force: true });
  }
}

/** Repositório com `main` e um arquivo base de 3 linhas. */
export function baseRepo(): TestRepo {
  const repo = new TestRepo();
  repo.commit('base', { 'calc.txt': 'a\nb\nc\n', 'other.txt': 'x\n', 'package-lock.json': '{}\n' });
  return repo;
}
