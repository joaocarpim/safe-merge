import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { analyze } from '../src/analyze.ts';
import { envUses, documentedIn, envVarsCheck } from '../src/checks/envvars.ts';
import { gitleaksFindings, secretsCheck, sastCheck, workflowsCheck } from '../src/checks/external.ts';
import { diffLock, lockfileCheck } from '../src/checks/lockfile.ts';
import { compareSeq, migrationsCheck, parseMigration } from '../src/checks/migrations.ts';
import type { CheckContext } from '../src/checks/types.ts';
import { untestedCheck, hasNamedTest } from '../src/checks/untested.ts';
import { definedNames, symbolsCheck } from '../src/checks/symbols.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { parseAddedLines } from '../src/diff.ts';
import { finalizeFindings, findingId, findingLevel, type FindingDraft } from '../src/findings.ts';
import { renderGithub } from '../src/render/github.ts';
import { renderHtml } from '../src/render/html.ts';
import { renderMarkdown } from '../src/render/markdown.ts';
import { renderText } from '../src/render/text.ts';
import { parseSarif, relativeUri, renderSarif } from '../src/sarif.ts';
import { cleanEnv, resolveIsolation } from '../src/semantic.ts';
import type { ToolResult, ToolRunner } from '../src/tools.ts';
import { parseStrace } from '../src/trace.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const ok = (stdout = '', code = 0): ToolResult => ({ missing: false, code, stdout, stderr: '', timedOut: false });
const absent: ToolResult = { missing: true, code: 127, stdout: '', stderr: 'não encontrado', timedOut: false };
/** Nenhuma ferramenta instalada. */
const noTools: ToolRunner = () => absent;

const policy = DEFAULT_CONFIG.security;
const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  category: 'secret',
  rule: 'r',
  title: 't',
  message: 'm',
  severity: 'high',
  confidence: 'high',
  file: 'a.js',
  line: 3,
  evidence: 'const x = 1',
  source: 'safemerge',
  ...over,
});

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    cwd: repo.dir,
    headRef: 'HEAD',
    headSha: repo.git('rev-parse', 'HEAD'),
    target: { name: 'dev', ref: 'refs/heads/dev' },
    mergeBase: repo.git('merge-base', 'HEAD', 'dev'),
    others: [],
    cfg: DEFAULT_CONFIG,
    tools: noTools,
    ...over,
  };
}

function lock(packages: Record<string, unknown>): string {
  return `${JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: { '': { name: 'app' }, ...packages } }, null, 2)}\n`;
}

const LEFTPAD = { 'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-AAA' } };

describe('achados', () => {
  it('só bloqueia com arquivo, linha e evidência; sem isso vira aviso', () => {
    assert.equal(findingLevel(draft(), policy), 'block');
    assert.equal(findingLevel(draft({ line: null }), policy), 'warn');
    assert.equal(findingLevel(draft({ evidence: null }), policy), 'warn');
    assert.equal(findingLevel(draft({ file: null }), policy), 'warn');
  });

  it('gravidade e confiança abaixo do limite configurado não bloqueiam', () => {
    assert.equal(findingLevel(draft({ severity: 'medium' }), policy), 'warn');
    assert.equal(findingLevel(draft({ confidence: 'low' }), policy), 'warn');
    assert.equal(findingLevel(draft({ severity: 'low', confidence: 'low' }), policy), 'info');
    assert.equal(findingLevel(draft({ severity: 'info' }), policy), 'info');
    assert.equal(findingLevel(draft({ severity: 'medium' }), { blockSeverity: 'medium', blockConfidence: 'medium' }), 'block');
  });

  it('id estável: não muda com a linha, muda com a evidência; duplicatas somem', () => {
    assert.equal(findingId(draft({ line: 3 })), findingId(draft({ line: 90 })));
    assert.notEqual(findingId(draft()), findingId(draft({ evidence: 'outra coisa' })));
    assert.match(findingId(draft()), /^SM-[0-9a-f]{8}$/);
    assert.equal(finalizeFindings([draft(), draft({ line: 7 }), draft({ evidence: 'x' })], policy).length, 2);
  });
});

