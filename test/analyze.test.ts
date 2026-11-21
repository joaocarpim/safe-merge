import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { analyze, UsageError } from '../src/analyze.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { fileEmitter, type SafemergeEvent } from '../src/events.ts';
import { parsePrList } from '../src/github.ts';
import { renderHtml } from '../src/render/html.ts';
import { renderMarkdown } from '../src/render/markdown.ts';
import { renderText } from '../src/render/text.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const quiet = { fetch: false, usePrs: false };

function conflictScenario(): void {
  repo = baseRepo();
  repo.branch('dev');
  repo.commit('dev reescreve b', { 'calc.txt': 'a\nDEV\nc\n' });
  repo.branch('feat', 'main');
  repo.commit('feat reescreve b', { 'calc.txt': 'a\nFEAT\nc\n' });
}

describe('analyze', () => {
  it('bloqueia quando a branch conflita com o destino', () => {
    conflictScenario();
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.equal(r.primary, 'dev');
    assert.equal(r.verdict.level, 'block');
    assert.match(r.verdict.reasons[0]!.text, /1 arquivo em conflito com dev/);
  });

  it('lista os motivos por gravidade: bloqueio, aviso, informação', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev muda topo', { 'calc.txt': 'TOPO\nb\nc\n' });
    repo.branch('feat', 'main');
    repo.commit('feat muda fim e outro', { 'calc.txt': 'a\nb\nFIM\n', 'other.txt': 'DEV?\n' });
    repo.checkout('dev');
    repo.commit('dev muda other', { 'other.txt': 'DEV\n' });
    repo.checkout('feat');
    const levels = analyze({ cwd: repo.dir, cfg: mergeConfig(DEFAULT_CONFIG, { warnBehindCommits: 1 }), ...quiet }).verdict.reasons.map((r) => r.level);
    assert.deepEqual(levels, [...levels].sort((a, b) => ['block', 'warn', 'info'].indexOf(a) - ['block', 'warn', 'info'].indexOf(b)));
    assert.ok(levels.includes('block') && levels.includes('warn') && levels.includes('info'));
  });

  it('libera quando está tudo limpo', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.equal(r.verdict.level, 'ok');
  });

  it('conflito só com outra branch principal vira aviso, não bloqueio', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('main-hotfix-base', 'main');
    repo.checkout('main');
    repo.commit('main muda', { 'calc.txt': 'a\nMAIN\nc\n' });
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.equal(r.primary, 'dev');
    assert.equal(r.targets.find((t) => t.target === 'main')?.status, 'conflict');
    assert.equal(r.verdict.level, 'warn');
  });

  it('avisa quando está muito atrás do destino', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.checkout('dev');
    repo.commit('dev 1', { 'other.txt': '1\n' });
    repo.commit('dev 2', { 'other.txt': '2\n' });
    repo.checkout('feat');
    const cfg = mergeConfig(DEFAULT_CONFIG, { warnBehindCommits: 2 });
    const r = analyze({ cwd: repo.dir, cfg, ...quiet });
    assert.equal(r.verdict.level, 'warn');
    assert.match(r.verdict.reasons.map((x) => x.text).join('|'), /2 commits atrás/);
  });

  it('avisa de outra branch que vai conflitar e usa o PR quando o gh informa', () => {
    conflictScenario();
    repo.checkout('dev');
    repo.git('reset', '-q', '--hard', 'main');
    repo.checkout('feat');
    repo.branch('rival', 'main');
    repo.commit('rival', { 'calc.txt': 'a\nRIVAL\nc\n' });
    repo.checkout('feat');
    const listPrs = () => ({ prs: [{ number: 88, title: 't', author: 'maria', draft: false, headRefName: 'rival', url: '' }] });
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, fetch: false, listPrs });
    // sem remoto o gh não é consultado: a associação só acontece quando há remoto
    assert.equal(r.overlaps[0]?.branch, 'rival');
    assert.equal(r.overlaps[0]?.wouldConflict, true);
    assert.match(r.verdict.reasons.map((x) => x.text).join('|'), /outra branch vai conflitar/);
  });

  it('associa a branch à PR quando há remoto', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.branch('rival', 'dev');
    repo.commit('rival', { 'calc.txt': 'a\nRIVAL\nc\n' });
    repo.checkout('feat');
    repo.withRemote();
    const listPrs = () => ({ prs: [{ number: 88, title: 't', author: 'maria', draft: false, headRefName: 'rival', url: '' }] });
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, fetch: false, listPrs });
    assert.equal(r.overlaps[0]?.pr?.number, 88);
    assert.match(r.verdict.reasons.map((x) => x.text).join('|'), /#88/);
  });

  it('bloqueia conflito semântico quando há comando de testes', () => {
    repo = baseRepo();
    repo.write('check.js', "const fs=require('fs');for(const f of fs.readdirSync('src')){require('./src/'+f)}\n");
    repo.commit('lib', { 'src/lib.js': 'exports.soma = (a, b) => a + b;\n' });
    repo.branch('dev');
    repo.commit('dev renomeia', { 'src/lib.js': 'exports.somar = (a, b) => a + b;\n' });
    repo.branch('feat', 'main');
    repo.commit('feat usa', { 'src/usa.js': "require('./lib').soma(1, 2);\n" });
    const r = analyze({ cwd: repo.dir, cfg: mergeConfig(DEFAULT_CONFIG, { isolation: { mode: 'none' } }), ...quiet, testCommand: 'node check.js' });
    assert.equal(r.targets.find((t) => t.target === 'dev')?.status, 'clean');
    assert.equal(r.semantic[0]?.cause, 'semantic-conflict');
    assert.equal(r.verdict.level, 'block');
  });

  it('erra com mensagem clara: HEAD solto, destino e branch inexistentes', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.git('checkout', '-q', '--detach');
    assert.throws(() => analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet }), UsageError);
    repo.checkout('dev');
    assert.throws(() => analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet, base: 'nao-existe' }), /destino não encontrada/);
    assert.throws(() => analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet, head: 'nao-existe' }), /branch não encontrada/);
  });

  it('analisa uma branch pelo nome sem mudar a branch atual', () => {
    conflictScenario();
    repo.checkout('main');
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet, head: 'feat' });
    assert.equal(r.head.name, 'feat');
    assert.equal(r.verdict.level, 'block');
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  });

  it('avisa quando o destino local tem commits que não subiram (a comparação usa o remoto)', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'main');
    repo.commit('feat reescreve b', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.withRemote();
    // commit no dev local que conflitaria, mas não foi enviado
    repo.checkout('dev');
    repo.commit('dev local reescreve b', { 'calc.txt': 'a\nDEV\nc\n' });
    repo.checkout('feat');
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.equal(r.targets.find((t) => t.target === 'dev')?.status, 'clean', 'compara com origin/dev');
    assert.deepEqual(r.divergence, [{ branch: 'dev', localAhead: 1, remoteAhead: 0 }]);
    assert.ok(r.warnings.some((w) => /seu dev local tem 1 commit que não está em origin\/dev/.test(w)), r.warnings.join('\n'));
  });

  it('avisa quando a sua branch está atrás da mesma branch no remoto', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'main');
    repo.withRemote();
    repo.commit('do colega', { 'b.txt': '1\n' });
    repo.commit('do colega 2', { 'b.txt': '2\n' });
    repo.push('feat');
    repo.git('reset', '-q', '--hard', 'HEAD~2');
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.deepEqual(r.divergence, [{ branch: 'feat', localAhead: 0, remoteAhead: 2 }]);
    assert.ok(r.warnings.some((w) => /origin\/feat tem 2 commits que a sua feat local não tem/.test(w)), r.warnings.join('\n'));
  });

  it('commits locais não enviados na sua própria branch não geram aviso', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'main');
    repo.withRemote();
    repo.commit('trabalho local', { 'b.txt': '1\n' });
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.deepEqual(r.divergence, [{ branch: 'feat', localAhead: 1, remoteAhead: 0 }]);
    assert.ok(!r.warnings.some((w) => w.includes('feat')), r.warnings.join('\n'));
  });

  it('marca alterações não commitadas sem bloquear', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'calc.txt': 'a\nFEAT\nc\n' });
    repo.write('calc.txt', 'sujo\n');
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    assert.equal(r.head.dirty, true);
    assert.equal(r.verdict.level, 'ok');
  });
});

