import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { VERSION } from '../src/version.ts';

const root = join(import.meta.dirname, '..');
const plugin = join(root, 'plugin');

function frontmatter(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${path} sem frontmatter`);
  return Object.fromEntries(
    m[1]!.split('\n').filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  );
}

describe('plugin do Claude Code', () => {
  it('manifesto e marketplace válidos, versão igual à do pacote', () => {
    const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'safemerge');
    assert.equal(manifest.version, pkg.version);
    assert.equal(VERSION, pkg.version, 'src/version.ts precisa acompanhar o package.json');
    const market = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.ok(existsSync(join(root, market.plugins[0].source, '.claude-plugin/plugin.json')));
  });

  it('cada skill tem name igual à pasta e description dizendo quando usar', () => {
    const skills = readdirSync(join(plugin, 'skills'));
    assert.deepEqual(skills.sort(), ['padroes-do-projeto', 'regras-de-dominio', 'safemerge']);
    for (const s of skills) {
      const fm = frontmatter(join(plugin, 'skills', s, 'SKILL.md'));
      assert.equal(fm.name, s);
      assert.match(fm.description ?? '', /^Use /, `${s}: description deve começar dizendo quando usar`);
    }
  });

  it('os 5 agentes existem com nome, descrição, ferramentas e modelo', () => {
    const agents = readdirSync(join(plugin, 'agents')).map((f) => f.replace(/\.md$/, '')).sort();
    assert.deepEqual(agents, ['executor-testes', 'gerador-testes', 'revisor-codigo', 'revisor-seguranca', 'testador-fluxos']);
    for (const a of agents) {
      const fm = frontmatter(join(plugin, 'agents', `${a}.md`));
      assert.equal(fm.name, a);
      assert.ok(fm.description && fm.tools && fm.model, `${a}: frontmatter incompleto`);
    }
    // quem só revisa ou roda testes não pode escrever arquivos
    for (const a of ['executor-testes', 'revisor-codigo', 'revisor-seguranca']) {
      assert.doesNotMatch(frontmatter(join(plugin, 'agents', `${a}.md`)).tools!, /Write|Edit/);
    }
  });

  it('todo subcomando citado no plugin existe na CLI, e o que a skill lê existe no relatório', () => {
    const cli = readFileSync(join(root, 'src/cli.ts'), 'utf8');
    const texts = [
      ...readdirSync(join(plugin, 'skills/safemerge/references')).map((f) => join(plugin, 'skills/safemerge/references', f)),
      join(plugin, 'skills/safemerge/SKILL.md'),
    ].map((p) => readFileSync(p, 'utf8'));
    for (const t of texts) {
      for (const m of t.matchAll(/safemerge ([a-z]+-[a-z]+|replay)\b/g)) assert.ok(cli.includes(`'${m[1]}'`) || cli.includes(`${m[1]}:`), `subcomando ${m[1]} não existe`);
      for (const m of t.matchAll(/--([a-z][a-z-]+)/g)) assert.ok(cli.includes(`'${m[1]}'`) || cli.includes(`${m[1]}:`), `opção --${m[1]} não existe na CLI`);
    }
    const analyze = readFileSync(join(root, 'src/analyze.ts'), 'utf8');
    for (const field of ['verdict', 'findings', 'coverage', 'targets', 'semantic']) assert.ok(analyze.includes(`${field}:`));
  });
});
