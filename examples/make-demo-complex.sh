#!/usr/bin/env bash
# Cenário de PRODUÇÃO COMPLEXO: SaaS de marmoraria (backend Node, Prisma, CI, lockfile, testes),
# ~150 módulos, >150 commits na dev e 17 branches abertas, cada uma com uma situação diferente.
# Cada situação tem resultado esperado em test/complex/expected.json (acertividade medida).
#
# Uso: examples/make-demo-complex.sh [pasta]   (padrão: /tmp/safemerge-demo-complex)
# Depois: cd <pasta> && safemerge matrix --no-fetch
#         cd <pasta> && git checkout feat/cobranca-pix && safemerge --no-fetch --prs-file prs.json
set -euo pipefail
DEMO="${1:-/tmp/safemerge-demo-complex}"
FILLER="${SAFEMERGE_DEMO_FILLER:-150}"
rm -rf "$DEMO" "$DEMO.remote.git"
git init -q --bare -b main "$DEMO.remote.git"
git init -q -b main "$DEMO"; cd "$DEMO"
git config commit.gpgsign false; git config core.autocrlf false
git remote add origin "$DEMO.remote.git"
export GIT_COMMITTER_NAME="CI" GIT_COMMITTER_EMAIL="ci@exemplo.com"
as() { local n="$1" e="$2"; shift 2; GIT_AUTHOR_NAME="$n" GIT_AUTHOR_EMAIL="$e" git commit -q -m "$*"; }
w() { mkdir -p "$(dirname "$1")"; cat > "$1"; }
ANA=("Ana Ribeiro" ana@exemplo.com); BRUNO=("Bruno Costa" bruno@exemplo.com); CARLA=("Carla Mendes" carla@exemplo.com)
DIEGO=("Diego Alves" diego@exemplo.com); EVA=("Eva Santos" eva@exemplo.com)

lock() { # lock <pacotes extras (JSON com vírgula na frente)> <versão do dayjs>
  cat <<JSON
{
  "name": "marmoraria",
  "version": "2.4.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "marmoraria", "version": "2.4.0" },
    "node_modules/dayjs": {
      "version": "${2:-1.11.10}",
      "resolved": "https://registry.npmjs.org/dayjs/-/dayjs-${2:-1.11.10}.tgz",
      "integrity": "sha512-vjAczensTgRcqDERK0SR2XMwsF/tSvnvlv6VcF2GIhg6Sx4yOIt/irsr1RDJsKiIyBzJDpCoXiWWq28MqH2cnQ=="
    }$1
  }
}
JSON
}

# ─── main: base do produto ──────────────────────────────────────────────────────────────────────
w package.json <<'EOF'
{ "name": "marmoraria", "version": "2.4.0", "private": true, "scripts": { "test": "node test/run.js" } }
EOF
lock "" > package-lock.json
w .env.example <<'EOF'
DATABASE_URL=
JWT_SECRET=
EOF
w .safemerge/config.json <<'EOF'
{
  "semantic": { "command": "node test/run.js", "timeoutSec": 120 },
  "domain": { "tenantModels": ["Orcamento", "Cliente", "OrdemServico"] }
}
EOF
w .github/workflows/ci.yml <<'EOF'
name: ci
on: pull_request
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
EOF
w prisma/migrations/20261101000000_init/migration.sql <<'EOF'
CREATE TABLE "Orcamento" (id serial PRIMARY KEY, "tenantId" int NOT NULL, total numeric);
EOF
w src/server/db.js <<'EOF'
// Banco falso para os testes: cada modelo responde com listas vazias.
const handler = { get: () => new Proxy({}, { get: () => async () => [] }) };
module.exports = { prisma: new Proxy({}, handler) };
EOF
w src/server/router.js <<'EOF'
const rotas = [];
const add = (method) => (path, ...handlers) => rotas.push({ method, path, handlers });
module.exports = { router: { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), use: () => {} }, rotas };
EOF
w src/server/auth.js <<'EOF'
function requireAuth(req, res, next) { if (!req.user) throw new Error('não autenticado'); next(); }
module.exports = { requireAuth };
EOF
w src/server/lib/log.js <<'EOF'
function log(mensagem) {
  return `[app] ${mensagem}`;
}
module.exports = { log };
EOF
w src/server/services/moeda.js <<'EOF'
function formatarMoeda(valor) {
  return 'R$ ' + valor.toFixed(2).replace('.', ',');
}
module.exports = { formatarMoeda };
EOF
w src/server/services/orcamento.js <<'EOF'
const { prisma } = require('../db');

