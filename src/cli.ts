#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, UsageError, type AnalysisReport, type Level } from './analyze.js';
import { loadConfig, mergeConfig } from './config.js';
import { fileEmitter, newRunId } from './events.js';
import { parsePrList } from './github.js';
import { repoProblem, repoRoot, isGitRepo } from './git.js';
import { renderMarkdown } from './render/markdown.js';
import { renderText } from './render/text.js';
import { renderSarif } from './sarif.js';
import { VERSION } from './version.js';

const HELP = `safemerge ${VERSION}: diz se a sua branch pode ser mergeada antes do merge acontecer.

Uso:
  safemerge [analyze] [opções]       analisa a branch atual (padrão)
  safemerge replay [opções]          refaz merges antigos do repositório e mede conflitos (git × Mergiraf)
  safemerge verify-text <arquivo>    confere números e ids de um texto (escrito por IA) contra o relatório
  safemerge verify-resolution ...    testa uma proposta de resolução de conflito numa cópia temporária
  safemerge install-hook             instala o hook pre-push do git neste repositório
  safemerge render --report <json>   formata um relatório salvo (text, markdown, html, sarif, github)
  safemerge matrix [--base dev]      todas as branches abertas × categoria (conflito, segurança, deploy)

Opções de analyze:
  --head <branch>      Branch a analisar (padrão: a branch atual)
  --base <branch>      Destino que decide o veredito (padrão: detectado: dev, develop, main…)
  --target <branch>    Compara só com estes destinos (repetível)
  --remote <nome>      Remoto a usar (padrão: origin)
  --no-fetch           Não atualiza o remoto antes
  --no-overlap         Não procura outras branches/PRs nos mesmos arquivos
  --no-prs             Não associa branches a PRs abertas (não usa o gh)
  --prs-file <json>    Usa PRs deste arquivo (mesmo formato do "gh pr list --json") em vez do gh
  --test-cmd <cmd>     Roda este comando de testes no resultado do merge
  --build-cmd <cmd>    Roda este build antes dos testes no resultado do merge
  --isolation <modo>   auto (padrão: Docker sem rede se houver), docker (exige) ou none
  --no-security        Pula a fase de segurança e deploy
  --format <formato>   text (padrão), markdown, json, html, sarif, github (anotações do Actions)
                       ou prompt (pedido pronto para colar num assistente de IA)
  --out <arquivo>      Grava a saída no arquivo em vez de imprimir
  --sarif <arquivo>    Grava também achados e conflitos em SARIF 2.1.0
  --save               Grava eventos e relatórios em .safemerge/runs/<id>/
  --fail-on <nível>    block (padrão), warn ou never: quando sair com código 1
  --config <arquivo>   Configuração (padrão: .safemerge/config.json)
  --no-color           Sem cores
  -h, --help           Esta ajuda

Somente leitura: nenhuma branch ou arquivo seu é alterado. Acesso à rede: "git fetch"
(--no-fetch), listagem de PRs pelo gh (--no-prs) e as regras do semgrep, se instalado.
Ferramentas externas opcionais: gitleaks, zizmor, semgrep, docker, strace (Linux), mergiraf.
Sem elas, o relatório marca "sem cobertura" em vez de fingir que verificou.
Códigos de saída: 0 ok · 1 veredito pede atenção (ver --fail-on) · 2 erro de uso.
`;

function levelRank(l: Level): number {
  return l === 'block' ? 2 : l === 'warn' ? 1 : 0;
}

