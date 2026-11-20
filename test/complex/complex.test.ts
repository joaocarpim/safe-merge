/**
 * Teste de aceitação no cenário de produção complexo (examples/make-demo-complex.sh): cada branch tem um
 * gabarito (test/complex/expected.json). Mede acertividade (situações plantadas detectadas, veredito
 * certo, alarmes falsos) e tempo. Rodar: npm run test:complex (leva ~1-2 min: cria o repositório).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { analyze, type AnalysisReport } from '../../src/analyze.ts';
import { loadConfig } from '../../src/config.ts';
import { parsePrList } from '../../src/github.ts';
import type { ToolRunner } from '../../src/tools.ts';

interface Expect { nivel: 'ok' | 'warn' | 'block'; deve: string[]; nao?: string[] }
const root = join(import.meta.dirname, '..', '..');
const expected = JSON.parse(readFileSync(join(import.meta.dirname, 'expected.json'), 'utf8')) as { branches: Record<string, Expect> };
// sem ferramentas externas: o resultado não depende do que estiver instalado na máquina
const noTools: ToolRunner = () => ({ missing: true, code: 127, stdout: '', stderr: '', timedOut: false });

let tmp = '';
let repo = '';
const results: Array<{ branch: string; ok: boolean; hit: number; total: number; fp: string[]; ms: number; level: string }> = [];

/** Tudo que um item do gabarito pode casar: motivos do veredito e regras dos achados. */
function haystack(r: AnalysisReport): string[] {
  return [...r.verdict.reasons.map((x) => `${x.level}: ${x.text}`), ...r.findings.filter((f) => f.level !== 'info').map((f) => `${f.level}: ${f.category}/${f.rule}`)];
}

describe('cenário de produção complexo', () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sm-complexo-'));
    repo = join(tmp, 'repo');
    const made = spawnSync('bash', [join(root, 'examples', 'make-demo-complex.sh'), repo], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
  });
  after(() => {
    const planted = results.reduce((n, r) => n + r.total, 0);
    const hit = results.reduce((n, r) => n + r.hit, 0);
    const levels = results.filter((r) => r.ok).length;
    const fps = results.flatMap((r) => r.fp.map((f) => `${r.branch}: ${f}`));
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    console.log('\n── placar de acertividade ─────────────────────────────────');
    console.log(`situações plantadas detectadas: ${hit}/${planted}`);
    console.log(`veredito certo:                 ${levels}/${results.length} branches`);
    console.log(`alarmes falsos:                 ${fps.length}${fps.length ? `\n  ${fps.join('\n  ')}` : ''}`);
    if (ms.length) console.log(`tempo por branch:               mediana ${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(2)}s, máx ${(ms.at(-1)! / 1000).toFixed(2)}s`);
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const [branch, exp] of Object.entries(expected.branches)) {
    it(`${branch}: ${exp.nivel}, ${exp.deve.length} situação(ões)`, () => {
      const cfg = loadConfig(repo);
      const t0 = performance.now();
      const r = analyze({
        cwd: repo,
        cfg,
        head: branch,
        fetch: false,
        tools: noTools,
        listPrs: () => ({ prs: parsePrList(readFileSync(join(repo, 'prs.json'), 'utf8')) }),
      });
      const ms = performance.now() - t0;
      const hay = haystack(r);
      const missing = exp.deve.filter((d) => !hay.some((h) => h.includes(d)));
      const fp = (exp.nao ?? []).filter((n) => (n === 'block' ? r.verdict.level === 'block' : hay.some((h) => h.includes(n))));
      results.push({ branch, ok: r.verdict.level === exp.nivel, hit: exp.deve.length - missing.length, total: exp.deve.length, fp, ms, level: r.verdict.level });
      assert.deepEqual(missing, [], `não detectou:\n${missing.join('\n')}\n\nmotivos e regras:\n${hay.join('\n')}`);
      assert.deepEqual(fp, [], `alarme falso: ${fp.join(', ')}`);
      assert.equal(r.verdict.level, exp.nivel, hay.join('\n'));
    });
  }
});