describe('diff', () => {
  it('lê as linhas acrescentadas com o número da linha na versão nova', () => {
    const diff = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1,0 +2,2 @@', '+um', '+dois', '@@ -9 +11 @@', '+três'].join('\n');
    assert.deepEqual(parseAddedLines(diff), [
      { file: 'x.js', line: 2, text: 'um' },
      { file: 'x.js', line: 3, text: 'dois' },
      { file: 'x.js', line: 11, text: 'três' },
    ]);
  });
});

describe('lockfile', () => {
  it('acusa script de instalação, origem fora do registro e falta de integrity só nos pacotes novos/trocados', () => {
    const before = lock(LEFTPAD);
    const after = lock({
      ...LEFTPAD,
      'node_modules/bad-postinstall': { version: '0.0.1', resolved: 'https://registry.npmjs.org/bad-postinstall/-/bad-postinstall-0.0.1.tgz', integrity: 'sha512-BBB', hasInstallScript: true },
      'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/from-git.git#abc' },
      'node_modules/no-integrity': { version: '2.0.0', resolved: 'https://registry.npmjs.org/no-integrity/-/no-integrity-2.0.0.tgz' },
      'node_modules/sha1-only': { version: '1.0.0', resolved: 'https://registry.npmjs.org/sha1-only/-/sha1-only-1.0.0.tgz', integrity: 'sha1-CCC' },
      'packages/local': { version: '1.0.0' },
    });
    const { findings } = diffLock('package-lock.json', before, after, policy.allowedRegistries);
    const rules = findings.map((f) => `${f.rule}:${f.evidence?.split(':')[0]}`).sort();
    assert.deepEqual(rules, [
      'install-script:node_modules/bad-postinstall',
      'missing-integrity:node_modules/no-integrity',
      'untrusted-source:node_modules/from-git',
      'weak-integrity:node_modules/sha1-only',
    ]);
    const script = findings.find((f) => f.rule === 'install-script')!;
    assert.equal(script.severity, 'high');
    assert.match(after.split('\n')[script.line! - 1]!, /hasInstallScript/);
  });

  it('lockfileVersion 1 não é verificado e diz isso', () => {
    const res = diffLock('package-lock.json', null, JSON.stringify({ lockfileVersion: 1, dependencies: {} }), policy.allowedRegistries);
    assert.match(res.error ?? '', /lockfileVersion 1/);
  });

  it('pula com motivo quando o package-lock não mudou e roda quando mudou', () => {
    repo = baseRepo();
    repo.commit('lock', { 'package-lock.json': lock(LEFTPAD) });
    repo.branch('dev');
    repo.branch('feat', 'dev');
    assert.equal(lockfileCheck.run(ctx()).coverage.status, 'skipped');
    repo.commit('dep nova', { 'package-lock.json': lock({ ...LEFTPAD, 'node_modules/evil': { version: '1.0.0', resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz', integrity: 'sha512-E', hasInstallScript: true } }) });
    const out = lockfileCheck.run(ctx());
    assert.equal(out.coverage.status, 'ran');
    assert.equal(out.findings.length, 1);
  });
});

describe('migrações', () => {
  it('reconhece numeração sequencial, carimbo, Flyway e pasta do Prisma', () => {
    assert.equal(parseMigration('db/migrations/003_cria.sql')?.seq, '003');
    assert.equal(parseMigration('db/migrations/V12__x.sql')?.seq, '12');
    assert.equal(parseMigration('prisma/migrations/20261120103000_os/migration.sql')?.seq, '20261120103000');
    assert.equal(parseMigration('prisma/migrations/20261120103000_os/migration.sql')?.dir, 'prisma/migrations');
    assert.equal(parseMigration('db/migrations/README.md'), null);
    assert.ok(compareSeq('9', '10') < 0 && compareSeq('010', '10') === 0);
  });

  it('acusa mesmo número no destino (alto) e em outra branch (médio), e fora de ordem', () => {
    repo = baseRepo();
    repo.commit('m1', { 'db/migrations/001_base.sql': 'x' });
    repo.branch('dev');
    repo.commit('dev m2 e m3', { 'db/migrations/002_dev.sql': 'x', 'db/migrations/004_dev.sql': 'x' });
    repo.branch('outra', 'main');
    repo.commit('outra m5', { 'db/migrations/005_outra.sql': 'x' });
    repo.branch('feat', 'main');
    repo.commit('feat m2 m3 m5', { 'db/migrations/002_feat.sql': 'x', 'db/migrations/003_feat.sql': 'x', 'db/migrations/005_feat.sql': 'x' });
    const out = migrationsCheck.run(ctx({ others: [{ name: 'outra', ref: 'refs/heads/outra' }] }));
    const got = out.findings.map((f) => `${f.rule}:${f.file}:${f.severity}`).sort();
    assert.deepEqual(got, [
      'duplicate-number:db/migrations/002_feat.sql:high',
      'duplicate-number:db/migrations/005_feat.sql:medium',
      'out-of-order:db/migrations/003_feat.sql:medium',
      // 005_feat é maior que 004 do dev: em ordem no destino
    ].sort());
  });

  it('pula quando a branch não cria migração', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('x', { 'a.js': '1' });
    assert.equal(migrationsCheck.run(ctx()).coverage.status, 'skipped');
  });
});

describe('variáveis de ambiente', () => {
  it('acha leituras em JS, Python e Go', () => {
    const uses = envUses([
      { file: 'a.ts', line: 1, text: 'const k = process.env.PIX_API_KEY ?? ""' },
      { file: 'b.py', line: 2, text: 'url = os.environ["BANCO_URL"]' },
      { file: 'c.go', line: 3, text: 'x := os.Getenv("FILA")' },
      { file: 'd.ts', line: 4, text: 'if (process.env.NODE_ENV === "x")' },
      { file: 'README.md', line: 5, text: 'process.env.NAO_E_CODIGO' },
    ]);
    assert.deepEqual(uses.map((u) => u.name), ['PIX_API_KEY', 'BANCO_URL', 'FILA']);
    assert.ok(documentedIn('A=1\nexport PIX_API_KEY=\n', 'PIX_API_KEY'));
    assert.ok(!documentedIn('# PIX_API_KEY sem valor\n', 'PIX_API_KEY'));
    assert.ok(documentedIn('# B2_KEY_ID=\n# B2_REGION=us-west-004\n', 'B2_REGION'), 'variável opcional documentada comentada');
  });

  it('variável nova sem .env.example é aviso; documentada é lembrete; já existente é ignorada', () => {
    repo = baseRepo();
    repo.commit('base', { 'src/app.js': 'const a = process.env.ANTIGA;\n', '.env.example': 'ANTIGA=\n' });
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', {
      'src/pix.js': 'const k = process.env.PIX_KEY;\nconst a = process.env.ANTIGA;\nconst w = process.env.WEBHOOK_URL;\n',
      '.env.example': 'ANTIGA=\nWEBHOOK_URL=\n',
    });
    const out = envVarsCheck.run(ctx());
    const got = out.findings.map((f) => `${f.rule}:${f.line}:${f.title.split(': ')[1]}`).sort();
    assert.deepEqual(got, ['new-variable:3:WEBHOOK_URL', 'undocumented-variable:1:PIX_KEY']);
  });
});

describe('linhas sem teste', () => {
  it('casa teste pelo nome do arquivo', () => {
    assert.ok(hasNamedTest('src/os/service.js', ['test/service.test.js']));
    assert.ok(hasNamedTest('app/pix.py', ['tests/test_pix.py']));
    assert.ok(!hasNamedTest('src/pix.js', ['test/service.test.js']));
  });

  it('código alterado sem teste vira observação (info), nunca bloqueio', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', { 'src/pix.js': 'module.exports = 1;\n', 'src/os.js': 'module.exports = 2;\n', 'test/os.test.js': 'require("../src/os")\n' });
    const out = untestedCheck.run(ctx());
    assert.deepEqual(out.findings.map((f) => f.file), ['src/pix.js']);
    assert.equal(finalizeFindings(out.findings, policy)[0]!.level, 'info');
  });
});