// Total de um orçamento: soma preço × quantidade de cada item.
function calcularTotal(itens) {
  let total = 0;
  for (const item of itens) {
    total += item.preco * item.quantidade;
  }
  return total;
}

function listarOrcamentos(tenantId) {
  return prisma.orcamento.findMany({ where: { tenantId } });
}

module.exports = { calcularTotal, listarOrcamentos };
EOF
w src/server/routes/orcamento.js <<'EOF'
const { router } = require('../router');
const { requireAuth } = require('../auth');
const { listarOrcamentos } = require('../services/orcamento');

router.get('/orcamentos', requireAuth, (req) => listarOrcamentos(req.user.tenantId));
module.exports = router;
EOF
w src/legacy/relatorio.js <<'EOF'
// Relatório antigo em texto (será substituído).
function relatorioTexto(orcamentos) {
  return orcamentos.map((o) => `${o.id};${o.total}`).join('\n');
}
module.exports = { relatorioTexto };
EOF
for i in $(seq -w 1 150); do
  w "src/modulos/m$i.js" <<EOF
// Módulo $i do produto.
function executar$i(x) {
  return x + $((10#$i));
}
module.exports = { executar$i };
EOF
done
w test/run.js <<'EOF'
// Suíte mínima: roda todos os test/*.test.js; falha se algum lançar erro.
const fs = require('fs');
let falhas = 0;
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
  try { require('./' + f); console.log('ok   ' + f); } catch (e) { falhas++; console.error('FALHOU ' + f + ': ' + e.message); }
}
process.exit(falhas ? 1 : 0);
EOF
w test/orcamento.test.js <<'EOF'
const { calcularTotal } = require('../src/server/services/orcamento');
if (calcularTotal([{ preco: 10, quantidade: 2 }]) !== 20) throw new Error('total errado');
EOF
w test/moeda.test.js <<'EOF'
const { formatarMoeda } = require('../src/server/services/moeda');
if (formatarMoeda(10) !== 'R$ 10,00') throw new Error('formato errado');
EOF
git add -A && as "${ANA[@]}" "base do produto: orçamentos, rotas, migrações e testes"
git push -q origin main
git checkout -q -b dev

# ─── branches que saem do ponto de partida (antes das mudanças da dev) ──────────────────────────
git checkout -q -b feat/desconto-orcamento dev
w src/server/services/orcamento.js <<'EOF'
const { prisma } = require('../db');

// Total de um orçamento: soma preço × quantidade de cada item.
function calcularTotal(itens, descontoPercentual = 0) {
  let total = 0;
  for (const item of itens) {
    total += item.preco * item.quantidade;
  }
  return total * (1 - descontoPercentual / 100);
}

function listarOrcamentos(tenantId) {
  return prisma.orcamento.findMany({ where: { tenantId } });
}

module.exports = { calcularTotal, listarOrcamentos };
EOF
git add -A && as "${BRUNO[@]}" "orçamento aceita desconto percentual"

git checkout -q -b feat/desconto-progressivo dev
w src/server/services/orcamento.js <<'EOF'
const { prisma } = require('../db');

// Total de um orçamento: soma preço × quantidade de cada item.
function calcularTotal(itens) {
  let total = 0;
  for (const item of itens) {
    const desconto = item.quantidade >= 10 ? 0.95 : 1;
    total += item.preco * item.quantidade * desconto;
  }
  return total;
}

function listarOrcamentos(tenantId) {
  return prisma.orcamento.findMany({ where: { tenantId } });
}

module.exports = { calcularTotal, listarOrcamentos };
EOF
git add -A && as "${CARLA[@]}" "desconto progressivo por quantidade"

git checkout -q -b feat/recibo-pix dev
w src/server/services/recibo.js <<'EOF'
const { formatarMoeda } = require('./moeda');
function textoRecibo(valor) {
  return 'Recebemos ' + formatarMoeda(valor) + ' via Pix';
}
module.exports = { textoRecibo };
EOF
w test/recibo.test.js <<'EOF'
const { textoRecibo } = require('../src/server/services/recibo');
if (textoRecibo(1485) !== 'Recebemos R$ 1485,00 via Pix') throw new Error('recibo errado');
EOF
git add -A && as "${DIEGO[@]}" "recibo de pagamento Pix"

git checkout -q -b fix/log-formato dev
w src/server/lib/log.js <<'EOF'
function log(mensagem) {
  return `[app ${new Date(0).toISOString().slice(0, 10)}] ${mensagem}`;
}
module.exports = { log };
EOF
git add -A && as "${EVA[@]}" "log com data"

git checkout -q -b feat/relatorio-pdf dev
w src/legacy/relatorio.js <<'EOF'
// Relatório antigo em texto, agora com cabeçalho.
function relatorioTexto(orcamentos) {
  return ['id;total', ...orcamentos.map((o) => `${o.id};${o.total}`)].join('\n');
}
module.exports = { relatorioTexto };
EOF
git add -A && as "${ANA[@]}" "relatório com cabeçalho"

git checkout -q -b chore/deps dev
lock ",
    \"node_modules/zod\": {
      \"version\": \"3.23.8\",
      \"resolved\": \"https://registry.npmjs.org/zod/-/zod-3.23.8.tgz\",
      \"integrity\": \"sha512-XBx9AXhXktjUqnepgTiE5flcKIYWi/rme0Eaj+5Y0lftuGBq+jyRu/md4WnuxqgP1ubdpNCsYEYPxrzVHD8d6g==\"
    }" "1.11.12" > package-lock.json
