// Precisão: falsos positivos e ruído encontrados ao comparar com o PR Master em repositórios reais
// (stacks de PR, Vite, catch documentado, JS injetado em WebView, dados fictícios de teste), e o
// que o PR Master cobre e o safemerge não cobria (descrição do PR, commits de rascunho, tamanho).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { analyze, buildVerdict } from '../src/analyze.ts';
import { envUses } from '../src/checks/envvars.ts';
import { TEST_FILE } from '../src/checks/hygiene.ts';
import { processCheck } from '../src/checks/process.ts';
import { insideStringBlock, riskCheck } from '../src/checks/risk.ts';
import type { CheckContext } from '../src/checks/types.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { findingLevel } from '../src/findings.ts';
import { detectTestCommand } from '../src/testcmd.ts';
import { TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    cwd: repo.dir,
    headRef: 'HEAD',
    headSha: repo.git('rev-parse', 'HEAD'),
    target: { name: 'main', ref: 'refs/heads/main' },
    mergeBase: repo.git('merge-base', 'HEAD', 'main'),
    others: [],
    cfg: DEFAULT_CONFIG,
    tools: () => ({ code: null, stdout: '', stderr: '', error: 'não usado' }),
    ...over,
  } as CheckContext;
}

describe('precisão: falsos positivos dos repositórios reais', () => {
  it('import.meta.env.PROD/DEV/MODE (constantes do Vite) não são variável de ambiente nova', () => {
    const lines = [{ file: 'src/api.ts', line: 1, text: 'if (import.meta.env.PROD && import.meta.env.VITE_API_URL) {}' }];
    assert.deepEqual(envUses(lines).map((u) => u.name), ['VITE_API_URL']);
  });

  it('dados fictícios: tests.py do Django, fixtures, factories, mocks e integration_test contam como teste', () => {
    for (const f of ['apps/fiscal/tests.py', 'tests/fixtures/users.json', 'app/factories.py', 'src/__mocks__/api.ts', 'integration_test/login_test.dart', 'src/mocks/handlers.ts']) assert.ok(TEST_FILE.test(f), f);
    assert.ok(!TEST_FILE.test('apps/fiscal/services.py'));
  });

  it('catch com comentário (fallback documentado) não é "exceção descartada"; sem comentário vira observação', () => {
    repo = new TestRepo();
    repo.commit('base', { 'src/a.ts': 'export const x = 1;\n' });
    repo.branch('feat');
    repo.commit('feat', {
      'src/a.ts': 'export function ler() {\n  try {\n    return JSON.parse(localStorage.x);\n  } catch {\n    // sem dado salvo: usa o padrão abaixo\n  }\n  return {};\n}\n',
    });
    assert.deepEqual(riskCheck.run(ctx()).findings.filter((f) => f.rule === 'swallowed-exception'), []);
    repo.commit('sem comentário', { 'src/b.ts': 'export function y() {\n  try {\n    risky();\n  } catch (e) {\n  }\n}\n' });
    const swallowed = riskCheck.run(ctx()).findings.filter((f) => f.rule === 'swallowed-exception');
    assert.equal(swallowed.length, 1);
    assert.equal(findingLevel(swallowed[0]!, DEFAULT_CONFIG.security), 'info', 'heurística de texto: observação, não aviso');
  });

  it('fetch dentro de JS injetado (template string ou arquivo Dart) não é "HTTP sem timeout"', () => {
    repo = new TestRepo();
    repo.commit('base', { 'README.md': 'x\n' });
    repo.branch('feat');
    repo.commit('feat', {
      'lib/webview.dart': "const js = '''\n  fetch('/api/status').then((r) => r.json());\n''';\n",
      'src/WebScreen.tsx': 'const injected = `\n  fetch("/api/ping");\n  true;\n`;\nexport default injected;\n',
    });
    assert.deepEqual(riskCheck.run(ctx()).findings.filter((f) => f.rule === 'http-without-timeout'), []);
    const rows = [{ text: 'const s = `' }, { text: 'fetch(x)' }];
    assert.equal(insideStringBlock(rows, rows[1]!), true);
    assert.equal(insideStringBlock([{ text: 'a' }, rows[1]!], rows[1]!), false);
  });
});

