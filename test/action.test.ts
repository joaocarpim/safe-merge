import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');

/** Linhas de `run:` (inclusive blocos `run: |`) de um YAML de action/workflow. */
function runLines(yaml: string): string[] {
  const out: string[] = [];
  let blockIndent: number | null = null;
  for (const line of yaml.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) {
        out.push(line);
        continue;
      }
      blockIndent = null;
    }
    const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (m) {
      if (m[2] === '|' || m[2] === '>') blockIndent = m[1]!.length;
      else out.push(m[2]!);
    }
  }
  return out;
}

describe('GitHub Action', () => {
  for (const file of ['action.yml', 'docs/exemplos/safemerge-workflow.yml']) {
    it(`${file}: nenhuma expressão \${{ }} dentro de run: (injeção de template)`, () => {
      const yaml = readFileSync(join(root, file), 'utf8');
      const bad = runLines(yaml).filter((l) => l.includes('${{'));
      assert.deepEqual(bad, []);
    });
  }

  it('o exemplo usa pull_request, não pull_request_target, e permissões mínimas', () => {
    // só as linhas de configuração: o comentário do arquivo explica por que não usar pull_request_target
    const yaml = readFileSync(join(root, 'docs/exemplos/safemerge-workflow.yml'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    assert.match(yaml, /^\s+pull_request:/m);
    assert.doesNotMatch(yaml, /pull_request_target/);
    assert.match(yaml, /contents: read/);
  });

  it('a action chama opções que existem na CLI', () => {
    const yaml = readFileSync(join(root, 'action.yml'), 'utf8');
    const cli = readFileSync(join(root, 'src/cli.ts'), 'utf8');
    for (const m of yaml.matchAll(/(?<![\w-])--([a-z][a-z-]+)/g)) {
      if (['quiet', 'no-audit', 'no-fund', 'body-file', 'edit-last'].includes(m[1]!)) continue; // git, npm e gh
      assert.ok(cli.includes(`'${m[1]}'`) || cli.includes(`${m[1]}:`), `--${m[1]} não existe na CLI`);
    }
  });
});

describe('anotações do GitHub Actions', () => {
  it('cada achado e bloco em conflito vira ::error/::warning com arquivo e linha, com escape', async () => {
    const { renderGithub } = await import('../src/render/github.ts');
    const report = {
      primary: 'dev',
      findings: [{ id: 'SM-12345678', title: 'Pacote novo, com script', message: 'linha 1\nlinha 2 100%', evidence: 'x: y', file: 'package-lock.json', line: 17, level: 'block' }],
      targets: [{ target: 'dev', conflicts: [{ path: 'src/a,b.js', kind: 'contents', lastTouchOnTarget: null, hunks: [{ oursLine: 2, oursTotal: 3, theirs: ['DEV'] }] }] }],
      verdict: { level: 'block', reasons: [{ level: 'block', text: '1 arquivo em conflito com dev' }] },
    };
    const out = renderGithub(report as never).trim().split('\n');
    assert.equal(out[0], '::error file=package-lock.json,line=17,title=safemerge SM-12345678%3A Pacote novo%2C com script::linha 1%0Alinha 2 100%25%0Aevidência: x: y');
    assert.match(out[1]!, /^::error file=src\/a%2Cb\.js,line=2,endLine=4,title=safemerge%3A conflito com dev::/);
    assert.match(out[2]!, /^::error title=safemerge%3A não mergear::1 arquivo em conflito com dev$/);
  });
});
