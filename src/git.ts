import { spawnSync } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Executa o git sem shell. Nunca lança por código de saída diferente de zero. */
export function git(cwd: string, args: string[], opts: GitOptions = {}): GitResult {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input: opts.input,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...opts.env },
  });
  if (proc.error) {
    const reason = (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'tempo esgotado' : proc.error.message;
    return { code: 127, stdout: '', stderr: `git ${args[0] ?? ''}: ${reason}` };
  }
  return { code: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/** Executa o git e devolve stdout sem espaços nas pontas; lança se falhar. */
export function gitOut(cwd: string, args: string[], opts: GitOptions = {}): string {
  const res = git(cwd, args, opts);
  if (res.code !== 0) {
    throw new GitError(args, res);
  }
  return res.stdout.trim();
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')}: ${result.stderr.trim() || `saída ${result.code}`}`);
    this.name = 'GitError';
  }
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

export function repoRoot(cwd: string): string {
  return gitOut(cwd, ['rev-parse', '--show-toplevel']);
}

export function refExists(cwd: string, ref: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code === 0;
}

export function revParse(cwd: string, ref: string): string {
  return gitOut(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Nomes de arquivos alterados entre dois commits (sem rastrear renomeações). */
export function changedFiles(cwd: string, from: string, to: string): string[] {
  const out = git(cwd, ['diff', '--name-only', '-z', '--no-renames', from, to]);
  if (out.code !== 0) return [];
  return out.stdout.split('\0').filter(Boolean);
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).code === 0;
}

export function mergeBase(cwd: string, a: string, b: string): string | null {
  const res = git(cwd, ['merge-base', a, b]);
  return res.code === 0 ? res.stdout.trim() : null;
}

export function countCommits(cwd: string, range: string): number {
  const res = git(cwd, ['rev-list', '--count', range]);
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

const MERGE_IDENTITY = {
  GIT_AUTHOR_NAME: 'safemerge',
  GIT_AUTHOR_EMAIL: 'safemerge@localhost',
  GIT_COMMITTER_NAME: 'safemerge',
  GIT_COMMITTER_EMAIL: 'safemerge@localhost',
};

/**
 * Commit (solto, sem branch) com o resultado do merge, ou null se há conflito de texto.
 * Só cria objetos no banco do git; nenhuma referência, índice ou arquivo do usuário muda.
 */
export function mergeCommit(cwd: string, headRef: string, targetRef: string): string | null {
  const mt = git(cwd, ['merge-tree', '--write-tree', headRef, targetRef]);
  if (mt.code !== 0) return null;
  const tree = mt.stdout.split('\n')[0]!.trim();
  const made = git(cwd, ['commit-tree', tree, '-p', headRef, '-p', targetRef, '-m', 'merge simulado pelo safemerge'], { env: MERGE_IDENTITY });
  return made.code === 0 ? made.stdout.trim() : null;
}

/** Renomeações entre dois commits (detecção do git, similaridade padrão de 50%). */
export function renamedFiles(cwd: string, from: string, to: string): Array<{ from: string; to: string }> {
  const res = git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '-M', '--diff-filter=R', from, to]);
  if (res.code !== 0) return [];
  const parts = res.stdout.split('\0').filter(Boolean);
  const out: Array<{ from: string; to: string }> = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (!parts[i]?.startsWith('R')) break;
    out.push({ from: parts[i + 1]!, to: parts[i + 2]! });
  }
  return out;
}

/**
 * Por que esta pasta não pode ser analisada, em português e dizendo o que fazer; null se está tudo certo.
 * Distingue pasta sem git, git não instalado e pasta recusada pelo git por segurança.
 */
export function repoProblem(cwd: string): string | null {
  const res = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  const err = res.stderr.trim();
  if (res.code === 0 && res.stdout.trim() === 'true') return null;
  if (res.code === 127 || /ENOENT|not recognized|não é reconhecido/i.test(err)) {
    return 'o git não foi encontrado neste computador. Instale em https://git-scm.com e reabra o editor.';
  }
  if (/dubious ownership|safe\.directory/i.test(err)) {
    return `o git recusou a pasta por segurança ("dubious ownership"): ela pertence a outro usuário do computador. Para liberar, rode: git config --global --add safe.directory "${cwd.split('\\').join('/')}"`;
  }
  if (res.code === 0) {
    return `a pasta ${cwd} está dentro da pasta .git ou é um repositório sem arquivos de trabalho (bare). Abra a pasta do projeto.`;
  }
  if (/not a git repository/i.test(err)) {
    return `a pasta ${cwd} não é um repositório git (não há .git nela nem em nenhuma pasta acima). Abra a pasta do projeto (no VS Code: Arquivo > Abrir Pasta) ou crie o repositório com "git init".`;
  }
  return `o git não conseguiu ler a pasta ${cwd}: ${err.split('\n')[0] || `saiu com código ${res.code}`}`;
}
