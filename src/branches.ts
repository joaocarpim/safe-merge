import type { Config } from './config.js';
import { git, gitOut } from './git.js';

export interface BranchRef {
  /** Nome curto, sem remoto: `dev`. */
  name: string;
  /** Referência completa usada nas comparações. */
  ref: string;
}

export interface BranchMap {
  remote: string | null;
  /** Todas as branches conhecidas; a do remoto vence a local de mesmo nome. */
  all: Map<string, BranchRef>;
}

export interface DetectedBranches {
  remote: string | null;
  default: BranchRef | null;
  /** Branches principais, a padrão primeiro. */
  main: BranchRef[];
  /** Para onde feature/fix devem apontar. */
  integration: BranchRef | null;
}

export function currentBranch(cwd: string): string | null {
  const res = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return res.code === 0 ? res.stdout.trim() : null;
}

export function pickRemote(cwd: string, preferred?: string): string | null {
  const remotes = gitOut(cwd, ['remote']).split('\n').filter(Boolean);
  if (preferred) return remotes.includes(preferred) ? preferred : null;
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] ?? null;
}

function forEachRef(cwd: string, prefix: string): string[] {
  const out = git(cwd, ['for-each-ref', '--format=%(refname)', prefix]);
  return out.code === 0 ? out.stdout.split('\n').filter(Boolean) : [];
}

export function listBranches(cwd: string, remote: string | null): BranchMap {
  const all = new Map<string, BranchRef>();
  for (const ref of forEachRef(cwd, 'refs/heads/')) {
    const name = ref.slice('refs/heads/'.length);
    all.set(name, { name, ref });
  }
  if (remote) {
    const prefix = `refs/remotes/${remote}/`;
    for (const ref of forEachRef(cwd, prefix)) {
      const name = ref.slice(prefix.length);
      if (name === 'HEAD') continue;
      all.set(name, { name, ref });
    }
  }
  return { remote, all };
}

function defaultBranchName(cwd: string, remote: string | null, known: Set<string>): string | null {
  if (remote) {
    const res = git(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
    if (res.code === 0) {
      const name = res.stdout.trim().slice(`refs/remotes/${remote}/`.length);
      if (known.has(name)) return name;
    }
  }
  for (const guess of ['main', 'master', 'develop', 'dev']) {
    if (known.has(guess)) return guess;
  }
  return null;
}

export function detectBranches(cwd: string, cfg: Config, branches: BranchMap): DetectedBranches {
  const names = new Set(branches.all.keys());
  const patterns = cfg.mainBranchPatterns.map((p) => new RegExp(`^(?:${p})$`));
  const defaultName = defaultBranchName(cwd, branches.remote, names);

  const ordered: string[] = [];
  const push = (name: string) => {
    if (names.has(name) && !ordered.includes(name)) ordered.push(name);
  };
  if (defaultName) push(defaultName);
  for (const pattern of patterns) {
    for (const name of [...names].sort()) {
      if (pattern.test(name)) push(name);
    }
  }

  const main = ordered.map((n) => branches.all.get(n)!);
  const integrationName = cfg.integrationPriority.find((n) => ordered.includes(n)) ?? defaultName;
  return {
    remote: branches.remote,
    default: defaultName ? (branches.all.get(defaultName) ?? null) : null,
    main,
    integration: integrationName ? (branches.all.get(integrationName) ?? null) : null,
  };
}

export interface Divergence {
  branch: string;
  /** Commits na branch local que não estão no remoto (não enviados). */
  localAhead: number;
  /** Commits no remoto que a branch local não tem (push de outra pessoa ou de outra máquina). */
  remoteAhead: number;
}

/**
 * Para cada nome que existe como branch local e no remoto, conta quanto um está à frente do outro.
 * Branches iguais, só locais ou só remotas ficam de fora.
 */
export function localDivergence(cwd: string, remote: string | null, names: string[]): Divergence[] {
  if (!remote) return [];
  const out: Divergence[] = [];
  for (const branch of [...new Set(names)]) {
    const local = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const res = git(cwd, ['rev-list', '--left-right', '--count', `${local}...${remoteRef}`]);
    if (res.code !== 0) continue; // uma das duas não existe
    const [ahead = 0, behind = 0] = res.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    if (ahead === 0 && behind === 0) continue;
    out.push({ branch, localAhead: ahead, remoteAhead: behind });
  }
  return out;
}

/** Busca no remoto. Só atualiza referências de acompanhamento; nunca altera branches locais. */
export function fetchRemote(cwd: string, remote: string): { ok: boolean; message: string } {
  const res = git(cwd, ['fetch', '--quiet', '--prune', remote], { timeoutMs: 300_000 });
  return res.code === 0 ? { ok: true, message: '' } : { ok: false, message: res.stderr.trim() };
}
