import { git } from './git.js';

/**
 * Contrato de API entre repositórios (front × back): rotas que a branch do back cria ou remove, e onde o
 * front chama essas rotas. Heurística por texto (Express, Fastify, Koa, Nest, FastAPI, Flask, Django no
 * back; fetch, axios e clientes parecidos no front): por isso só avisa, nunca bloqueia.
 */

export interface Route {
  method: string;
  path: string;
  file: string;
}

export interface ClientCall {
  method: string;
  path: string;
  file: string;
  line: number;
  text: string;
}

const SERVER_FILE = /\.(m?[jt]s|py)$/;
const CLIENT_FILE = /\.(m?[jt]sx?|vue|svelte|dart)$/;
const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage|__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$/;

/** Caminho comparável: sem host, sem query, parâmetros viram ":p", sem barra no fim. */
export function normalizePath(raw: string): string | null {
  let p = raw.trim();
  p = p.replace(/^\$\{[^}]+\}/, ''); // `${API_URL}/x`
  p = p.replace(/^https?:\/\/[^/]+/, '');
  p = p.split('?')[0]!.split('#')[0]!;
  if (!p.startsWith('/')) p = `/${p}`;
  p = p
    .replace(/\$\{[^}]+\}/g, ':p')
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/<[^>]+>/g, ':p')
    .replace(/:[A-Za-z_]\w*/g, ':p')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (p === '' || p === '/' || !/[a-z]/.test(p)) return null;
  return p;
}

