import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { newVulns, osvCheck, parseOsv } from '../src/checks/osv.ts';
import { activeSecretsCheck, parseTrufflehog } from '../src/checks/trufflehog.ts';
import type { CheckContext } from '../src/checks/types.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { finalizeFindings } from '../src/findings.ts';
import type { ToolResult, ToolRunner } from '../src/tools.ts';
import { baseRepo, type TestRepo } from './helpers.ts';

let repo: TestRepo;
afterEach(() => repo?.destroy());

const ok = (stdout: string, code = 0): ToolResult => ({ missing: false, code, stdout, stderr: '', timedOut: false });
const absent: ToolRunner = () => ({ missing: true, code: 127, stdout: '', stderr: '', timedOut: false });

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    cwd: repo.dir,
    headRef: 'HEAD',
    headSha: repo.git('rev-parse', 'HEAD'),
    target: { name: 'dev', ref: 'refs/heads/dev' },
    mergeBase: repo.git('merge-base', 'HEAD', 'dev'),
    others: [],
    cfg: DEFAULT_CONFIG,
    tools: absent,
    ...over,
  };
}

/** Saída no formato do `osv-scanner --format json`. */
function osvOut(pkgs: Array<{ name: string; version: string; vulns: Array<[string, string, string?]> }>): string {
  return JSON.stringify({
    results: [
      {
        source: { path: '/tmp/x/package-lock.json', type: 'lockfile' },
        packages: pkgs.map((p) => ({
          package: { name: p.name, version: p.version, ecosystem: 'npm' },
          vulnerabilities: p.vulns.map(([id, summary, cve]) => ({ id, summary, aliases: cve ? [cve] : [], database_specific: { severity: 'HIGH' } })),
          groups: p.vulns.map(([id, , cve]) => ({ ids: cve ? [id, cve] : [id], max_severity: '7.5' })),
        })),
      },
    ],
  });
}

const lock = (deps: Record<string, string>) =>
  `${JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`, integrity: 'sha512-A' }])) } }, null, 2)}\n`;

describe('OSV-Scanner', () => {
  it('lê grupos (aliases contam uma vez) e a gravidade CVSS', () => {
    const { vulns } = parseOsv(osvOut([{ name: 'lodash', version: '4.17.20', vulns: [['GHSA-35jh-r3h4-6jhm', 'Command Injection in lodash', 'CVE-2021-23337']] }]));
    assert.equal(vulns.length, 1);
    assert.equal(vulns[0]!.severity, 'high');
    assert.deepEqual(vulns[0]!.aliases, ['CVE-2021-23337']);
  });

  it('só é nova a falha que não existia antes, mesmo com versão diferente', () => {
    const before = parseOsv(osvOut([{ name: 'a', version: '1.0.0', vulns: [['GHSA-1', 'x']] }])).vulns;
    const after = parseOsv(osvOut([{ name: 'a', version: '1.0.1', vulns: [['GHSA-1', 'x']] }, { name: 'b', version: '2.0.0', vulns: [['GHSA-2', 'y']] }])).vulns;
    assert.deepEqual(newVulns(before, after).map((v) => v.id), ['GHSA-2']);
  });

  it('roda nas duas versões do lockfile e acusa só o que a branch trouxe', () => {
    repo = baseRepo();
    repo.commit('lock', { 'package-lock.json': lock({ lodash: '4.17.20' }) });
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('dep nova', { 'package-lock.json': lock({ lodash: '4.17.20', 'axios-velho': '0.21.0' }) });
    const fake: ToolRunner = (cmd, args) => {
      const text = readFileSync(args[args.indexOf('--lockfile') + 1]!, 'utf8');
      const pkgs = [{ name: 'lodash', version: '4.17.20', vulns: [['GHSA-35jh-r3h4-6jhm', 'Command Injection', 'CVE-2021-23337']] as Array<[string, string, string?]> }];
      if (text.includes('axios-velho')) pkgs.push({ name: 'axios-velho', version: '0.21.0', vulns: [['GHSA-4w2v-q235-vp99', 'SSRF', 'CVE-2020-28168']] });
      return ok(osvOut(pkgs), 1);
    };
    const out = osvCheck.run(ctx({ tools: fake }));
    assert.equal(out.coverage.status, 'ran');
    assert.equal(out.findings.length, 1);
    const f = finalizeFindings(out.findings, DEFAULT_CONFIG.security)[0]!;
    assert.equal(f.evidence, 'axios-velho@0.21.0: GHSA-4w2v-q235-vp99');
    assert.match(f.message, /CVE-2020-28168/);
    assert.equal(f.level, 'block');
    assert.equal(osvCheck.run(ctx()).coverage.status, 'missing-tool');
  });

  it('pula quando nenhum lockfile mudou', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('x', { 'a.js': '1' });
    assert.equal(osvCheck.run(ctx()).coverage.status, 'skipped');
  });
});

describe('TruffleHog', () => {
  const OUT = [
    '{"level":"info","msg":"running source"}',
    JSON.stringify({ SourceMetadata: { Data: { Git: { commit: '4f2a9c1e0000', file: 'src/config.js', line: 2 } } }, DetectorName: 'Github', Verified: true, Raw: 'ghp_SEGREDO', Redacted: 'ghp_SEG***' }),
    JSON.stringify({ SourceMetadata: { Data: { Git: { commit: 'aaaaaaa', file: 'b.js', line: 1 } } }, DetectorName: 'AWS', Verified: false, Raw: 'AKIA...' }),
  ].join('\n');

  it('desligado por padrão, com o motivo', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    const out = activeSecretsCheck.run(ctx());
    assert.equal(out.coverage.status, 'skipped');
    assert.match(out.coverage.reason ?? '', /log de auditoria/);
  });

  it('ligado: só segredos confirmados, crítico, e o segredo nunca entra no relatório', () => {
    repo = baseRepo();
    repo.branch('dev');
    repo.branch('feat', 'dev');
    repo.commit('x', { 'a.js': '1' });
    assert.equal(parseTrufflehog(OUT).length, 1);
    const cfg = mergeConfig(DEFAULT_CONFIG, { security: { verifySecrets: true } });
    let args: string[] = [];
    const out = activeSecretsCheck.run(ctx({ cfg, tools: (c, a) => ((args = a), ok(OUT)) }));
    const f = finalizeFindings(out.findings, cfg.security)[0]!;
    assert.equal(f.severity, 'critical');
    assert.equal(f.level, 'block');
    assert.doesNotMatch(JSON.stringify(out.findings), /SEGREDO|SEG\*\*\*/);
    assert.ok(args.includes('--only-verified') && args.includes('--since-commit'));
  });
});