git add -A && as "${BRUNO[@]}" "adiciona zod e atualiza dayjs"

git checkout -q -b feat/antiga dev
w docs/manual.md <<'EOF'
# Manual do usuário
EOF
git add -A && as "${CARLA[@]}" "manual do usuário"

# ─── a dev anda: refatorações, renomeações, migrações e muito histórico ─────────────────────────
git checkout -q dev
w src/server/services/orcamento.js <<'EOF'
const { prisma } = require('../db');

// Total de um orçamento, arredondado em centavos.
function calcularTotal(itens) {
  const bruto = itens.reduce((soma, i) => soma + i.preco * i.quantidade, 0);
  return Math.round(bruto * 100) / 100;
}

function listarOrcamentos(tenantId) {
  return prisma.orcamento.findMany({ where: { tenantId } });
}

module.exports = { calcularTotal, listarOrcamentos };
EOF
git add -A && as "${CARLA[@]}" "calcularTotal arredonda em centavos"
w src/server/services/moeda.js <<'EOF'
function formatarBRL(valor) {
  return 'R$ ' + valor.toFixed(2).replace('.', ',');
}
module.exports = { formatarBRL };
EOF
w test/moeda.test.js <<'EOF'
const { formatarBRL } = require('../src/server/services/moeda');
if (formatarBRL(10) !== 'R$ 10,00') throw new Error('formato errado');
EOF
git add -A && as "${ANA[@]}" "renomeia formatarMoeda para formatarBRL"
w prisma/migrations/20261110000000_status_os/migration.sql <<'EOF'
CREATE TABLE "OrdemServico" (id serial PRIMARY KEY, "tenantId" int NOT NULL, status text);
EOF
git add -A && as "${DIEGO[@]}" "migração: ordens de serviço"
git mv src/server/lib/log.js src/server/lib/logger.js
git commit -q -m "renomeia log.js para logger.js" --author "${EVA[0]} <${EVA[1]}>"
git rm -q src/legacy/relatorio.js
git commit -q -m "remove relatório legado" --author "${ANA[0]} <${ANA[1]}>"
lock "" "1.11.13" > package-lock.json
git add -A && as "${BRUNO[@]}" "atualiza dayjs"
for i in $(seq 1 "$FILLER"); do
  n=$(( (i % 150) + 1 )); f=$(printf "src/modulos/m%03d.js" "$n")
  printf '// ajuste %d\n' "$i" >> "$f"
  git add "$f"; git commit -q -m "ajuste $i no módulo $n" --author "${CARLA[0]} <${CARLA[1]}>"
done
git push -q origin dev

# ─── branches que saem da dev atual ─────────────────────────────────────────────────────────────
git checkout -q -b feat/agenda dev
w src/server/services/agenda.js <<'EOF'
const { prisma } = require('../db');
const { log } = require('../lib/logger');
function agendaDoDia(tenantId, dia) {
  log('agenda consultada');
  return prisma.ordemServico.findMany({ where: { tenantId, dia } });
}
const lembreteHoras = Number(process.env.AGENDA_LEMBRETE_HORAS || 24);
module.exports = { agendaDoDia, lembreteHoras };
EOF
w src/server/routes/agenda.js <<'EOF'
const { router } = require('../router');
const { requireAuth } = require('../auth');
const { agendaDoDia } = require('../services/agenda');
router.get('/agenda', requireAuth, (req) => agendaDoDia(req.user.tenantId, req.query.dia));
module.exports = router;
EOF
w test/agenda.test.js <<'EOF'
const { lembreteHoras } = require('../src/server/services/agenda');
if (lembreteHoras !== 24) throw new Error('lembrete padrão errado');
EOF
printf 'DATABASE_URL=\nJWT_SECRET=\nAGENDA_LEMBRETE_HORAS=24\n' > .env.example
git add -A && as "${EVA[@]}" "agenda do técnico"

