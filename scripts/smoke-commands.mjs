// Confere, de ponta a ponta, todos os comandos e opções da CLI compilada (dist/cli.js) nos repositórios de
// demonstração: código de saída e um trecho esperado da saída. Uso: npm run build && npm run smoke
// Nada é alterado fora da pasta temporária (exceto o hook, instalado no demo temporário).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');
if (!existsSync(CLI)) throw new Error('rode "npm run build" antes');
const tmp = mkdtempSync(join(tmpdir(), 'sm-smoke-'));
const bash = (script, dir) => {
  const r = spawnSync('bash', [join(ROOT, 'examples', script), dir], { encoding: 'utf8', env: { ...process.env, SAFEMERGE_DEMO_FILLER: '10' } });
  if (r.status !== 0) throw new Error(`${script}: ${r.stderr}`);
};
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

console.log('preparando demos…');
const ws = join(tmp, 'pasta');
mkdirSync(ws);
const back = join(ws, 'backend');
const front = join(ws, 'frontend');
const sem = join(tmp, 'semantico');
bash('make-demo-complex.sh', back);
bash('make-demo.sh', front);
bash('make-demo-semantic.sh', sem);
git(back, 'checkout', '-q', '-f', 'feat/desconto-orcamento');
const body = join(tmp, 'descricao.md');
writeFileSync(body, '## O que muda\nDesconto no orçamento.\n\n## Deploy\nSem migração.\n');
const proposal = join(tmp, 'proposta.js');
writeFileSync(proposal, `${git(back, 'show', 'HEAD:src/server/services/orcamento.js').replace(/function calcularTotal\(itens, descontoPercentual = 0\) \{[\s\S]*?\n\}/, 'function calcularTotal(itens, descontoPercentual = 0) {\n  const bruto = itens.reduce((s, i) => s + i.preco * i.quantidade, 0);\n  return Math.round(bruto * (1 - descontoPercentual / 100) * 100) / 100;\n}')}`);

const results = [];
function check(name, cwd, args, { code = [0], out = null, file = null } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 300_000 });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const problems = [];
  if (!code.includes(r.status)) problems.push(`código ${r.status} (esperado ${code.join(' ou ')})`);
  if (out && !out.test(text)) problems.push(`saída sem ${out}`);
  if (file && !existsSync(file)) problems.push(`arquivo não criado: ${file}`);
  results.push({ name, ok: problems.length === 0, ms: Date.now() - t0, problems, tail: problems.length ? text.trim().split('\n').slice(-3).join(' | ') : '' });
  process.stdout.write(problems.length ? '✗' : '.');
}

// ajuda e versão
check('--version', back, ['--version'], { out: /^0\.\d+\.\d+/m });
check('help', back, ['help'], { out: /Opções de analyze/ });
check('matrix --help', back, ['matrix', '--help'], { out: /Opções de matrix/ });
check('workspace --help', ws, ['workspace', '--help'], { out: /--all-branches/ });

