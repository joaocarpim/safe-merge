#!/usr/bin/env bash
# Cria um repositório de demonstração (orçamentos de uma marmoraria) com:
#  - conflito de texto da sua branch com a dev
#  - arquivo alterado dos dois lados (juntado sozinho)
#  - outra branch que vai conflitar com a sua, e outra que só empilha
# Uso: examples/make-demo.sh [pasta]   (padrão: /tmp/safemerge-demo)
set -euo pipefail
DEMO="${1:-/tmp/safemerge-demo}"
rm -rf "$DEMO" "$DEMO.remote.git"
git init -q --bare -b main "$DEMO.remote.git"
git init -q -b main "$DEMO"
cd "$DEMO"
git config commit.gpgsign false; git config core.autocrlf false
git remote add origin "$DEMO.remote.git"

as() { # as "Nome" "email" mensagem...
  local name="$1" email="$2"; shift 2
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" git commit -q -m "$*"
}

mkdir -p src/orcamento src/os docs
cat > src/orcamento/service.js <<'JS'
// Calcula o total de um orçamento
function calcularTotal(itens) {
  let total = 0;
  for (const item of itens) {
    total += item.preco * item.quantidade;
  }
  return total;
}

module.exports = { calcularTotal };
JS
cat > src/os/service.js <<'JS'
// Ordens de serviço
const STATUS = ['aberta', 'em_execucao', 'concluida'];

function abrirOs(orcamentoId) {
  return { orcamentoId, status: STATUS[0] };
}

function concluirOs(os) {
  return { ...os, status: STATUS[2] };
}

module.exports = { abrirOs, concluirOs };
JS
echo '{}' > package-lock.json
git add -A && as "Joao Lima" joao@exemplo.com "base: orçamento e ordem de serviço"
git push -q origin main
git checkout -q -b dev && git push -q origin dev

# --- dev anda: Maria refatora o cálculo e ajusta o topo da OS; mais commits vão depois
cat > src/orcamento/service.js <<'JS'
// Calcula o total de um orçamento
function calcularTotal(itens) {
  const bruto = itens.reduce((soma, i) => soma + i.preco * i.quantidade, 0);
  return Math.round(bruto * 100) / 100;
}

module.exports = { calcularTotal };
JS
git add -A && as "Maria Souza" maria@exemplo.com "refatora calcularTotal e arredonda em centavos"
sed -i "s#^// Ordens de serviço#// Ordens de serviço (v2: status em português)#" src/os/service.js
git add -A && as "Maria Souza" maria@exemplo.com "documenta versão do módulo de OS"
for i in 1 2 3 4 5 6; do echo "nota $i" >> docs/changelog.md; git add -A; as "Carlos Dias" carlos@exemplo.com "docs: changelog $i"; done
git push -q origin dev

# --- outra PR (#88): Carlos mexe no retorno do mesmo cálculo => vai conflitar com a sua
git checkout -q -b fix/desconto-itens main
cat > src/orcamento/service.js <<'JS'
// Calcula o total de um orçamento
function calcularTotal(itens) {
  let total = 0;
  for (const item of itens) {
    total += item.preco * item.quantidade;
  }
  return Math.max(total, 0);
}

module.exports = { calcularTotal };
JS
git add -A && as "Carlos Dias" carlos@exemplo.com "total nunca fica negativo"
git push -q origin fix/desconto-itens

# --- outra PR (#92): agenda mexe na OS, mas num trecho que não encosta no seu => junta sem conflito
git checkout -q -b feature/agenda-tecnico main
sed -i "s#return { orcamentoId, status: STATUS\[0\] };#return { orcamentoId, status: STATUS[0], agendadaPara: null };#" src/os/service.js
git add -A && as "Paula Rocha" paula@exemplo.com "OS nasce com campo de agendamento"
git push -q origin feature/agenda-tecnico

# --- a sua branch (João): aprovação de orçamento com desconto percentual
git checkout -q -b feature/aprovacao-orcamento main
cat > src/orcamento/service.js <<'JS'
// Calcula o total de um orçamento
function calcularTotal(itens, descontoPercentual = 0) {
  let total = 0;
  for (const item of itens) {
    total += item.preco * item.quantidade;
  }
  return total * (1 - descontoPercentual / 100);
}

module.exports = { calcularTotal };
JS
git add -A && as "Joao Lima" joao@exemplo.com "orçamento aceita desconto percentual"
sed -i "s#^function concluirOs(os) {#function aprovarOrcamento(os) {\n  return { ...os, aprovada: true };\n}\n\nfunction concluirOs(os) {#; s#^module.exports = { abrirOs, concluirOs };#module.exports = { abrirOs, aprovarOrcamento, concluirOs };#" src/os/service.js
git add -A && as "Joao Lima" joao@exemplo.com "OS passa a registrar aprovação do orçamento"
echo ok