git checkout -q -b feat/agenda-notificacoes feat/agenda
w src/server/services/notificacao.js <<'EOF'
const { lembreteHoras } = require('./agenda');
function mensagem(os) { return `Visita em ${lembreteHoras}h: OS ${os.id}`; }
module.exports = { mensagem };
EOF
w test/notificacao.test.js <<'EOF'
const { mensagem } = require('../src/server/services/notificacao');
if (!mensagem({ id: 7 }).includes('OS 7')) throw new Error('mensagem errada');
EOF
git add -A && as "${EVA[@]}" "notificação de visita (depende da agenda)"

git checkout -q -b feat/cobranca-pix dev
lock ",
    \"node_modules/pix-utils-br\": {
      \"version\": \"0.0.3\",
      \"resolved\": \"https://registry.npmjs.org/pix-utils-br/-/pix-utils-br-0.0.3.tgz\",
      \"integrity\": \"sha512-ZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw0KZGVtbw==\",
      \"hasInstallScript\": true
    },
    \"node_modules/qrcode-pix\": {
      \"version\": \"1.0.0\",
      \"resolved\": \"git+ssh://git@github.com/exemplo/qrcode-pix.git#4f2a9c1\"
    }" "1.11.13" > package-lock.json
w src/server/services/cobranca.js <<'EOF'
const { prisma } = require('../db');
async function cobrar(cliente, valor) {
  const chave = process.env.PIX_CHAVE_RECEBEDOR;
  console.log('cobrando cliente', cliente.cpf, valor);
  const ativos = await prisma.cliente.findMany({ where: { ativo: true } });
  return { chave, valor, ativos: ativos.length };
}
module.exports = { cobrar };
EOF
w src/server/routes/pix.js <<'EOF'
const { router } = require('../router');
const { cobrar } = require('../services/cobranca');
router.post('/pix/cobrancas', (req) => cobrar(req.body.cliente, req.body.valor));
module.exports = router;
EOF
w prisma/migrations/20261105000000_cobranca_pix/migration.sql <<'EOF'
CREATE TABLE "CobrancaPix" (id serial PRIMARY KEY, txid text);
EOF
git add -A && as "${DIEGO[@]}" "cobrança por Pix"

git checkout -q -b feat/ci-preview dev
w .github/workflows/preview.yml <<'EOF'
name: preview
on: pull_request_target
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: |
          echo "Preview de ${{ github.event.pull_request.title }}"
EOF
git add -A && as "${BRUNO[@]}" "preview automático dos PRs"

git checkout -q -b feat/migracao-garantia dev
w prisma/migrations/20261120120000_garantia/migration.sql <<'EOF'
CREATE TABLE "Garantia" (id serial PRIMARY KEY, meses int);
EOF
git add -A && as "${ANA[@]}" "migração: garantia"

git checkout -q -b feat/migracao-fotos dev
w prisma/migrations/20261120120000_fotos_obra/migration.sql <<'EOF'
CREATE TABLE "FotoObra" (id serial PRIMARY KEY, url text);
EOF
git add -A && as "${CARLA[@]}" "migração: fotos da obra"

git checkout -q -b feat/teste-instavel dev
w test/integracao.test.js <<'EOF'
// Teste que falha uma vez a cada duas execuções (simula dependência de tempo/rede).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const contador = path.join(execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim(), 'safemerge-demo-instavel');
const n = (fs.existsSync(contador) ? Number(fs.readFileSync(contador, 'utf8')) : 0) + 1;
fs.writeFileSync(contador, String(n));
if (n % 2 === 1) throw new Error('timeout ao falar com o serviço de CEP');
EOF
git add -A && as "${EVA[@]}" "teste de integração com CEP"