const GITLEAKS_SARIF = JSON.stringify({
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  runs: [
    {
      tool: { driver: { name: 'gitleaks', semanticVersion: 'v8.21.0', rules: [{ id: 'github-pat', shortDescription: { text: 'GitHub Personal Access Token' } }] } },
      results: [
        {
          message: { text: 'github-pat has detected secret for file src/config.js at commit 4f2a9c1e.' },
          ruleId: 'github-pat',
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/config.js' }, region: { startLine: 2, startColumn: 15, endLine: 2, endColumn: 55, snippet: { text: 'REDACTED' } } } }],
          partialFingerprints: { commitSha: '4f2a9c1e0000000000000000000000000000000a', email: 'x@y', author: 'x', date: '2026-11-20T10:00:00Z', commitMessage: 'config' },
        },
      ],
    },
  ],
});

describe('ferramentas externas', () => {
  it('SARIF: lê resultados e normaliza caminhos absolutos para relativos', () => {
    const { ok: valid, hits } = parseSarif(GITLEAKS_SARIF);
    assert.ok(valid);
    assert.equal(hits[0]!.ruleId, 'github-pat');
    assert.equal(hits[0]!.line, 2);
    assert.equal(relativeUri('file:///C:/tmp/abc/.github/workflows/ci.yml', ['C:\\tmp\\abc']), '.github/workflows/ci.yml');
    assert.equal(parseSarif('isso não é json').ok, false);
  });

  it('gitleaks: segredo vira achado bloqueante com evidência sem o segredo', () => {
    const { findings } = gitleaksFindings(GITLEAKS_SARIF);
    const f = finalizeFindings(findings, policy)[0]!;
    assert.equal(f.level, 'block');
    assert.equal(f.file, 'src/config.js');
    assert.match(f.evidence!, /REDACTED @4f2a9c1/);
  });

  it('gitleaks: recebe o intervalo de commits da branch e lê o relatório; ausente = sem cobertura', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('x', { 'a.js': '1' });
    let seen: string[] = [];
    const fake: ToolRunner = (cmd, args) => {
      seen = args;
      writeFileSync(args[args.indexOf('--report-path') + 1]!, GITLEAKS_SARIF);
      return ok();
    };
    const out = secretsCheck.run(ctx({ tools: fake }));
    assert.equal(out.coverage.status, 'ran');
    assert.equal(out.findings.length, 1);
    const c = ctx();
    assert.ok(seen.includes(`${c.mergeBase}..${c.headSha}`) && seen.includes('--redact'));
    assert.equal(secretsCheck.run(ctx()).coverage.status, 'partial', 'sem gitleaks: regras internas');
  });

  it('zizmor: só roda se um workflow mudou e devolve o caminho do projeto', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    assert.equal(workflowsCheck.run(ctx()).coverage.status, 'skipped');
    repo.commit('ci', { '.github/workflows/ci.yml': 'on: pull_request_target\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n' });
    const fake: ToolRunner = (cmd, args) => {
      const file = args[args.length - 1]!;
      return ok(
        JSON.stringify({
          version: '2.1.0',
          runs: [
            {
              tool: { driver: { name: 'zizmor', rules: [{ id: 'template-injection', properties: { tags: ['high confidence'] } }] } },
              results: [{ ruleId: 'template-injection', level: 'error', message: { text: 'code injection via template expansion' }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: 6 } } }] }],
            },
          ],
        }),
        14,
      );
    };
    const out = workflowsCheck.run(ctx({ tools: fake }));
    assert.equal(out.coverage.status, 'ran');
    const f = finalizeFindings(out.findings, policy)[0]!;
    assert.equal(f.file, '.github/workflows/ci.yml');
    assert.match(f.evidence!, /github\.event\.pull_request\.title/);
    assert.equal(f.level, 'block');
  });

  it('semgrep: usa --baseline-commit com o ponto de partida, numa cópia temporária', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('x', { 'src/q.js': 'db.query("select * from os where id=" + id)\n' });
    let scanArgs: string[] = [];
    let scanCwd = '';
    const fake: ToolRunner = (cmd, args, opts) => {
      if (args[0] === '--version') return ok('1.95.0');
      scanArgs = args;
      scanCwd = opts?.cwd ?? '';
      return ok(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Semgrep', rules: [{ id: 'sqli', properties: { tags: ['MEDIUM CONFIDENCE', 'security'] } }] } }, results: [{ ruleId: 'sqli', level: 'error', message: { text: 'SQL montado com concatenação' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/q.js' }, region: { startLine: 1 } } }] }] }] }));
    };
    const c = ctx({ tools: fake });
    const out = sastCheck.run(c);
    assert.equal(out.coverage.status, 'ran');
    assert.equal(scanArgs[scanArgs.indexOf('--baseline-commit') + 1], c.mergeBase);
    assert.notEqual(scanCwd, repo.dir, 'roda numa cópia, não no repositório');
    assert.match(out.findings[0]!.evidence!, /select \* from os/);
    assert.equal(sastCheck.run(ctx()).coverage.status, 'missing-tool');
  });
});