/** Rotas definidas num arquivo do servidor. */
export function serverRoutes(file: string, text: string): Route[] {
  if (!SERVER_FILE.test(file) || SKIP.test(file)) return [];
  const out: Route[] = [];
  const push = (method: string, raw: string, prefix = '') => {
    const path = normalizePath(`${prefix}/${raw}`.replace(/\/+/g, '/'));
    if (path) out.push({ method: method.toUpperCase(), path, file });
  };
  for (const m of text.matchAll(/\b(?:router|app|server|fastify|api|routes?)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) push(m[1]!, m[2]!);
  const controller = /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(text)?.[1] ?? '';
  for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) push(m[1]!, m[2] ?? '', controller);
  for (const m of text.matchAll(/@(?:app|router|bp|blueprint|api)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) push(m[1]!, m[2]!);
  for (const m of text.matchAll(/@(?:app|bp|blueprint)\.route\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g)) {
    const methods = m[2] ? [...m[2].matchAll(/['"](\w+)['"]/g)].map((x) => x[1]!) : ['GET'];
    for (const method of methods) push(method, m[1]!);
  }
  if (/urls?\.py$/.test(file)) for (const m of text.matchAll(/\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]/g)) push('ANY', m[1]!);
  // @router.get(...) casa com dois padrões: uma vez só
  return out.filter((r, i) => out.findIndex((x) => x.method === r.method && x.path === r.path) === i);
}

/** Chamadas HTTP do cliente para caminhos da própria API. */
export function clientCalls(file: string, text: string): ClientCall[] {
  if (!CLIENT_FILE.test(file) || SKIP.test(file)) return [];
  const out: ClientCall[] = [];
  const lines = text.split('\n');
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => [string, string]]> = [
    [/\bfetch\(\s*[`'"]([^`'"]+)[`'"](?:\s*,\s*\{[^}]*method\s*:\s*['"](\w+)['"])?/, (m) => [m[2] ?? 'GET', m[1]!]],
    [/\b(?:axios|api|http|client|request|\$http|httpClient|instance)\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)[`'"]/i, (m) => [m[1]!, m[2]!]],
    [/\buse(?:Query|SWR|Fetch)\(\s*[`'"]([^`'"]+)[`'"]/, (m) => ['GET', m[1]!]],
  ];
  lines.forEach((l, i) => {
    for (const [re, pick] of patterns) {
      const m = l.match(re);
      if (!m) continue;
      const [method, raw] = pick(m);
      if (/^https?:\/\//.test(raw) && !/\/api\//.test(raw)) continue; // serviço de terceiros
      const path = normalizePath(raw);
      if (path) out.push({ method: method.toUpperCase(), path, file, line: i + 1, text: l.trim().slice(0, 160) });
    }
  });
  return out;
}

/** Duas rotas casam se o caminho é igual ou um termina com o outro (prefixo /api, versão…). */
export function sameRoute(a: { method: string; path: string }, b: { method: string; path: string }): boolean {
  const methodOk = a.method === b.method || a.method === 'ANY' || b.method === 'ANY';
  return methodOk && (a.path === b.path || a.path.endsWith(b.path) || b.path.endsWith(a.path));
}

function filesChanged(cwd: string, from: string, to: string): string[] {
  return git(cwd, ['diff', '--name-only', '--no-renames', from, to]).stdout.split('\n').filter(Boolean);
}

function show(cwd: string, rev: string, file: string): string {
  const r = git(cwd, ['show', `${rev}:${file}`]);
  return r.code === 0 ? r.stdout : '';
}

/** Rotas que a branch do back acrescenta e remove (só nos arquivos que ela mudou). */
export function routeChanges(cwd: string, base: string, head: string): { added: Route[]; removed: Route[] } {
  const added: Route[] = [];
  const removed: Route[] = [];
  for (const file of filesChanged(cwd, base, head).filter((f) => SERVER_FILE.test(f))) {
    const before = serverRoutes(file, show(cwd, base, file));
    const after = serverRoutes(file, show(cwd, head, file));
    for (const r of after) if (!before.some((b) => b.method === r.method && b.path === r.path)) added.push(r);
    for (const r of before) if (!after.some((a) => a.method === r.method && a.path === r.path)) removed.push(r);
  }
  // rota que só mudou de arquivo não conta
  return { added: added.filter((a) => !removed.some((r) => sameRoute(a, r))), removed: removed.filter((r) => !added.some((a) => sameRoute(a, r))) };
}

/** Todas as rotas definidas numa versão do back (para saber se uma rota já existe no destino). */
export function allRoutes(cwd: string, rev: string): Route[] {
  const files = git(cwd, ['grep', '-l', '-E', '\\.(get|post|put|patch|delete)\\(|@(Get|Post|Put|Patch|Delete|Controller)\\(|\\.route\\(|path\\(', rev, '--']).stdout.split('\n').filter(Boolean).map((l) => l.slice(rev.length + 1));
  return files.flatMap((f) => serverRoutes(f, show(cwd, rev, f)));
}

/** Chamadas do front numa versão (arquivos que citam fetch/axios/clientes). */
export function allClientCalls(cwd: string, rev: string): ClientCall[] {
  const files = git(cwd, ['grep', '-l', '-E', 'fetch\\(|axios|\\.(get|post|put|patch|delete)\\(|use(Query|SWR|Fetch)\\(', rev, '--']).stdout.split('\n').filter(Boolean).map((l) => l.slice(rev.length + 1));
  return files.flatMap((f) => clientCalls(f, show(cwd, rev, f)));
}

export interface ContractIssue {
  kind: 'removed-used' | 'new-needed';
  backRepo: string;
  backBranch: string;
  frontRepo: string;
  frontBranch: string;
  method: string;
  route: string;
  /** Onde o front chama a rota. */
  file: string;
  line: number;
  evidence: string;
  message: string;
}

export interface RepoSide {
  name: string;
  cwd: string;
  branch: string;
  head: string;
  /** Destino da branch (merge-base com ele define o que a branch mudou). */
  base: string;
}

/**
 * Cruza uma branch do back com uma do front.
 * - removed-used: a branch do back remove uma rota que o front (na branch dele) ainda chama.
 * - new-needed: a branch do front chama uma rota que não existe no destino do back, mas a branch do back cria.
 */
export function crossCheck(back: RepoSide, front: RepoSide): ContractIssue[] {
  const mb = git(back.cwd, ['merge-base', back.base, back.head]).stdout.trim();
  if (!mb) return [];
  const { added, removed } = routeChanges(back.cwd, mb, back.head);
  if (added.length === 0 && removed.length === 0) return [];
  const calls = allClientCalls(front.cwd, front.head);
  const out: ContractIssue[] = [];
  const base = { backRepo: back.name, backBranch: back.branch, frontRepo: front.name, frontBranch: front.branch };
  for (const r of removed) {
    const c = calls.find((x) => sameRoute(x, r));
    if (c) out.push({ ...base, kind: 'removed-used', method: r.method, route: r.path, file: c.file, line: c.line, evidence: c.text, message: `${back.name}/${back.branch} remove ${r.method} ${r.path} (${r.file}), que ${front.name}/${front.branch} ainda chama em ${c.file}:${c.line}. Ajuste o front antes de mergear o back (ou entrem juntos).` });
  }
  if (added.length > 0) {
    const existing = allRoutes(back.cwd, back.base);
    for (const r of added) {
      const c = calls.find((x) => sameRoute(x, r));
      if (c && !existing.some((e) => sameRoute(e, r))) out.push({ ...base, kind: 'new-needed', method: r.method, route: r.path, file: c.file, line: c.line, evidence: c.text, message: `${front.name}/${front.branch} chama ${r.method} ${r.path} (${c.file}:${c.line}), que só existe em ${back.name}/${back.branch}. O back precisa entrar antes do front.` });
    }
  }
  return out;
}
