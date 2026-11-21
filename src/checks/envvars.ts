import { posix } from 'node:path';
import { addedLines, listTree, showFile, type AddedLine } from '../diff.js';
import { clip, type FindingDraft } from '../findings.js';
import { git } from '../git.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|py|go|rb|php|java|kt|cs|rs|ex|exs)$/;
const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'example.env']);
const IGNORED = new Set(['NODE_ENV', 'CI', 'PORT', 'HOME', 'PATH', 'PWD', 'TZ', 'DEBUG', 'USER', 'SHELL', 'LANG', 'TERM']);

const PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.environ(?:\.get)?\(?\s*\[?\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /ENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
];

export interface EnvUse {
  name: string;
  at: AddedLine;
}

/** Variáveis de ambiente lidas nas linhas acrescentadas (primeira ocorrência de cada uma). */
export function envUses(lines: AddedLine[]): EnvUse[] {
  const seen = new Map<string, EnvUse>();
  for (const l of lines) {
    if (!CODE_FILE.test(l.file)) continue;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      for (const m of l.text.matchAll(re)) {
        const name = m[1]!;
        if (!IGNORED.has(name) && !seen.has(name)) seen.set(name, { name, at: l });
      }
    }
  }
  return [...seen.values()];
}

export function documentedIn(text: string, name: string): boolean {
  // vale também a linha comentada (# NOME=): é a convenção para variável opcional
  return new RegExp(`^\\s*#?\\s*(export\\s+)?${name}\\s*=`, 'm').test(text);
}

/**
 * Variáveis de ambiente que a branch passa a exigir. Se não estão no .env.example, quem fizer o deploy
 * não sabe que precisa configurar; se estão, o aviso é só para lembrar de configurar em cada ambiente.
 */
export const envVarsCheck: Check = {
  id: 'env',
  label: 'Variáveis de ambiente novas',
  run(ctx: CheckContext): CheckOutput {
    const uses = envUses(addedLines(ctx.cwd, ctx.mergeBase, ctx.headRef));
    // só as que não existiam em lugar nenhum do projeto no ponto de partida
    const fresh = uses.filter((u) => git(ctx.cwd, ['grep', '-q', '-w', '-F', u.name, ctx.mergeBase, '--']).code !== 0);
    const examples = listTree(ctx.cwd, ctx.headRef).filter((p) => ENV_EXAMPLES.has(posix.basename(p)));
    const exampleTexts = examples.map((p) => ({ path: p, text: showFile(ctx.cwd, ctx.headRef, p) ?? '' }));
    const findings: FindingDraft[] = fresh.map((u) => {
      const doc = exampleTexts.find((e) => documentedIn(e.text, u.name));
      const base = { category: 'env', file: u.at.file, line: u.at.line, evidence: clip(u.at.text), source: 'safemerge' } as const;
      return doc
        ? {
            ...base,
            rule: 'new-variable',
            title: `Variável de ambiente nova: ${u.name}`,
            message: `A branch passa a ler ${u.name} (documentada em ${doc.path}). Configure em todos os ambientes antes do deploy.`,
            // documentada: é lembrete de deploy, não aviso (não deve rebaixar uma branch limpa)
            severity: 'info',
            confidence: 'high',
          }
        : {
            ...base,
            rule: 'undocumented-variable',
            title: `Variável de ambiente nova sem documentação: ${u.name}`,
            message: `A branch passa a ler ${u.name}, que não aparece em ${examples.length > 0 ? examples.join(', ') : 'nenhum .env.example'}. Quem fizer o deploy não vai saber que precisa configurar.`,
            severity: 'medium',
            confidence: 'medium',
          };
    });
    // muitas variáveis já documentadas: um resumo só
    const documented = findings.filter((f) => f.rule === 'new-variable');
    if (documented.length > 5) {
      const rest = findings.filter((f) => f.rule !== 'new-variable');
      const first = documented[0]!;
      findings.splice(0, findings.length, ...rest, {
        ...first,
        title: `${documented.length} variáveis de ambiente novas (todas documentadas)`,
        message: `A branch passa a ler ${documented.length} variáveis de ambiente novas, todas no .env.example (ex.: ${documented.slice(0, 4).map((f) => f.title.split(': ')[1]).join(', ')}…). Configure em todos os ambientes antes do deploy.`,
        evidence: `${documented.length} variáveis documentadas`,
      });
    }
    const reason = uses.length === 0 ? 'nenhuma leitura de variável de ambiente nas linhas novas' : `${uses.length} variável(is) lida(s) nas linhas novas, ${fresh.length} nova(s) no projeto`;
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason }, findings };
  },
};
