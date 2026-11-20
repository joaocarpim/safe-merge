import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BranchRef } from './branches.js';
import type { Config } from './config.js';
import { git } from './git.js';
import { runTool, type ToolRunner } from './tools.js';
import { parseStrace, type Observed } from './trace.js';
import { withTempDir, withWorktree } from './worktree.js';

export interface SemanticResult {
  target: string;
  /** `flaky`: falhou e passou ao repetir, sem mudar o código. Não é acusado como conflito. */
  status: 'passed' | 'failed' | 'flaky' | 'skipped' | 'error';
  /**
   * Só quando falhou. `semantic-conflict`: o merge junta sem conflito de texto, mas o resultado
   * quebra, e cada lado sozinho passa. As outras causas dizem que o problema não vem da junção.
   */
  cause?: 'semantic-conflict' | 'branch-failing' | 'target-failing' | 'both-failing';
  /** Etapa que falhou: build ou testes. */
  stage?: 'build' | 'test';
  command: string | null;
  buildCommand?: string | null;
  exitCode: number | null;
  durationMs: number;
  /** Quantas vezes o resultado do merge foi testado (1 + repetições). */
  attempts: number;
  /** Final da saída do comando, para o relatório. */
  outputTail: string;
  reason?: string;
  isolation?: Isolation;
  /** O que os testes tocaram no resultado do merge (strace). */
  observed?: Observed;
}

export interface Isolation {
  /** `docker`: container sem rede. `local`: nesta máquina, com ambiente limpo. */
  mode: 'docker' | 'local';
  /** Por que não está isolado (quando `local`). */
  reason?: string;
  /** Nomes (nunca valores) de variáveis com cara de credencial que NÃO foram repassadas aos testes. */
  envWithheld: string[];
  traced: boolean;
  traceReason?: string;
}

interface RunOutcome {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tail: string;
  stage: 'build' | 'test';
  observed?: Observed;
}

const TAIL_LINES = 30;
const TAIL_CHARS = 3000;
const CREDENTIAL = /TOKEN|SECRET|PASSW|PASSWD|PWD$|_KEY|^KEY|APIKEY|CRED|AUTH|SESSION|COOKIE|PRIVATE|^AWS_|^AZURE_|^GCP_|^GOOGLE_|^NPM_|^GH_|^GITHUB_|^GITLAB_|^STRIPE_|^DATABASE_URL$|^DB_/i;

function tailOf(text: string): string {
  const lines = text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

/** Ambiente mínimo para os testes: só o que está na lista permitida. Tokens e chaves ficam de fora. */
export function cleanEnv(source: NodeJS.ProcessEnv, allow: string[]): { env: NodeJS.ProcessEnv; withheld: string[] } {
  const allowed = new Set(allow.map((a) => a.toUpperCase()));
  const env: NodeJS.ProcessEnv = { CI: '1', SAFEMERGE: '1' };
  const withheld: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (allowed.has(k.toUpperCase())) env[k] = v;
    else if (CREDENTIAL.test(k)) withheld.push(k);
  }
  return { env, withheld: withheld.sort() };
}

/** Decide como os testes vão rodar. Nada aqui altera o repositório. */
export function resolveIsolation(cfg: Config, tools: ToolRunner, platform = process.platform): Isolation | { error: string } {
  const { withheld } = cleanEnv(process.env, cfg.isolation.envAllow);
  let mode: Isolation['mode'] = 'local';
  let reason: string | undefined;
  if (cfg.isolation.mode === 'none') {
    reason = 'isolamento desligado na configuração (isolation.mode = "none")';
  } else {
    // a imagem é Linux: Docker no modo de contêineres Windows responde ao `info` mas não roda a imagem
    const probe = tools(cfg.security.tools.docker, ['info', '--format', '{{.OSType}}'], { timeoutMs: 20_000 });
    const osType = probe.stdout.trim().toLowerCase();
    const usable = !probe.missing && probe.code === 0 && osType === 'linux';
    const why = probe.missing ? 'não instalado' : probe.code !== 0 ? 'parado' : `em modo de contêineres ${osType || 'desconhecido'} (precisa ser Linux)`;
    if (usable) mode = 'docker';
    else if (cfg.isolation.mode === 'docker') return { error: `Docker exigido pela configuração e indisponível (${why})` };
    else reason = `Docker ${why}: testes rodaram nesta máquina com rede, mas com ambiente limpo`;
  }
  let traced = false;
  let traceReason: string | undefined;
  if (!cfg.isolation.trace) traceReason = 'desligado na configuração';
  else if (mode !== 'local') traceReason = 'dentro do container sem rede não é necessário';
  else if (platform !== 'linux') traceReason = 'strace só existe no Linux';
  else {
    const s = tools(cfg.security.tools.strace, ['-V'], { timeoutMs: 10_000 });
    traced = !s.missing && s.code === 0;
    if (!traced) traceReason = 'strace não instalado';
  }
  return { mode, reason, envWithheld: mode === 'docker' ? [] : withheld, traced, traceReason };
}