// analyze: formatos e opções
const A = ['--no-fetch', '--prs-file', 'prs.json'];
check('analyze (texto)', back, A, { code: [1], out: /NÃO MERGEAR/ });
for (const [fmt, re] of [['markdown', /## safemerge[\s\S]*Plano para mergear/], ['json', /"plan": \[/], ['html', /<!doctype html>/i], ['sarif', /"version": "2\.1\.0"/], ['github', /::error/], ['prompt', /Plano do safemerge/]]) {
  check(`analyze --format ${fmt}`, back, [...A, '--format', fmt], { code: [1], out: re });
}
check('analyze --fail-on never', back, [...A, '--fail-on', 'never'], { code: [0] });
check('analyze --fail-on warn', back, [...A, '--fail-on', 'warn'], { code: [1] });
check('analyze --out', back, [...A, '--format', 'markdown', '--out', join(tmp, 'r.md'), '--fail-on', 'never'], { file: join(tmp, 'r.md') });
check('analyze --sarif', back, [...A, '--sarif', join(tmp, 'r.sarif'), '--fail-on', 'never'], { file: join(tmp, 'r.sarif') });
check('analyze --save', back, [...A, '--save', '--fail-on', 'never'], { out: /salvo em/ });
check('analyze --head (outra branch)', back, [...A, '--head', 'feat/galeria-fotos'], { code: [0, 1], out: /feat\/galeria-fotos/ });
check('analyze --base / --target', back, [...A, '--base', 'main', '--target', 'main', '--fail-on', 'never'], { out: /main/ });
check('analyze --body', back, [...A, '--body', 'ajuste', '--format', 'json', '--fail-on', 'never'], { out: /descrição passada em --body/ });
check('analyze --body-file', back, [...A, '--body-file', body, '--format', 'json', '--fail-on', 'never'], { out: /descrição passada em --body/ });
check('analyze --test-cmd', sem, ['--no-fetch', '--test-cmd', 'node check.js', '--isolation', 'none'], { code: [1], out: /conflito semântico|quebram/ });
check('analyze --test-cmd auto', back, [...A, '--test-cmd', 'auto', '--fail-on', 'never'], { out: /testes: (usando|nenhum)/ });
check('analyze --build-cmd', sem, ['--no-fetch', '--test-cmd', 'node check.js', '--build-cmd', 'node -e "1"', '--isolation', 'none'], { code: [1] });
check('analyze --no-security', back, [...A, '--no-security', '--format', 'json', '--fail-on', 'never'], { out: /desligado \(--no-security/ });
check('analyze --no-overlap', back, [...A, '--no-overlap', '--format', 'json', '--fail-on', 'never'], { out: /desligado \(--no-overlap\)/ });
check('analyze --no-prs', back, ['--no-fetch', '--no-prs', '--fail-on', 'never'], { code: [0] });
check('analyze --no-color', back, [...A, '--no-color', '--fail-on', 'never'], { code: [0] });
check('analyze --config (inexistente: erro claro)', back, [...A, '--config', 'nao-existe.json'], { code: [2], out: /configuração não encontrado/ });
const vazia = join(tmp, 'vazia');
mkdirSync(vazia);
check('analyze fora de repositório', vazia, ['--no-fetch'], { code: [2], out: /não é um repositório git/ });

// várias branches e vários repositórios
check('matrix', back, ['matrix', '--no-fetch', '--no-cache'], { out: /Ordem de merge sugerida/ });
check('matrix (cache)', back, ['matrix', '--no-fetch'], { out: /Ordem de merge/ });
check('matrix (cache, 2a vez)', back, ['matrix', '--no-fetch'], { out: /sem mudança desde a última vez \(cache\)/ });
check('matrix --format json', back, ['matrix', '--no-fetch', '--format', 'json'], { out: /"order": \[/ });
check('matrix --format markdown', back, ['matrix', '--no-fetch', '--format', 'markdown'], { out: /### Ordem de merge sugerida/ });
check('matrix --jobs 1 --limit 3', back, ['matrix', '--no-fetch', '--no-cache', '--jobs', '1', '--limit', '3'], { out: /3 branch\(es\)/ });
check('pasta raiz (automático)', ws, ['--no-fetch'], { code: [1], out: /2 repositório\(s\)/ });
check('workspace --format markdown', ws, ['workspace', '--no-fetch', '--format', 'markdown', '--fail-on', 'never'], { out: /## safemerge: 2 repositório/ });
check('workspace --all-branches', ws, ['workspace', '--all-branches', '--no-fetch', '--fail-on', 'never'], { out: /todas as branches abertas/ });
check('contracts', ws, ['contracts'], { out: /rota|repositório/ });
check('contracts --format json', ws, ['contracts', '--format', 'json'], { out: /"issues"/ });

// relatório salvo, verificadores, replay, hook
const runs = join(back, '.safemerge', 'runs');
const report = join(runs, readdirSync(runs).sort().pop(), 'report.json');
check('render --format html', back, ['render', '--report', report, '--format', 'html'], { out: /<!doctype html>/i });
check('render --format prompt', back, ['render', '--report', report, '--format', 'prompt'], { out: /safemerge/ });
const text = join(tmp, 'texto.md');
writeFileSync(text, 'O conflito está em src/server/services/orcamento.js:3.\n');
check('verify-text', back, ['verify-text', '--report', report, text], { code: [0, 1], out: /./ });
check('verify-resolution', back, ['verify-resolution', '--target', 'dev', '--file', `src/server/services/orcamento.js=${proposal}`, '--format', 'json'], { code: [0, 1], out: /"status"/ });
check('replay --limit 5', back, ['replay', '--limit', '5'], { out: /merge/i });
check('install-hook', back, ['install-hook'], { out: /hook/i, file: join(back, '.git', 'hooks', 'pre-push') });
check('comando desconhecido', back, ['nao-existe'], { code: [2], out: /comando desconhecido/ });

console.log('\n');
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(width)}  ${String(r.ms).padStart(6)} ms${r.ok ? '' : `  ${r.problems.join('; ')}  [${r.tail}]`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} de ${results.length} comandos ok`);
rmSync(tmp, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