describe('isolamento e registro', () => {
  it('ambiente limpo: tira tokens e chaves e diz quais (só o nome)', () => {
    const { env, withheld } = cleanEnv({ PATH: '/bin', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'k', FOO: 'bar' }, ['PATH']);
    assert.deepEqual(Object.keys(env).sort(), ['CI', 'PATH', 'SAFEMERGE']);
    assert.deepEqual(withheld, ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']);
  });

  it('usa Docker quando responde; sem Docker avisa "sem isolamento"; modo docker sem Docker é erro', () => {
    const docker: ToolRunner = (cmd) => (cmd === 'docker' ? ok('linux') : absent);
    const dockerWindows: ToolRunner = (cmd) => (cmd === 'docker' ? ok('windows') : absent);
    const iso = resolveIsolation(DEFAULT_CONFIG, docker, 'linux');
    assert.ok(!('error' in iso) && iso.mode === 'docker');
    // Docker em modo de contêineres Windows responde, mas não roda a imagem Linux: não conta como Docker
    const win = resolveIsolation(DEFAULT_CONFIG, dockerWindows, 'win32');
    assert.ok(!('error' in win) && win.mode === 'local' && /contêineres windows/.test(win.reason ?? ''), JSON.stringify(win));
    assert.ok('error' in resolveIsolation(mergeConfig(DEFAULT_CONFIG, { isolation: { mode: 'docker' } }), dockerWindows, 'win32'));
    const local = resolveIsolation(DEFAULT_CONFIG, noTools, 'win32');
    assert.ok(!('error' in local) && local.mode === 'local' && /sem isolamento|não instalado/.test(local.reason ?? ''));
    assert.ok(!('error' in local) && local.traced === false && /Linux/.test(local.traceReason ?? ''));
    const strict = resolveIsolation(mergeConfig(DEFAULT_CONFIG, { isolation: { mode: 'docker' } }), noTools, 'linux');
    assert.ok('error' in strict);
  });

  it('strace: separa rede, arquivos fora do projeto e programas, ignorando o sistema', () => {
    const trace = [
      '101 execve("/usr/bin/node", ["node", "check.js"], 0x7ffd /* 5 vars */) = 0',
      '101 openat(AT_FDCWD, "/usr/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
      '101 openat(AT_FDCWD, "/tmp/safemerge-x/wt/check.js", O_RDONLY|O_CLOEXEC) = 3',
      '101 openat(AT_FDCWD, "/home/joao/.ssh/id_rsa", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '101 openat(AT_FDCWD, "/home/joao/app/node_modules/x/index.js", O_RDONLY) = 3',
      '102 connect(19, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("140.82.112.3")}, 16) = -1 ENETUNREACH',
      '102 connect(20, {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
      '103 execve("/usr/bin/curl", ["curl", "https://x"], 0x0) = 0',
      '104 execve("/usr/local/sbin/sh", ["sh"], 0x0) = -1 ENOENT (No such file or directory)',
    ].join('\n');
    const o = parseStrace(trace, '/tmp/safemerge-x/wt', ['/home/joao/app/node_modules']);
    assert.deepEqual(o.network, ['140.82.112.3:443']);
    assert.deepEqual(o.files, ['/home/joao/.ssh/id_rsa']);
    assert.deepEqual(o.processes, ['/usr/bin/curl', '/usr/bin/node']);
  });
});

describe('relatório v2', () => {
  function plantedRepo(): void {
    repo = baseRepo();
    repo.commit('lock', { 'package-lock.json': lock(LEFTPAD) });
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('feat', {
      'package-lock.json': lock({ ...LEFTPAD, 'node_modules/evil': { version: '1.0.0', resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz', integrity: 'sha512-E', hasInstallScript: true } }),
      'src/pix.js': 'module.exports = () => process.env.PIX_KEY;\n',
    });
  }

  it('achados e cobertura entram no relatório e no veredito, com o id', () => {
    plantedRepo();
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, fetch: false, usePrs: false, tools: noTools });
    assert.equal(r.schema, 2);
    assert.equal(r.verdict.level, 'block');
    const script = r.findings.find((f) => f.rule === 'install-script')!;
    assert.ok(r.verdict.reasons.some((x) => x.level === 'block' && x.text.includes(script.id)));
    const cov = Object.fromEntries(r.coverage.map((c) => [c.check, c.status]));
    assert.equal(cov.secrets, 'partial');
    assert.equal(cov.lockfile, 'ran');
    assert.equal(cov.semantic, 'skipped');
    assert.ok(r.verdict.reasons.some((x) => /sem cobertura/.test(x.text)));
  });

  it('todo id de achado aparece no texto, Markdown, HTML e SARIF', () => {
    plantedRepo();
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, fetch: false, usePrs: false, tools: noTools });
    assert.ok(r.findings.length >= 3, `achados: ${r.findings.map((f) => f.rule).join(', ')}`);
    const outputs = {
      texto: renderText(r, { color: false }),
      markdown: renderMarkdown(r),
      html: renderHtml(r),
      sarif: renderSarif(r, '0.0.0'),
      github: renderGithub(r),
    };
    for (const f of r.findings) for (const [name, out] of Object.entries(outputs)) assert.ok(out.includes(f.id), `${f.id} faltando em ${name}`);
    for (const c of r.coverage) for (const name of ['texto', 'markdown', 'html'] as const) assert.ok(outputs[name].includes(c.label), `${c.check} faltando em ${name}`);
    const sarif = JSON.parse(outputs.sarif);
    assert.equal(sarif.version, '2.1.0');
  });

  it('--no-security pula a fase e marca na cobertura', () => {
    plantedRepo();
    const r = analyze({ cwd: repo.dir, cfg: DEFAULT_CONFIG, fetch: false, usePrs: false, tools: noTools, security: false });
    assert.equal(r.findings.length, 0);
    assert.equal(r.coverage.find((c) => c.check === 'security')?.status, 'skipped');
    assert.equal(r.verdict.level, 'ok');
  });
});

