import { posix } from 'node:path';
import { addedLines, parseAddedLines } from '../diff.js';
import { clip, type FindingDraft } from '../findings.js';
import { git } from '../git.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|py|go)$/;

/** Nomes exportados/definidos numa linha de código (JS/TS, Python, Go). */
export function definedNames(line: string): string[] {
  const out: string[] = [];
  const patterns = [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/,
    /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/,
    /^\s*class\s+([A-Za-z_$][\w$]*)/,
    /^def\s+([A-Za-z_]\w*)\s*\(/,
    /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\(/,
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (m) out.push(m[1]!);
  }
  const block = line.match(/^\s*module\.exports\s*=\s*\{([^}]*)\}/);
  if (block) for (const part of block[1]!.split(',')) {
    const name = part.split(':')[0]!.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
  }
  return [...new Set(out)];
}

function removedLines(cwd: string, from: string, to: string): Array<{ file: string; text: string }> {
  // linhas apagadas = linhas "acrescentadas" no diff invertido
  const res = git(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U0', '--no-renames', to, from]);
  return res.code === 0 ? parseAddedLines(res.stdout).map((l) => ({ file: l.file, text: l.text })) : [];
}

/** O nome ainda está definido em algum arquivo de código do commit? */
function stillDefined(cwd: string, rev: string, name: string): boolean {
  const res = git(cwd, ['grep', '-h', '-w', '-F', name, rev, '--', '*.js', '*.jsx', '*.ts', '*.tsx', '*.mjs', '*.cjs', '*.mts', '*.cts', '*.vue', '*.svelte', '*.py', '*.go']);
  if (res.code !== 0) return false;
  return res.stdout.split('\n').some((l) => definedNames(l).includes(name));
}

/**
 * Conflito semântico sem rodar teste: o destino removeu ou renomeou uma função/constante exportada
 * e a sua branch acrescenta linhas que ainda usam o nome antigo. O git junta sem conflito de texto;
 * o resultado quebra em tempo de execução (ou no build).
 */
export const symbolsCheck: Check = {
  id: 'symbols',
  label: 'Funções removidas no destino e usadas pela branch',
  run(ctx: CheckContext): CheckOutput {
    const removed = new Map<string, string>(); // nome → arquivo de onde saiu
    for (const l of removedLines(ctx.cwd, ctx.mergeBase, ctx.target.ref)) {
      if (!CODE_FILE.test(l.file)) continue;
      for (const name of definedNames(l.text)) if (name.length > 2 && !removed.has(name)) removed.set(name, l.file);
    }
    for (const name of [...removed.keys()]) if (stillDefined(ctx.cwd, ctx.target.ref, name)) removed.delete(name);
    if (removed.size === 0) {
      return { coverage: { check: this.id, label: this.label, status: 'skipped', reason: `${ctx.target.name} não removeu nenhuma função ou constante exportada` }, findings: [] };
    }

    const ours = addedLines(ctx.cwd, ctx.mergeBase, ctx.headRef).filter((l) => CODE_FILE.test(l.file));
    // se a sua branch define o nome de novo, não é uso do nome antigo
    const redefined = new Set(ours.flatMap((l) => definedNames(l.text)));
    const best = new Map<string, { line: (typeof ours)[number]; fromImport: boolean; name: string; origin: string }>();
    for (const [name, origin] of removed) {
      if (redefined.has(name)) continue;
      const re = new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
      const stem = posix.basename(origin).replace(/\.[^.]+$/, '');
      for (const l of ours) {
        if (!re.test(l.text)) continue;
        const fromImport = /\b(require|import|from)\b/.test(l.text) && l.text.includes(stem);
        const key = `${name}\u0000${l.file}`;
        const prev = best.get(key);
        if (!prev || (fromImport && !prev.fromImport)) best.set(key, { line: l, fromImport, name, origin });
      }
    }
    const findings: FindingDraft[] = [...best.values()].map(({ line, fromImport, name, origin }) => ({
      category: 'semantic',
      rule: 'removed-symbol-used',
      title: `Usa ${name}, que não existe mais em ${ctx.target.name}`,
      message: `${ctx.target.name} removeu ou renomeou ${name} (${origin}), e esta branch acrescenta código que ainda usa o nome antigo. O merge junta sem conflito de texto, mas quebra ao rodar.${fromImport ? '' : ' Pode ser outro símbolo com o mesmo nome: confira.'}`,
      severity: 'high',
      confidence: fromImport ? 'medium' : 'low',
      file: line.file,
      line: line.line,
      evidence: clip(line.text),
      source: 'safemerge',
    }));
    return {
      coverage: { check: this.id, label: this.label, status: 'ran', reason: `${removed.size} nome(s) removido(s) em ${ctx.target.name}; heurística por nome (JS/TS, Python, Go)` },
      findings,
    };
  },
};
