import { spawnSync } from 'node:child_process';

export interface PrInfo {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  headRefName: string;
  url: string;
  /** Descrição do PR (vazia se o gh não trouxe). */
  body?: string;
}

interface RawPr {
  number?: number;
  title?: string;
  headRefName?: string;
  isDraft?: boolean;
  url?: string;
  author?: { login?: string } | null;
  body?: string;
}

/** Interpreta a saída JSON de `gh pr list`. Ignora entradas incompletas. */
export function parsePrList(json: string): PrInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PrInfo[] = [];
  for (const item of raw as RawPr[]) {
    if (typeof item.number !== 'number' || !item.headRefName) continue;
    out.push({
      number: item.number,
      title: item.title ?? '',
      author: item.author?.login ?? 'desconhecido',
      draft: item.isDraft === true,
      headRefName: item.headRefName,
      url: item.url ?? '',
      ...(typeof item.body === 'string' ? { body: item.body } : {}),
    });
  }
  return out;
}

export interface PrListing {
  prs: PrInfo[];
  /** Motivo de não ter listado, quando for o caso. */
  warning?: string;
}

/** Lista PRs abertas com o `gh`. Só leitura; se o `gh` faltar ou não estiver logado, segue sem PRs. */
export function listOpenPrs(cwd: string): PrListing {
  const proc = spawnSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,isDraft,url,author,body'],
    { cwd, encoding: 'utf8', timeout: 60_000 },
  );
  if (proc.error) return { prs: [], warning: 'gh não encontrado; PRs não foram associadas às branches' };
  if (proc.status !== 0) {
    const first = (proc.stderr ?? '').trim().split('\n')[0] ?? '';
    return { prs: [], warning: `gh não conseguiu listar PRs${first ? `: ${first}` : ''}` };
  }
  return { prs: parsePrList(proc.stdout ?? '') };
}