export interface Runner {
  isolation: Isolation;
  tools: ToolRunner;
}

export function runStep(repoDir: string, dir: string, command: string, cfg: Config, runner: Runner): { code: number; timedOut: boolean; out: string; observed?: Observed } {
  const timeout = cfg.semantic.timeoutSec * 1000;
  if (runner.isolation.mode === 'docker') {
    const mounts: string[] = [];
    for (const name of cfg.semantic.symlink) {
      const source = join(repoDir, name);
      if (existsSync(source)) mounts.push('-v', `${source}:/work/${name}:ro`);
    }
    const res = runner.tools(
      cfg.security.tools.docker,
      ['run', '--rm', '--network', 'none', '-v', `${dir}:/work`, ...mounts, '-w', '/work', '-e', 'CI=1', '-e', 'SAFEMERGE=1', cfg.isolation.image, 'sh', '-c', command],
      { timeoutMs: timeout },
    );
    if (res.code === 125 || res.code === 127) {
      // 125: o próprio `docker run` falhou (imagem não baixou, daemon recusou); 127: docker sumiu.
      // Não é o teste que falhou: vira erro, com o motivo, e não "não mergear".
      const first = res.stderr.split('\n').find((l) => l.trim()) ?? 'sem mensagem';
      throw new Error(`Docker não conseguiu rodar a imagem ${cfg.isolation.image}: ${first.trim().slice(0, 200)}`);
    }
    return { code: res.code, timedOut: res.timedOut, out: `${res.stdout}\n${res.stderr}`.split(dir).join('.').split('/work/').join('./') };
  }

  const { env } = cleanEnv(process.env, cfg.isolation.envAllow);
  if (runner.isolation.traced) {
    return withTempDir((tmp) => {
      const traceFile = join(tmp, 'trace.txt');
      const res = runner.tools(cfg.security.tools.strace, ['-f', '-qq', '-e', 'trace=connect,openat,execve', '-o', traceFile, 'sh', '-c', command], { cwd: dir, env, timeoutMs: timeout });
      const allow = cfg.semantic.symlink.map((n) => join(repoDir, n));
      const observed = existsSync(traceFile) ? parseStrace(readFileSync(traceFile, 'utf8'), dir, allow) : undefined;
      return { code: res.code, timedOut: res.timedOut, out: `${res.stdout}\n${res.stderr}`.split(dir).join('.'), observed };
    });
  }
  for (const name of cfg.semantic.symlink) {
    const source = join(repoDir, name);
    if (existsSync(source) && !existsSync(join(dir, name))) {
      try {
        symlinkSync(source, join(dir, name), 'junction');
      } catch {
        /* sem permissão para link: o comando de testes dirá o que faltou */
      }
    }
  }
  const proc = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env, windowsHide: true });
  const timedOut = (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  // a pasta temporária não diz nada ao leitor: mostra os caminhos como no projeto
  return { code: timedOut ? 124 : (proc.status ?? 1), timedOut, out: `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`.split(dir).join('.') };
}

/** Roda build (se houver) e testes numa cópia temporária do commit. */
function runInWorktree(repoDir: string, commit: string, cfg: Config, runner: Runner, command: string, build: string | null): RunOutcome {
  const started = Date.now();
  return withWorktree(repoDir, commit, (dir) => {
    if (build) {
      const b = runStep(repoDir, dir, build, cfg, runner);
      if (b.code !== 0) return { exitCode: b.code, timedOut: b.timedOut, durationMs: Date.now() - started, tail: tailOf(b.out), stage: 'build', observed: b.observed };
    }
    const t = runStep(repoDir, dir, command, cfg, runner);
    return { exitCode: t.code, timedOut: t.timedOut, durationMs: Date.now() - started, tail: tailOf(t.out), stage: 'test', observed: t.observed };
  });
}

