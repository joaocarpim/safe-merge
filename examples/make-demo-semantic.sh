#!/usr/bin/env bash
# Cenário de conflito SEMÂNTICO: o git junta sem conflito de texto, mas o resultado quebra.
#  - a dev renomeia formatarMoeda para formatarBRL
#  - a sua branch cria um arquivo novo que ainda chama formatarMoeda
# Uso: examples/make-demo-semantic.sh [pasta]   (padrão: /tmp/safemerge-demo-sem)
# Depois: cd <pasta> && safemerge --test-cmd "node check.js"
set -euo pipefail
DEMO="${1:-/tmp/safemerge-demo-sem}"
rm -rf "$DEMO" "$DEMO.remote.git"
git init -q --bare -b main "$DEMO.remote.git"
git init -q -b main "$DEMO"; cd "$DEMO"
git config commit.gpgsign false; git config core.autocrlf false
git remote add origin "$DEMO.remote.git"
as() { local n="$1" e="$2"; shift 2; GIT_AUTHOR_NAME="$n" GIT_AUTHOR_EMAIL="$e" GIT_COMMITTER_NAME="$n" GIT_COMMITTER_EMAIL="$e" git commit -q -m "$*"; }

mkdir -p src/orcamento
cat > check.js <<'JS'
// "Suíte de testes" mínima: carrega todos os módulos de src/ e executa o que eles fazem ao carregar.
const fs = require('fs');
for (const f of fs.readdirSync('src/orcamento').filter((n) => n.endsWith('.js'))) require('./src/orcamento/' + f);
console.log('ok: todos os módulos carregaram');
JS
cat > src/orcamento/moeda.js <<'JS'
function formatarMoeda(valor) {
  return 'R$ ' + valor.toFixed(2).replace('.', ',');
}
module.exports = { formatarMoeda };
JS
git add -A && as "Joao Lima" joao@exemplo.com "base: formatação de moeda"
git push -q origin main; git checkout -q -b dev; git push -q origin dev

cat > src/orcamento/moeda.js <<'JS'
function formatarBRL(valor) {
  return 'R$ ' + valor.toFixed(2).replace('.', ',');
}
module.exports = { formatarBRL };
JS
git add -A && as "Maria Souza" maria@exemplo.com "renomeia formatarMoeda para formatarBRL"
git push -q origin dev

git checkout -q -b feature/aprovacao-orcamento main
cat > src/orcamento/aprovacao.js <<'JS'
const { formatarMoeda } = require('./moeda');
const resumo = formatarMoeda(1485);
if (resumo !== 'R$ 1485,00') throw new Error('resumo inesperado: ' + resumo);
module.exports = { resumo };
JS
git add -A && as "Joao Lima" joao@exemplo.com "tela de aprovação mostra o total formatado"
echo ok
