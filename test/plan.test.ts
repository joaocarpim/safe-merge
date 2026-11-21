// Plano para mergear (por branch) e ordem de merge (várias branches): determinísticos, só do relatório.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPlan, errorLocation, mergeOrder, renderPlanMarkdown, type PlanInput } from '../src/plan.ts';

const base: PlanInput = {
  head: { name: 'feat/pix' },
  remote: 'origin',
  primary: 'dev',
  targets: [{ target: 'dev', status: 'clean', behind: 2, ahead: 3, conflicts: [] }],
  overlaps: [],
  semantic: [],
  findings: [],
  coverage: [],
  verdict: { level: 'ok' },
};

const finding = (over: Record<string, unknown>) => ({
  id: 'SM-1', category: 'secret', rule: 'r', title: 'Segredo', message: 'troque', severity: 'high', confidence: 'high', file: 'a.js', line: 3, evidence: 'KEY=…', source: 'safemerge', level: 'block', ...over,
}) as PlanInput['findings'][number];

describe('plano para mergear', () => {
  it('branch limpa: um passo só, "pode mergear"', () => {
    const p = buildPlan(base);
    assert.deepEqual(p.map((s) => [s.n, s.kind]), [[1, 'done']]);
  });

  it('ordem fixa: stack, atualizar, conflito, testes, bloqueio, aviso, combinar, sugestão, analisar de novo', () => {
    const p = buildPlan({
      ...base,
      targets: [{ target: 'dev', status: 'conflict', behind: 40, ahead: 1, conflicts: [{ path: 'src/a.js', hunks: [{ oursLine: 7 }] }, { path: 'package-lock.json', hint: 'regenerate-lockfile', hunks: [] }] }],
      overlaps: [
        { branch: 'feat/base', pr: { number: 300 }, relation: 'ours-contains-theirs', wouldConflict: false, conflictFiles: [], sameFunctions: [], stackDepth: 5 },
        { branch: 'feat/raiz', pr: null, relation: 'ours-contains-theirs', wouldConflict: false, conflictFiles: [], sameFunctions: [], stackDepth: 2 },
        { branch: 'fix/y', pr: { number: 88 }, relation: 'independent', wouldConflict: true, conflictFiles: ['src/b.js'], sameFunctions: [] },
      ],
      semantic: [{ target: 'dev', status: 'failed', cause: 'semantic-conflict', command: 'npm test', outputTail: 'TypeError: x\n    at f (./src/c.js:9:3)' }],
      findings: [finding({ level: 'warn', id: 'SM-2', title: 'Aviso', category: 'env' }), finding({}), finding({ level: 'info', id: 'SM-3', title: 'Obs' })].sort((a, b) => (a.level === 'block' ? -1 : b.level === 'block' ? 1 : 0)),
      coverage: [{ check: 'semantic', status: 'ran' }],
    });
    assert.deepEqual(p.map((s) => s.kind), ['order', 'update', 'conflict', 'lockfile', 'tests', 'finding', 'finding', 'coordinate', 'recheck']);
    assert.match(p[0]!.title, /Mergear #300 \(feat\/base\) antes/, 'a base mais próxima da stack');
    assert.equal(p[1]!.command, 'git fetch && git rebase origin/dev');
    assert.equal(p[2]!.file, 'src/a.js');
    assert.equal(p[2]!.line, 7);
    assert.equal(p[2]!.ai, true);
    assert.equal(p[3]!.command, 'git checkout --theirs package-lock.json && npm install');
    assert.deepEqual([p[4]!.file, p[4]!.line, p[4]!.level], ['src/c.js', 9, 'block']);
    assert.deepEqual(p.filter((s) => s.kind === 'finding').map((s) => s.title), ['Segredo', 'Aviso'], 'observação não vira passo');
    assert.match(p[7]!.title, /Combinar a ordem de merge com #88/);
  });

  it('sem testes, sugere rodar com o comando detectado', () => {
    const p = buildPlan({ ...base, findings: [finding({ level: 'warn' })], coverage: [{ check: 'semantic', status: 'skipped', reason: 'sem comando de testes; detectei "pytest" no projeto' }] });
    const s = p.find((x) => x.kind === 'suggestion')!;
    assert.equal(s.command, 'safemerge --test-cmd "pytest"');
  });

  it('markdown do plano numerado, com evidência e comando', () => {
    const md = renderPlanMarkdown(buildPlan({ ...base, findings: [finding({})] }), 'feat/pix', 'dev');
    assert.match(md, /### Plano para mergear `feat\/pix` em `dev`/);
    assert.match(md, /1\. ❌ \*\*Segredo\*\* — `a\.js:3`/);
    assert.match(md, /Evidência: `KEY=…`/);
    assert.match(md, /2\. · \*\*Analisar de novo\*\*/);
  });

  it('acha o arquivo do erro na saída dos testes', () => {
    assert.deepEqual(errorLocation('at Object.<anonymous> (./src/x.js:2:16)\n at node:internal/x:1:1'), { file: 'src/x.js', line: 2 });
    assert.equal(errorLocation('sem pilha'), null);
  });
});

describe('ordem de merge', () => {
  it('stack antes; entre as livres, quem pode, depois avisos, depois bloqueadas; diz quem resolve o conflito', () => {
    const order = mergeOrder([
      { branch: 'feat/c', level: 'ok', after: ['feat/b'], conflictsWith: [] },
      { branch: 'feat/b', level: 'warn', after: [], conflictsWith: ['feat/x'] },
      { branch: 'feat/x', level: 'block', after: [], conflictsWith: ['feat/b'] },
      { branch: 'feat/a', level: 'ok', after: [], conflictsWith: [] },
    ]);
    assert.deepEqual(order.map((s) => s.branch), ['feat/a', 'feat/b', 'feat/c', 'feat/x']);
    assert.match(order[2]!.note, /empilhada: entra depois de feat\/b/);
    assert.match(order[3]!.note, /resolve o conflito com feat\/b/);
    assert.match(order[3]!.note, /precisa de trabalho antes/);
  });
});