git checkout -q -b feat/integracao-mercadopago dev
# formato real: APP_USR-<16 dígitos>-<6 dígitos>-<32 hex>-<9 dígitos>, montado em partes
TOKEN="APP_USR-""7310492861552407""-112026-""b3c4d5e6f7a8b9c0""d1e2f3a4b5c6d7e8""-918273645"
w src/server/services/mercadopago.js <<EOF
module.exports = { accessToken: '${TOKEN}' };
EOF
git add -A && as "${BRUNO[@]}" "integração Mercado Pago"
w src/server/services/mercadopago.js <<'EOF'
module.exports = { accessToken: process.env.MP_ACCESS_TOKEN };
EOF
printf 'DATABASE_URL=\nJWT_SECRET=\nMP_ACCESS_TOKEN=\n' > .env.example
git add -A && as "${BRUNO[@]}" "token vai para variável de ambiente"

git checkout -q -b feat/galeria-fotos dev
w src/server/services/galeria.js <<'EOF2'
const { prisma } = require('../db');
function fotosDaObra(tenantId, obraId) {
  return prisma.ordemServico.findMany({ where: { tenantId, obraId } });
}
function miniatura(url) {
  return url.replace(/.jpg$/, '_thumb.jpg');
}
module.exports = { fotosDaObra, miniatura };
EOF2
w src/server/routes/galeria.js <<'EOF2'
const { router } = require('../router');
const { requireAuth } = require('../auth');
const { fotosDaObra } = require('../services/galeria');
router.get('/obras/:id/fotos', requireAuth, (req) => fotosDaObra(req.user.tenantId, req.params.id));
module.exports = router;
EOF2
w test/galeria.test.js <<'EOF2'
const { miniatura } = require('../src/server/services/galeria');
if (miniatura('a.jpg') !== 'a_thumb.jpg') throw new Error('miniatura errada');
EOF2
git add -A && as "${CARLA[@]}" "galeria de fotos da obra"

git checkout -q -b feat/relatorio-financeiro dev
w src/server/services/financeiro.js <<'EOF2'
const { prisma } = require('../db');
async function relatorio(tenantId, ids) {
  const linhas = [];
  for (const id of ids) {
    const os = await prisma.ordemServico.findUnique({ where: { id, tenantId } });
    linhas.push(os);
  }
  try {
    await fetch('https://api.exemplo.com/cotacao', { method: 'POST' });
  } catch (e) {
  }
  console.log('relatório gerado', linhas.length);
  return prisma.$queryRawUnsafe('SELECT * FROM "OrdemServico" WHERE "tenantId" = ' + tenantId);
}
module.exports = { relatorio };
EOF2
w test/financeiro.test.js <<'EOF2'
const { relatorio } = require('../src/server/services/financeiro');
if (typeof relatorio !== 'function') throw new Error('relatorio ausente');
EOF2
printf 'DATABASE_URL=postgres://admin:senha-de-producao@db:5432/app
' > .env
git add -A && as "${DIEGO[@]}" "relatório financeiro"

git checkout -q -b feat/ja-mergeada dev
w docs/changelog.md <<'EOF'
# Changelog
EOF
git add -A && as "${ANA[@]}" "changelog"
git checkout -q dev
git merge -q --no-ff feat/ja-mergeada -m "Merge feat/ja-mergeada"
git push -q origin dev

# ─── remoto e PRs abertos ───────────────────────────────────────────────────────────────────────
git push -q origin --all
git remote set-head origin main
w prs.json <<'EOF'
[
  { "number": 101, "title": "Desconto percentual no orçamento", "headRefName": "feat/desconto-orcamento", "isDraft": false, "url": "", "author": { "login": "bruno" } },
  { "number": 102, "title": "Desconto progressivo", "headRefName": "feat/desconto-progressivo", "isDraft": false, "url": "", "author": { "login": "carla" } },
  { "number": 103, "title": "Recibo Pix", "headRefName": "feat/recibo-pix", "isDraft": false, "url": "", "author": { "login": "diego" } },
  { "number": 104, "title": "Agenda do técnico", "headRefName": "feat/agenda", "isDraft": false, "url": "", "author": { "login": "eva" } },
  { "number": 105, "title": "Notificações da agenda", "headRefName": "feat/agenda-notificacoes", "isDraft": true, "url": "", "author": { "login": "eva" } },
  { "number": 106, "title": "Cobrança Pix", "headRefName": "feat/cobranca-pix", "isDraft": false, "url": "", "author": { "login": "diego" } }
]
EOF
echo "prs.json" >> .git/info/exclude
git checkout -q dev
echo "ok: $(git branch | wc -l | tr -d ' ') branches, $(git rev-list --count dev) commits na dev"
