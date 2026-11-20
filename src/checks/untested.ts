import { posix } from 'node:path';
import { addedLines, listTree } from '../diff.js';
import type { FindingDraft } from '../findings.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|py|go|rb|php|java|kt|cs|rs)$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.(go|py|rb|exs?)$/i;
const NOT_LOGIC = /(^|\/)(migrations?|db\/migrate|scripts?|config|\.github)\/|\.config\.[^/]+$|\.d\.ts$/;

function stem(path: string): string {
  return posix.basename(path).replace(/\.[^.]+$/, '').toLowerCase();
}

/** Há teste "com o nome" do arquivo? (`service.ts` → `service.test.ts`, `test_service.py`, `service_test.go`…) */
export function hasNamedTest(file: string, tests: string[]): boolean {
  const s = stem(file);
  if (s === 'index' || s === 'main' || s === 'mod' || s === 'app') {
    // nomes genéricos: exige teste na mesma pasta ou com o nome da pasta
    const dir = posix.basename(posix.dirname(file)).toLowerCase();
    return tests.some((t) => posix.dirname(t) === posix.dirname(file) || t.toLowerCase().includes(dir));
  }
  return tests.some((t) => {
    const b = posix.basename(t).toLowerCase();
    return b.startsWith(`${s}.`) || b.startsWith(`${s}_`) || b.startsWith(`${s}-`) || b === `test_${s}.py` || b.startsWith(`test_${s}`);
  });
}

/**
 * Arquivos de código alterados sem nenhum teste com o nome deles. É uma heurística de nome, não de
 * cobertura medida: serve para avisar que a checagem semântica provavelmente não exercita essas linhas.
 */
export const untestedCheck: Check = {
  id: 'untested',
  label: 'Linhas alteradas sem teste',
  run(ctx: CheckContext): CheckOutput {
    const added = addedLines(ctx.cwd, ctx.mergeBase, ctx.headRef).filter((l) => CODE_FILE.test(l.file) && !TEST_FILE.test(l.file) && !NOT_LOGIC.test(l.file));
    if (added.length === 0) {
      return { coverage: { check: this.id, label: this.label, status: 'skipped', reason: 'nenhuma linha de código nova fora de testes' }, findings: [] };
    }
    const tests = listTree(ctx.cwd, ctx.headRef).filter((p) => TEST_FILE.test(p));
    const byFile = new Map<string, typeof added>();
    for (const l of added) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);
    const findings: FindingDraft[] = [];
    for (const [file, lines] of byFile) {
      if (hasNamedTest(file, tests)) continue;
      findings.push({
        category: 'coverage-gap',
        rule: 'no-named-test',
        title: 'Código alterado sem teste correspondente',
        message: `${lines.length} linha(s) nova(s) em ${file} e nenhum arquivo de teste com o nome dele. A checagem semântica (testes no merge) provavelmente não cobre essas linhas.`,
        severity: 'low',
        confidence: 'low',
        file,
        line: lines[0]!.line,
        evidence: `${lines.length} linha(s) nova(s); nenhum teste com "${stem(file)}" no nome`,
        source: 'safemerge',
      });
    }
    return {
      coverage: { check: this.id, label: this.label, status: 'ran', reason: `heurística por nome de arquivo; ${byFile.size} arquivo(s) de código alterado(s), ${tests.length} arquivo(s) de teste no projeto` },
      findings,
    };
  },
};