async function runAnalyze(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        head: { type: 'string' },
        base: { type: 'string' },
        target: { type: 'string', multiple: true },
        remote: { type: 'string' },
        'no-fetch': { type: 'boolean' },
        'no-overlap': { type: 'boolean' },
        'no-prs': { type: 'boolean' },
        'prs-file': { type: 'string' },
        'test-cmd': { type: 'string' },
        'build-cmd': { type: 'string' },
        isolation: { type: 'string' },
        'no-security': { type: 'boolean' },
        format: { type: 'string', default: 'text' },
        out: { type: 'string' },
        sarif: { type: 'string' },
        save: { type: 'boolean' },
        'fail-on': { type: 'string', default: 'block' },
        config: { type: 'string' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length > 0) {
    process.stderr.write(`argumento inesperado: ${positionals[0]}\n\n${HELP}`);
    return 2;
  }
  const format = values.format as string;
  if (!(RENDER_FORMATS as readonly string[]).includes(format)) {
    process.stderr.write(`formato inválido: ${format}\n`);
    return 2;
  }
  const failOn = values['fail-on'] as string;
  if (!['block', 'warn', 'never'].includes(failOn)) {
    process.stderr.write(`valor inválido para --fail-on: ${failOn}\n`);
    return 2;
  }
  const isolation = values.isolation as string | undefined;
  if (isolation && !['auto', 'docker', 'none'].includes(isolation)) {
    process.stderr.write(`valor inválido para --isolation: ${isolation}\n`);
    return 2;
  }

  const cwd = process.cwd();
  { const problem = repoProblem(cwd); if (problem) throw new UsageError(problem); }
  const root = repoRoot(cwd);
  let cfg = loadConfig(root, values.config);
  if (isolation) cfg = mergeConfig(cfg, { isolation: { mode: isolation } });

  let emitter: ReturnType<typeof fileEmitter> | undefined;
  let runDir = '';
  if (values.save) {
    const runId = newRunId();
    runDir = join(root, '.safemerge', 'runs', runId);
    emitter = fileEmitter(runDir, runId);
  }

  const prsFile = values['prs-file'];
  const listPrs = prsFile ? () => ({ prs: parsePrList(readFileSync(prsFile, 'utf8')) }) : undefined;

  const report = analyze({
    cwd: root,
    cfg,
    head: values.head,
    base: values.base,
    targets: values.target,
    remote: values.remote,
    fetch: !values['no-fetch'],
    overlap: !values['no-overlap'],
    usePrs: !values['no-prs'],
    listPrs,
    testCommand: values['test-cmd'],
    buildCommand: values['build-cmd'],
    security: !values['no-security'],
    emit: emitter?.emit,
  });

  if (values.save) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(runDir, 'report.md'), renderMarkdown(report));
    writeFileSync(join(runDir, 'report.sarif'), renderSarif(report, VERSION));
    // página autônoma do relatório (sem rede, sem script)
    const { renderHtml } = await import('./render/html.js');
    writeFileSync(join(runDir, 'report.html'), renderHtml(report));
    // para compartilhar: texto puro e um pedido pronto para qualquer assistente de IA
    writeFileSync(join(runDir, 'report.txt'), renderText(report, { color: false }));
    const { renderPrompt } = await import('./render/prompt.js');
    writeFileSync(join(runDir, 'report.prompt.md'), renderPrompt(report, { reportPath: join(runDir, 'report.json'), cliPath: process.argv[1] }));
  }
  if (values.sarif) writeFileSync(values.sarif, renderSarif(report, VERSION));

  const color = !values['no-color'] && !values.out && !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));
  const output = await renderReport(report, format, color);

  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);
  if (values.save) process.stderr.write(`salvo em ${runDir}\n`);

  if (failOn === 'never') return 0;
  return levelRank(report.verdict.level) >= levelRank(failOn as Level) ? 1 : 0;
}

async function runReplay(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: 'string', default: '200' },
      rev: { type: 'string' },
      format: { type: 'string', default: 'text' },
      out: { type: 'string' },
      'no-mergiraf': { type: 'boolean' },
      config: { type: 'string' },
    },
  });
  const limit = Number.parseInt(values.limit as string, 10);
  if (!Number.isFinite(limit) || limit < 1) throw new UsageError(`--limit inválido: ${values.limit}`);
  if (!['text', 'json'].includes(values.format as string)) throw new UsageError(`formato inválido: ${values.format}`);
  const cwd = process.cwd();
  { const problem = repoProblem(cwd); if (problem) throw new UsageError(problem); }
  const root = repoRoot(cwd);
  const { replay, renderReplay } = await import('./structured.js');
  const { runTool } = await import('./tools.js');
  const summary = replay(root, { limit, rev: values.rev, tools: runTool, cfg: loadConfig(root, values.config), useMergiraf: !values['no-mergiraf'] });
  const output = values.format === 'json' ? `${JSON.stringify(summary, null, 2)}\n` : renderReplay(summary);
  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);
  return 0;
}