describe('eventos', () => {
  it('grava um evento por linha, na ordem, com versão e id da execução', () => {
    conflictScenario();
    const runDir = join(repo.dir, '.safemerge', 'runs', 'r1');
    const { emit, path } = fileEmitter(runDir, 'r1');
    analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet, emit });
    const events = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SafemergeEvent & { v: number; run: string });
    assert.deepEqual(events.map((e) => e.type).slice(0, 2), ['run.start', 'phase.start']);
    assert.equal(events.at(-1)?.type, 'run.end');
    assert.ok(events.every((e) => e.v === 1 && e.run === 'r1'));
    assert.ok(events.some((e) => e.type === 'merge.result' && e.status === 'conflict'));
    assert.equal(repo.git('status', '--porcelain'), '', 'gravar eventos não pode sujar o repositório');
  });
});

describe('renderizadores', () => {
  it('as três saídas usam o nome safemerge, sem o nome antigo', () => {
    conflictScenario();
    const report = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    for (const out of [renderText(report, { color: false }), renderMarkdown(report), renderHtml(report)]) {
      assert.match(out, /safemerge/);
      assert.doesNotMatch(out, /guardian/i);
    }
  });

  it('texto: sem cores é texto puro e traz o veredito e o trecho do conflito', () => {
    conflictScenario();
    const text = renderText(analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet }), { color: false });
    assert.ok(!text.includes('\u001b['));
    assert.match(text, /NÃO MERGEAR/);
    assert.match(text, /calc\.txt \(conteúdo\)/);
    assert.match(text, /sua branch │ FEAT/);
    assert.match(text, /dev\s+│ DEV/);
  });

  it('texto: com cor usa códigos ANSI', () => {
    conflictScenario();
    const text = renderText(analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet }), { color: true });
    assert.ok(text.includes('\u001b[31m'));
  });

  it('markdown: tabela de destinos e bloco diff do conflito', () => {
    conflictScenario();
    const md = renderMarkdown(analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet }));
    assert.match(md, /\| `dev` \(destino\) \| ❌ conflito \|/);
    assert.match(md, /```diff/);
    assert.match(md, /\+ a\n|\+ .*FEAT/);
    assert.match(md, /# sua branch, a partir da linha 2/);
  });
});

describe('html', () => {
  it('escapa texto do repositório (branch, commit, autor, código)', () => {
    conflictScenario();
    const report = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet });
    const evil = '<img src=x onerror=alert(1)>';
    report.head.name = evil;
    report.targets[0]!.conflicts[0]!.lastTouchOnTarget = { sha: 'abc', author: evil, date: '2025-01-01', subject: '<script>x</script>' };
    report.targets[0]!.conflicts[0]!.hunks[0]!.ours = [evil];
    const html = renderHtml(report);
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>x'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('é autônomo: sem script e sem recurso externo', () => {
    conflictScenario();
    const html = renderHtml(analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, ...quiet }));
    assert.ok(!/<script/i.test(html));
    assert.ok(!/(src|href)=["']https?:/i.test(html));
    assert.match(html, /NÃO MERGEAR/);
  });
});

describe('parsePrList', () => {
  it('lê a saída do gh e ignora entradas incompletas ou lixo', () => {
    const json = JSON.stringify([
      { number: 7, title: 'Desconto', headRefName: 'fix/desconto', isDraft: true, url: 'u', author: { login: 'maria' } },
      { title: 'sem número' },
      { number: 9, headRefName: 'x', author: null },
    ]);
    const prs = parsePrList(json);
    assert.equal(prs.length, 2);
    assert.deepEqual(prs[0], { number: 7, title: 'Desconto', author: 'maria', draft: true, headRefName: 'fix/desconto', url: 'u' });
    assert.equal(prs[1]?.author, 'desconhecido');
    assert.deepEqual(parsePrList('não é json'), []);
    assert.deepEqual(parsePrList('{}'), []);
  });
});

describe('CLI', () => {
  const cli = (cwd: string, ...args: string[]) =>
    spawnSync('node', ['--import', import.meta.resolve('tsx'), join(import.meta.dirname, '../src/cli.ts'), ...args], { cwd, encoding: 'utf8' });

  it('sai com 1 e JSON válido quando bloqueia', () => {
    conflictScenario();
    const res = cli(repo.dir, '--no-fetch', '--no-prs', '--format', 'json');
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout);
    assert.equal(report.verdict.level, 'block');
    assert.equal(report.schema, 2);
  });

  it('sai com 0 quando está limpo e com --fail-on never mesmo bloqueado', () => {
    conflictScenario();
    assert.equal(cli(repo.dir, '--no-fetch', '--no-prs', '--fail-on', 'never').status, 0);
    repo.checkout('dev');
    repo.branch('limpa', 'dev');
    repo.commit('x', { 'other.txt': 'z\n' });
    assert.equal(cli(repo.dir, '--no-fetch', '--no-prs').status, 0);
  });

  it('--save grava eventos e relatórios', () => {
    conflictScenario();
    const res = cli(repo.dir, '--no-fetch', '--no-prs', '--save', '--fail-on', 'never');
    assert.equal(res.status, 0);
    const dir = res.stderr.trim().replace('salvo em ', '');
    for (const f of ['events.ndjson', 'report.json', 'report.md', 'report.sarif', 'report.html', 'report.txt', 'report.prompt.md']) assert.ok(existsSync(join(dir, f)), f);
    assert.equal(repo.git('status', '--porcelain'), '', '--save não pode sujar o repositório');
  });

  it('ignora a opção que o Electron exige para rodar como Node (extensão do editor)', () => {
    conflictScenario();
    const res = cli(repo.dir, '--ms-enable-electron-run-as-node', '--no-fetch', '--no-prs', '--format', 'json');
    assert.equal(res.status, 1, res.stderr);
    assert.equal(JSON.parse(res.stdout).verdict.level, 'block');
  });

  it('sai com 2 fora de um repositório e em opção inválida', () => {
    repo = baseRepo();
    const outside = mkdtempSync(join(tmpdir(), 'sm-fora-')); // `/tmp` não existe no Windows
    try {
      assert.equal(cli(outside, '--no-fetch').status, 2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    assert.equal(cli(repo.dir, '--format', 'xml').status, 2);
    assert.equal(cli(repo.dir, '--opcao-que-nao-existe').status, 2);
  });
});
