#!/usr/bin/env bash
# Cenário de SEGURANÇA E DEPLOY: a branch não tem conflito de texto, mas traz problemas plantados:
#  - um token commitado e apagado no commit seguinte (continua no histórico)   → gitleaks
#  - dependência nova com script de instalação e outra vinda de um repositório git → package-lock
#  - workflow com pull_request_target e o título do PR interpolado num "run:"     → zizmor
#  - migração com o mesmo número de uma que já entrou na dev                      → migrações
#  - variável de ambiente nova que não está no .env.example                       → variáveis
# Uso: examples/make-demo-security.sh [pasta]   (padrão: /tmp/safemerge-demo-sec)
# Depois: cd <pasta> && safemerge --no-fetch --no-prs
set -euo pipefail
DEMO="${1:-/tmp/safemerge-demo-sec}"
rm -rf "$DEMO" "$DEMO.remote.git"
git init -q --bare -b main "$DEMO.remote.git"
git init -q -b main "$DEMO"; cd "$DEMO"
git config commit.gpgsign false; git config core.autocrlf false
git remote add origin "$DEMO.remote.git"
as() { local n="$1" e="$2"; shift 2; GIT_AUTHOR_NAME="$n" GIT_AUTHOR_EMAIL="$e" GIT_COMMITTER_NAME="$n" GIT_COMMITTER_EMAIL="$e" git commit -q -m "$*"; }

lock() { # lock <pacotes extras em JSON, já com vírgula na frente ou vazio>
  cat <<JSON
{
  "name": "marmoraria",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "marmoraria", "version": "1.0.0" },
    "node_modules/dayjs": {
      "version": "1.11.13",
      "resolved": "https://registry.npmjs.org/dayjs/-/dayjs-1.11.13.tgz",
      "integrity": "sha512-oaMBel6gjolK862uaPQOVTA7q3TZhuSvuMQAAglQDOWYO9A91IrAOUJEyKVlqJlHE0vq5p5UXxzdPfMH/x6xNg=="
    }$1
  }
}
JSON
}

mkdir -p src/pagamento db/migrations
lock "" > package-lock.json
echo 'DATABASE_URL=' > .env.example
cat > src/pagamento/pix.js <<'JS'
function gerarCobranca(valor) {
  return { valor, moeda: 'BRL' };
}
module.exports = { gerarCobranca };
JS
echo 'create table orcamento (id serial primary key);' > db/migrations/001_orcamento.sql
git add -A && as "Joao Lima" joao@exemplo.com "base"
git push -q origin main; git checkout -q -b dev

echo 'alter table orcamento add column desconto numeric;' > db/migrations/002_desconto.sql
git add -A && as "Maria Souza" maria@exemplo.com "desconto no orçamento"
git push -q origin dev

git checkout -q -b feature/cobranca-pix dev~1

# 1) token commitado e "removido" no commit seguinte. Montado em partes para que este
#    script não contenha o padrão de um token (e não dispare scanners no próprio safemerge).
TOKEN="gh""p_""$(printf 'S4f3M3rg3D3m0%.0s' 1 2 3 | cut -c1-36)"
cat > src/pagamento/config.js <<JS
module.exports = { githubToken: '${TOKEN}' };
JS
git add -A && as "Joao Lima" joao@exemplo.com "config de integração"
git rm -q src/pagamento/config.js
git commit -q -m "remove config" --author "Joao Lima <joao@exemplo.com>"

# 2) dependências novas: uma com postinstall, outra vinda direto de um repositório git
lock ',
    "node_modules/pix-utils-br": {
      "version": "0.0.3",
      "resolved": "https://registry.npmjs.org/pix-utils-br/-/pix-utils-br-0.0.3.tgz",
      "integrity": "sha512-ZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw==",
      "hasInstallScript": true
    },
    "node_modules/qrcode-pix": {
      "version": "1.0.0",
      "resolved": "git+ssh://git@github.com/exemplo/qrcode-pix.git#4f2a9c1"
    }' > package-lock.json

# 3) workflow que roda com permissões do repositório e interpola o título do PR no shell
mkdir -p .github/workflows
cat > .github/workflows/preview.yml <<'YML'
name: preview
on: pull_request_target
jobs:
  comentar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: echo "Preview de ${{ github.event.pull_request.title }}"
YML

# 4) migração com o mesmo número da que já entrou na dev
echo 'create table cobranca_pix (id serial primary key, txid text);' > db/migrations/002_cobranca_pix.sql

# 5) variável de ambiente nova, sem .env.example
cat > src/pagamento/pix.js <<'JS'
function gerarCobranca(valor) {
  const chave = process.env.PIX_CHAVE_RECEBEDOR;
  return { valor, moeda: 'BRL', chave };
}
module.exports = { gerarCobranca };
JS
git add -A && as "Joao Lima" joao@exemplo.com "cobrança por Pix"
echo ok