async function runVerifyText(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { report: { type: 'string' }, format: { type: 'string', default: 'text' } },
  });
  const file = positionals[0];
  if (!file || !values.report) throw new UsageError('uso: safemerge verify-text --report <report.json> <texto.md>  (use - para ler o texto da entrada)');
  const { verifyText, renderVerify } = await import('./verify.js');
  const report = JSON.parse(readFileSync(values.report, 'utf8'));
  if (report.schema !== 2) throw new UsageError(`relatório com schema ${report.schema}; gere de novo com esta versão (schema 2)`);
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const result = verifyText(text, report);
  process.stdout.write(values.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderVerify(result));
  if (isGitRepo(process.cwd())) {
    const { staleRefs } = await import('./verify.js');
    const { git } = await import('./git.js');
    const root = repoRoot(process.cwd());
    const resolve = (ref: string) => {
      const r = git(root, ['rev-parse', '--verify', '--quiet', ref]);
      return r.code === 0 ? r.stdout.trim() : null;
    };
    for (const s of staleRefs(report, resolve)) process.stderr.write(`aviso: relatório desatualizado: ${s}. Rode a análise de novo.\n`);
  }
  return result.ok ? 0 : 1;
}

async function runVerifyResolution(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      head: { type: 'string' },
      target: { type: 'string' },
      file: { type: 'string', multiple: true },
      'test-cmd': { type: 'string' },
      'build-cmd': { type: 'string' },
      isolation: { type: 'string' },
      format: { type: 'string', default: 'text' },
      config: { type: 'string' },
    },
  });
  if (!values.target || !values.file?.length) {
    throw new UsageError('uso: safemerge verify-resolution --target <branch> --file <caminho>=<arquivo-proposto> [--file ...] [--test-cmd <cmd>]');
  }
  const cwd = process.cwd();
  { const problem = repoProblem(cwd); if (problem) throw new UsageError(problem); }
  const root = repoRoot(cwd);
  let cfg = loadConfig(root, values.config);
  if (values.isolation) cfg = mergeConfig(cfg, { isolation: { mode: values.isolation } });
  const { refExists } = await import('./git.js');
  const targetRef = [`refs/remotes/origin/${values.target}`, `refs/heads/${values.target}`, values.target].find((r) => refExists(root, r));
  if (!targetRef) throw new UsageError(`branch de destino não encontrada: ${values.target}`);
  const proposals: Record<string, string> = {};
  for (const spec of values.file) {
    const i = spec.indexOf('=');
    if (i <= 0) throw new UsageError(`--file espera <caminho>=<arquivo>: ${spec}`);
    proposals[spec.slice(0, i).replace(/\\/g, '/')] = readFileSync(spec.slice(i + 1), 'utf8');
  }
  const { verifyResolution, renderResolution } = await import('./resolution.js');
  const { runTool } = await import('./tools.js');
  const result = verifyResolution({
    repoDir: root,
    headRef: values.head ?? 'HEAD',
    target: { name: values.target, ref: targetRef },
    proposals,
    cfg,
    tools: runTool,
    testCommand: values['test-cmd'] ?? cfg.semantic.command,
    buildCommand: values['build-cmd'] ?? cfg.semantic.buildCommand,
  });
  process.stdout.write(values.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderResolution(result));
  return result.status === 'verified' ? 0 : 1;
}

async function runInstallHook(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { force: { type: 'boolean' }, timeout: { type: 'string', default: '20' } } });
  const cwd = process.cwd();
  { const problem = repoProblem(cwd); if (problem) throw new UsageError(problem); }
  const timeoutSec = Number.parseInt(values.timeout as string, 10);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1) throw new UsageError(`--timeout inválido: ${values.timeout}`);
  const { installHook, currentCommand } = await import('./hook.js');
  try {
    const res = installHook(repoRoot(cwd), currentCommand(), { force: values.force, timeoutSec });
    process.stdout.write(`hook pre-push instalado em ${res.path}${res.backup ? ` (o anterior ficou em ${res.backup})` : ''}\n`);
    process.stdout.write(`modo rápido: merge simulado e outras branches locais, limite de ${timeoutSec}s. Pular uma vez: git push --no-verify\n`);
    return 0;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

const RENDER_FORMATS = ['text', 'markdown', 'json', 'html', 'sarif', 'github', 'prompt'] as const;

/** Formata um relatório já salvo, sem refazer a análise. */
export async function renderReport(report: AnalysisReport, format: string, color = false): Promise<string> {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'markdown') return renderMarkdown(report);
  if (format === 'sarif') return renderSarif(report, VERSION);
  if (format === 'github') return (await import('./render/github.js')).renderGithub(report);
  if (format === 'prompt') return (await import('./render/prompt.js')).renderPrompt(report);
  if (format === 'html') return (await import('./render/html.js')).renderHtml(report);
  return renderText(report, { color });
}

