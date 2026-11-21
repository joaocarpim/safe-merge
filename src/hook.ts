import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOut } from './git.js';

export const HOOK_MARK = '# instalado por: safemerge install-hook';

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Script do hook pre-push. Roda o modo rápido (sem fetch, sem gh, sem testes e sem a fase de
 * segurança, que pode chamar ferramentas lentas) para caber em poucos segundos.
 * Só bloqueia com veredito "não mergear"; erro do safemerge nunca impede o push.
 */
export function hookScript(command: string[], timeoutSec: number): string {
  const cmd = command.map(sq).join(' ');
  return `#!/bin/sh
${HOOK_MARK}
# Para pular uma vez: git push --no-verify. Para remover: apague este arquivo.
# Se o comando for o Node embutido num editor baseado em Electron, esta variável o faz
# agir como Node. Para um Node comum ela não muda nada.
export ELECTRON_RUN_AS_NODE=1
SAFEMERGE_TIMEOUT="\${SAFEMERGE_TIMEOUT:-${timeoutSec}}"
run() {
  if command -v timeout >/dev/null 2>&1; then timeout "$SAFEMERGE_TIMEOUT" ${cmd} "$@"; else ${cmd} "$@"; fi
}
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_ref" in refs/heads/*) ;; *) continue ;; esac
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue
  branch="\${local_ref#refs/heads/}"
  run --head "$branch" --no-fetch --no-prs --no-security --fail-on block --no-color </dev/null
  code=$?
  if [ $code -eq 1 ]; then
    echo "safemerge: \\"$branch\\" não deve ser mergeada como está (veja acima). Push cancelado; use --no-verify para enviar mesmo assim." >&2
    status=1
  elif [ $code -ne 0 ]; then
    echo "safemerge: não consegui analisar \\"$branch\\" (código $code); push liberado." >&2
  fi
done
exit $status
`;
}

export interface InstallResult {
  path: string;
  backup?: string;
}

/** Instala o hook. Não sobrescreve hook de outra ferramenta sem --force (e guarda uma cópia). */
export function installHook(repoDir: string, command: string[], opts: { force?: boolean; timeoutSec?: number } = {}): InstallResult {
  const hooksDir = gitOut(repoDir, ['rev-parse', '--git-path', 'hooks']);
  const dir = hooksDir.startsWith('/') || /^[A-Za-z]:/.test(hooksDir) ? hooksDir : join(repoDir, hooksDir);
  const path = join(dir, 'pre-push');
  let backup: string | undefined;
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (!current.includes(HOOK_MARK)) {
      if (!opts.force) throw new Error(`já existe um hook pre-push que não é do safemerge (${path}). Use --force para substituir (uma cópia fica em pre-push.antes-do-safemerge).`);
      backup = `${path}.antes-do-safemerge`;
      renameSync(path, backup);
    }
  }
  writeFileSync(path, hookScript(command, opts.timeoutSec ?? 20));
  chmodSync(path, 0o755);
  return { path, backup };
}

/** Comando que o hook vai chamar: o mesmo Node e o mesmo arquivo da CLI que está rodando agora. */
export function currentCommand(): string[] {
  const script = process.argv[1];
  if (!script) return ['safemerge'];
  // Rodando no Node embutido de um editor (Electron), o programa só age como Node com esta opção
  const electron = process.versions.electron ? ['--ms-enable-electron-run-as-node'] : [];
  return [process.execPath, ...process.execArgv, script, ...electron];
}
