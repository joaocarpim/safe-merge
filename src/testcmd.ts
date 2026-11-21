import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Comando de testes provável do projeto, só para SUGERIR (nunca roda sozinho: rodar testes executa
 * código do repositório, e isso tem de ser escolha de quem roda o safemerge).
 */
export function detectTestCommand(root: string): string | null {
  const has = (p: string) => existsSync(join(root, p));
  const read = (p: string) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return '';
    }
  };
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
      const t = pkg.scripts?.test;
      if (t && !/no test specified/.test(t)) {
        const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
        return runner === 'npm' ? 'npm test' : `${runner} test`;
      }
    } catch {
      /* package.json inválido: segue */
    }
  }
  if (has('manage.py') && !/\[tool\.pytest|pytest/.test(read('pyproject.toml') + read('requirements.txt') + read('requirements-dev.txt'))) return 'python manage.py test';
  if (has('pytest.ini') || has('conftest.py') || /\[tool\.pytest/.test(read('pyproject.toml')) || /\[tool:pytest\]/.test(read('setup.cfg')) || /pytest/.test(read('requirements.txt') + read('requirements-dev.txt'))) return 'pytest';
  if (has('pubspec.yaml')) return /sdk:\s*flutter/.test(read('pubspec.yaml')) ? 'flutter test' : 'dart test';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('gradlew')) return './gradlew test';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('Gemfile') && has('spec')) return 'bundle exec rspec';
  if (has('composer.json') && has('phpunit.xml')) return 'vendor/bin/phpunit';
  return null;
}