export interface SemanticOptions {
  tools?: ToolRunner;
  /** Isolamento já decidido (a análise decide uma vez). */
  isolation?: Isolation;
  buildCommand?: string | null;
}

/**
 * Faz o merge de verdade numa cópia temporária e roda os testes no resultado.
 * Pega o conflito que o git não vê: merge limpo no texto, mas que quebra quando as duas
 * mudanças convivem (uma função renomeada de um lado e usada do outro, por exemplo).
 */
export function semanticCheck(
  repoDir: string,
  headRef: string,
  target: BranchRef,
  cfg: Config,
  command: string | null,
  opts: SemanticOptions = {},
): SemanticResult {
  const build = opts.buildCommand === undefined ? cfg.semantic.buildCommand : opts.buildCommand;
  const base: SemanticResult = {
    target: target.name,
    status: 'skipped',
    command,
    buildCommand: build,
    exitCode: null,
    durationMs: 0,
    attempts: 0,
    outputTail: '',
  };
  if (!command) return { ...base, reason: 'nenhum comando de testes configurado' };

  const tools = opts.tools ?? runTool;
  const iso = opts.isolation ?? resolveIsolation(cfg, tools);
  if ('error' in iso) return { ...base, status: 'error', reason: iso.error };
  const runner: Runner = { isolation: iso, tools };

  const mt = git(repoDir, ['merge-tree', '--write-tree', headRef, target.ref]);
  if (mt.code === 1) return { ...base, isolation: iso, reason: 'há conflito de texto; resolva antes de testar o resultado' };
  if (mt.code !== 0) return { ...base, status: 'error', reason: mt.stderr.trim() || 'merge-tree falhou' };
  const tree = mt.stdout.split('\n')[0]!.trim();

  const identity = {
    GIT_AUTHOR_NAME: 'safemerge',
    GIT_AUTHOR_EMAIL: 'safemerge@localhost',
    GIT_COMMITTER_NAME: 'safemerge',
    GIT_COMMITTER_EMAIL: 'safemerge@localhost',
  };
  const made = git(repoDir, ['commit-tree', tree, '-p', headRef, '-p', target.ref, '-m', 'merge simulado pelo safemerge'], { env: identity });
  if (made.code !== 0) return { ...base, status: 'error', reason: made.stderr.trim() };
  const merged = made.stdout.trim();

  let run: RunOutcome;
  let attempts = 1;
  try {
    run = runInWorktree(repoDir, merged, cfg, runner, command, build);
    // Teste que falhou: repete antes de acusar. Se passar ao repetir, é instável, não conflito.
    while (run.exitCode !== 0 && attempts <= cfg.semantic.retries && !run.timedOut) {
      attempts++;
      const again = runInWorktree(repoDir, merged, cfg, runner, command, build);
      if (again.exitCode === 0) {
        return { ...base, status: 'flaky', isolation: iso, attempts, exitCode: run.exitCode, durationMs: run.durationMs + again.durationMs, outputTail: run.tail, stage: run.stage, observed: again.observed ?? run.observed };
      }
      run = again;
    }
  } catch (err) {
    return { ...base, status: 'error', isolation: iso, reason: (err as Error).message };
  }
  const result: SemanticResult = {
    ...base,
    isolation: iso,
    attempts,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    outputTail: run.tail,
    observed: run.observed,
  };
  if (run.exitCode === 0) return { ...result, status: 'passed' };

  // Falhou: descobre se a culpa é da junção ou de um dos lados já estar quebrado.
  let targetOk = false;
  let headOk = false;
  try {
    targetOk = runInWorktree(repoDir, target.ref, cfg, runner, command, build).exitCode === 0;
    headOk = runInWorktree(repoDir, headRef, cfg, runner, command, build).exitCode === 0;
  } catch {
    /* sem classificação: fica como falha genérica */
  }
  const cause: SemanticResult['cause'] =
    targetOk && headOk ? 'semantic-conflict' : headOk ? 'target-failing' : targetOk ? 'branch-failing' : 'both-failing';
  return {
    ...result,
    status: 'failed',
    cause,
    stage: run.stage,
    reason: run.timedOut ? `tempo esgotado (${cfg.semantic.timeoutSec}s)` : undefined,
  };
}