describe('símbolos removidos', () => {
  it('reconhece definições em JS, TS, Python e Go', () => {
    assert.deepEqual(definedNames('export async function formatarBRL(v) {'), ['formatarBRL']);
    assert.deepEqual(definedNames('module.exports = { formatarMoeda, outra: x };'), ['formatarMoeda', 'outra']);
    assert.deepEqual(definedNames('exports.soma = (a, b) => a + b;'), ['soma']);
    assert.deepEqual(definedNames('def calcular_total(itens):'), ['calcular_total']);
    assert.deepEqual(definedNames('func Total(itens []Item) int {'), ['Total']);
    assert.deepEqual(definedNames('const x = 1;'), []);
  });

  it('acusa uso de função que o destino renomeou (o conflito semântico do demo), sem rodar teste', () => {
    repo = baseRepo();
    repo.commit('moeda', { 'src/moeda.js': "function formatarMoeda(v) {\n  return 'R$ ' + v;\n}\nmodule.exports = { formatarMoeda };\n" });
    repo.branch('dev');
    repo.commit('renomeia', { 'src/moeda.js': "function formatarBRL(v) {\n  return 'R$ ' + v;\n}\nmodule.exports = { formatarBRL };\n" });
    repo.branch('feat', 'main');
    repo.commit('usa', { 'src/aprovacao.js': "const { formatarMoeda } = require('./moeda');\nconst resumo = formatarMoeda(1485);\n" });
    const out = symbolsCheck.run(ctx());
    assert.equal(out.coverage.status, 'ran');
    assert.equal(out.findings.length, 1, 'um achado por nome e arquivo');
    const f = finalizeFindings(out.findings, policy)[0]!;
    assert.equal(f.line, 1, 'aponta a linha do require');
    assert.equal(f.level, 'block');
  });

  it('não acusa quando o nome continua definido no destino ou a branch o redefine', () => {
    repo = baseRepo();
    repo.commit('moeda', { 'src/moeda.js': 'export function fmt(v) { return v; }\n', 'src/b.js': 'export function velha() {}\n' });
    repo.branch('dev');
    repo.commit('move fmt e remove velha', { 'src/moeda.js': '', 'src/outro.js': 'export function fmt(v) { return v; }\n', 'src/b.js': '' });
    repo.branch('feat', 'main');
    repo.commit('usa', { 'src/c.js': "import { fmt } from './outro';\nfmt(1);\nexport function velha() {}\nvelha();\n" });
    assert.equal(symbolsCheck.run(ctx()).findings.length, 0);
  });
});