async function runRender(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { report: { type: 'string' }, format: { type: 'string', default: 'text' }, out: { type: 'string' } } });
  if (!values.report) throw new UsageError(`uso: safemerge render --report <report.json> --format ${RENDER_FORMATS.join('|')}`);
  if (!(RENDER_FORMATS as readonly string[]).includes(values.format as string)) throw new UsageError(`formato inválido: ${values.format}`);
  const report = JSON.parse(readFileSync(values.report, 'utf8')) as AnalysisReport;
  if (report.schema !== 2) throw new UsageError(`relatório com schema ${String(report.schema)}; gere de novo com esta versão (schema 2)`);
  const output = await renderReport(report, values.format as string);
  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);
  return 0;
}

async function runMatrix(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' },
      limit: { type: 'string', default: '30' },
      'test-cmd': { type: 'string' },
      'no-security': { type: 'boolean' },
      'no-fetch': { type: 'boolean' },
      format: { type: 'string', default: 'text' },
      out: { type: 'string' },
      config: { type: 'string' },
    },
  });
  const limit = Number.parseInt(values.limit as string, 10);
  if (!Number.isFinite(limit) || limit < 1) throw new UsageError(`--limit inválido: ${values.limit}`);
  if (!['text', 'markdown', 'json'].includes(values.format as string)) throw new UsageError(`formato inválido: ${values.format}`);
  const cwd = process.cwd();
  { const problem = repoProblem(cwd); if (problem) throw new UsageError(problem); }
  const root = repoRoot(cwd);
  const { matrix, renderMatrixText, renderMatrixMarkdown } = await import('./matrix.js');
  let result;
  try {
    result = matrix({ cwd: root, cfg: loadConfig(root, values.config), base: values.base, limit, fetch: !values['no-fetch'], testCommand: values['test-cmd'] ?? null, security: !values['no-security'] });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const output = values.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : values.format === 'markdown' ? renderMatrixMarkdown(result) : renderMatrixText(result);
  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);
  return 0;
}

type Command = (argv: string[]) => Promise<number>;

const COMMANDS: Record<string, () => Promise<Command>> = {
  analyze: async () => runAnalyze,
  replay: async () => runReplay,
  'verify-text': async () => runVerifyText,
  'verify-resolution': async () => runVerifyResolution,
  'install-hook': async () => runInstallHook,
  render: async () => runRender,
  matrix: async () => runMatrix,
};

/** Opção que o Electron/VS Code exige para rodar um script como Node. Não é nossa: é ignorada. */
const ELECTRON_FLAG = '--ms-enable-electron-run-as-node';

async function main(rawArgv: string[]): Promise<number> {
  const argv = rawArgv.filter((a) => a !== ELECTRON_FLAG);
  const first = argv[0];
  const isCommand = first !== undefined && !first.startsWith('-');
  const name = isCommand ? first : 'analyze';
  const load = COMMANDS[name];
  if (!load) {
    process.stderr.write(`comando desconhecido: ${name}\n\n${HELP}`);
    return 2;
  }
  try {
    const cmd = await load();
    return await cmd(isCommand ? argv.slice(1) : argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`erro: ${err.message}\n`);
      return 2;
    }
    const msg = (err as Error).message ?? String(err);
    if (/^(arquivo de configuração|configuração inválida|expressão regular inválida)/.test(msg)) {
      process.stderr.write(`erro: ${msg}\n`);
      return 2;
    }
    process.stderr.write(`erro inesperado: ${(err as Error).stack ?? String(err)}\n`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