describe('precisão: stack de PRs e branches de preview', () => {
  const overlap = (branch: string, depth: number, pr?: number) => ({
    branch, ref: `refs/heads/${branch}`, pr: pr ? { number: pr, title: '', author: 'x', draft: false, headRefName: branch, url: '' } : null,
    relation: 'ours-contains-theirs' as const, sharedFiles: [], ignoredShared: [], renames: [], sameFunctions: [], wouldConflict: false, conflictFiles: [], lastCommit: null, ageDays: 0, stackDepth: depth,
  });

  it('24 branches empilhadas viram UM motivo, com a base mais próxima', () => {
    const overlaps = Array.from({ length: 24 }, (_, i) => overlap(`feat/passo-${i + 1}`, i + 1, i === 23 ? 300 : undefined));
    const v = buildVerdict({ primary: 'develop', targets: [], overlaps, semantic: [], head: { name: 'feat/passo-25', ref: 'HEAD', sha: 'x', shortSha: 'x', dirty: false }, warnings: [] } as never, DEFAULT_CONFIG);
    const stack = v.reasons.filter((r) => /empilhada/.test(r.text));
    assert.equal(stack.length, 1);
    assert.match(stack[0]!.text, /entra depois de #300/);
    assert.match(stack[0]!.text, /stack de 24 branches/);
    assert.equal(stack[0]!.level, 'warn', 'a base é um PR aberto: ordem de merge importa');
  });

  it('stack só de branches locais sem PR é informação, não aviso', () => {
    const v = buildVerdict({ primary: 'develop', targets: [], overlaps: [overlap('feat/a', 1), overlap('feat/b', 2)], semantic: [], head: { name: 'feat/c', ref: 'HEAD', sha: 'x', shortSha: 'x', dirty: false }, warnings: [] } as never, DEFAULT_CONFIG);
    assert.equal(v.level, 'ok');
    assert.equal(v.reasons.find((r) => /empilhada/.test(r.text))?.level, 'info');
  });

  it('branch local/preview-* não entra no cruzamento; a cobertura diz quantas foram ignoradas', () => {
    repo = new TestRepo();
    repo.commit('base', { 'src/auth.ts': 'a\nb\nc\n' });
    repo.branch('local/preview-all');
    repo.commit('preview', { 'src/auth.ts': 'PREVIEW\nb\nc\n' });
    repo.branch('feat/login', 'main');
    repo.commit('login', { 'src/auth.ts': 'LOGIN\nb\nc\n' });
    const r = analyze({ cwd: repo.dir, cfg: mergeConfig(DEFAULT_CONFIG, { security: { enabled: false } }), fetch: false, usePrs: false });
    assert.deepEqual(r.overlaps.map((o) => o.branch), []);
    assert.match(r.coverage.find((c) => c.check === 'overlap')!.reason ?? '', /1 branch\(es\) ignorada\(s\).*local\/preview-all/);
    // sem o padrão, o conflito aparece
    const r2 = analyze({ cwd: repo.dir, cfg: mergeConfig(DEFAULT_CONFIG, { security: { enabled: false }, overlap: { ignoreBranches: [] } }), fetch: false, usePrs: false });
    assert.deepEqual(r2.overlaps.map((o) => [o.branch, o.wouldConflict]), [['local/preview-all', true]]);
  });
});

describe('processo do PR (o que o PR Master cobre)', () => {
  function withMigration(): void {
    repo = new TestRepo();
    repo.commit('base', { 'app/models.py': 'x = 1\n' });
    repo.branch('feat');
    repo.commit('emissão de notas', { 'app/migrations/0007_nota.py': 'operations = []\n', 'app/models.py': 'x = 2\n' });
  }

  it('migração sem passo de deploy: lê os commits quando não há descrição e diz que leu só os commits', () => {
    withMigration();
    const out = processCheck.run(ctx());
    const f = out.findings.find((x) => x.rule === 'deploy-undocumented');
    assert.ok(f);
    assert.equal(f.file, 'app/migrations/0007_nota.py');
    assert.equal(f.confidence, 'medium');
    assert.match(out.coverage.reason ?? '', /mensagens dos commits/);
  });

  it('com a descrição do PR falando da migração, o aviso some; descrição curta e seção do time faltando aparecem', () => {
    withMigration();
    const ok = processCheck.run(ctx({ description: '## O que muda\nEmissão de NF-e.\n\n## Deploy\nRodar manage.py migrate antes de subir o código.', pr: { number: 12, title: 'NF-e' } }));
    assert.deepEqual(ok.findings.map((f) => f.rule), []);
    assert.match(ok.coverage.reason ?? '', /descrição do PR #12/);
    const cfg = mergeConfig(DEFAULT_CONFIG, { process: { requiredSections: ['^#+\\s*como testar'] } });
    const bad = processCheck.run(ctx({ description: 'ajustes', cfg }));
    assert.deepEqual(bad.findings.map((f) => f.rule).sort(), ['deploy-undocumented', 'empty-description', 'missing-section']);
    assert.equal(bad.findings.find((f) => f.rule === 'deploy-undocumented')!.confidence, 'high');
  });

  it('commits de rascunho (fixup!, WIP) e PR grande', () => {
    repo = new TestRepo();
    repo.commit('base', { 'a.txt': 'a\n' });
    repo.branch('feat');
    repo.commit('feat: tela', { 'a.txt': 'b\n' });
    repo.commit('fixup! feat: tela', { 'a.txt': 'c\n' });
    repo.commit('WIP', { 'b.txt': 'x\n'.repeat(30) });
    const cfg = mergeConfig(DEFAULT_CONFIG, { process: { maxLines: 20 } });
    const out = processCheck.run(ctx({ cfg }));
    assert.deepEqual(out.findings.map((f) => f.rule).sort(), ['draft-commits', 'large-pr']);
    assert.match(out.findings.find((f) => f.rule === 'draft-commits')!.evidence ?? '', /fixup! feat: tela.*WIP/);
  });
});

describe('testes: comando detectado é sugerido, nunca rodado sozinho', () => {
  it('detecta npm/pnpm, pytest, manage.py, flutter e go', () => {
    const dir = (files: Record<string, string>) => {
      const d = mkdtempSync(join(tmpdir(), 'sm-tc-'));
      for (const [p, c] of Object.entries(files)) writeFileSync(join(d, p), c);
      return d;
    };
    assert.equal(detectTestCommand(dir({ 'package.json': '{"scripts":{"test":"vitest run"}}' })), 'npm test');
    assert.equal(detectTestCommand(dir({ 'package.json': '{"scripts":{"test":"vitest"}}', 'pnpm-lock.yaml': '' })), 'pnpm test');
    assert.equal(detectTestCommand(dir({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
    assert.equal(detectTestCommand(dir({ 'manage.py': '', 'requirements.txt': 'django\npytest-django\n' })), 'pytest');
    assert.equal(detectTestCommand(dir({ 'manage.py': '', 'requirements.txt': 'django\n' })), 'python manage.py test');
    assert.equal(detectTestCommand(dir({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n' })), 'flutter test');
    assert.equal(detectTestCommand(dir({ 'go.mod': 'module x' })), 'go test ./...');
  });

  it('sem --test-cmd, a cobertura sugere o comando detectado', () => {
    repo = new TestRepo();
    repo.commit('base', { 'package.json': '{"scripts":{"test":"vitest run"}}' });
    repo.branch('feat');
    repo.commit('feat', { 'a.js': 'x\n' });
    const r = analyze({ cwd: repo.dir, cfg: mergeConfig(DEFAULT_CONFIG, { security: { enabled: false } }), fetch: false, usePrs: false });
    assert.match(r.coverage.find((c) => c.check === 'semantic')!.reason ?? '', /detectei "npm test".*--test-cmd "npm test"/);
  });
});