describe('escanear o resultado do merge', () => {
  it('com merge limpo, o semgrep escaneia o commit do merge e usa o destino como base', async () => {
    const { mergeCommit } = await import('../src/git.ts');
    repo = baseRepo();
    repo.branch('dev');
    repo.commit('dev', { 'src/dev.js': 'module.exports = 1;\n' });
    repo.branch('feat', 'main');
    repo.commit('feat', { 'src/q.js': 'db.query("select * from os where id=" + id)\n' });
    const merged = mergeCommit(repo.dir, 'HEAD', 'refs/heads/dev');
    assert.ok(merged);
    let scanArgs: string[] = [];
    let scannedHead = '';
    const fake: ToolRunner = (cmd, args, opts) => {
      if (args[0] === '--version') return ok('1.95.0');
      scanArgs = args;
      scannedHead = spawnGit(opts!.cwd!, ['rev-parse', 'HEAD']);
      return ok(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Semgrep', rules: [] } }, results: [{ ruleId: 'sqli', level: 'error', message: { text: 'SQL concatenado' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/q.js' }, region: { startLine: 1 } } }] }] }] }));
    };
    const out = sastCheck.run(ctx({ tools: fake, mergedCommit: merged }));
    assert.equal(scannedHead, merged, 'escaneou o commit do merge');
    assert.equal(scanArgs[scanArgs.indexOf('--baseline-commit') + 1], repo.git('rev-parse', 'dev'));
    assert.match(out.coverage.reason ?? '', /resultado do merge contra dev/);
    assert.match(out.findings[0]!.evidence!, /select \* from os/);
    assert.equal(mergeCommit(repo.dir, 'HEAD', 'refs/heads/dev')?.length, 40);
  });
});

function spawnGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('regras internas (sem a ferramenta especializada)', () => {
  it('segredos: acha token apagado depois, em qualquer commit, sem mostrar o valor', async () => {
    const { scanSecrets, secretFindings } = await import('../src/checks/builtin-rules.ts');
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    const token = ['gh', 'p_', 'S4f3M3rg3D3m0'.repeat(3).slice(0, 36)].join('');
    const aws = ['AKIA', 'Z7Q2N4M6P8R1T3V5'].join('');
    repo.commit('config', { 'src/config.js': `module.exports = { gh: '${token}', aws: '${aws}' };\n` });
    repo.commit('remove', { 'src/config.js': 'module.exports = {};\n' });
    repo.commit('lock', { 'package-lock.json': `{"x":"${token}"}\n` });
    const hits = scanSecrets(repo.dir, repo.git('merge-base', 'HEAD', 'dev'), 'HEAD');
    assert.deepEqual(hits.map((h) => h.rule.id).sort(), ['aws-access-key', 'github-token'], 'lockfile é ignorado');
    const out = JSON.stringify(secretFindings(hits));
    assert.ok(!out.includes(token) && !out.includes(aws), 'o valor do segredo não pode aparecer');
    assert.equal(finalizeFindings(secretFindings(hits), policy)[0]!.level, 'block');
  });

  it('workflows: pull_request_target com checkout do PR e injeção de template', async () => {
    const { workflowFindings } = await import('../src/checks/builtin-rules.ts');
    const yml = [
      'on: pull_request_target',
      'permissions: write-all',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          ref: ${{ github.event.pull_request.head.sha }}',
      '      - run: |',
      '          echo "titulo: ${{ github.event.pull_request.title }}"',
      '      - run: echo "${{ github.sha }}"',
    ].join('\n');
    const got = workflowFindings('.github/workflows/x.yml', yml).map((f) => `${f.rule}:${f.line}`);
    assert.deepEqual(got.sort(), ['builtin/pr-target-checkout:9', 'builtin/template-injection:11', 'builtin/write-all:2']);
    const safe = 'on: pull_request\njobs:\n  a:\n    steps:\n      - env:\n          T: ${{ github.event.pull_request.title }}\n        run: echo "$T"\n';
    assert.deepEqual(workflowFindings('.github/workflows/y.yml', safe), [], 'valor passado por env: não é injeção');
  });
});
