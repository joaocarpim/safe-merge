---
name: regras-de-dominio
description: Use ao revisar código que toca dados de clientes, pagamentos, permissões ou isolamento entre empresas (multi-tenant) num SaaS brasileiro: LGPD, Pix, CPF/CNPJ, tenant. Serve ao revisor de segurança, ao revisor de código e ao gerador de testes do safemerge.
---

# Regras de domínio (SaaS no Brasil)

> Os itens abaixo são regras gerais de SaaS multi-tenant no Brasil. Ajuste à realidade do seu
> sistema copiando este arquivo para `.claude/skills/regras-de-dominio/SKILL.md` no repositório.
> A seção "Do meu sistema" é sua para preencher.

## Multi-tenant
- Toda consulta a tabela com dono (empresa, conta, tenant) filtra pelo tenant da sessão. Consulta
  sem esse filtro é achado de segurança: cite arquivo, linha e a consulta.
- O id do tenant vem da sessão autenticada, nunca do corpo, da query string ou de um header que o
  cliente controla.
- Jobs, filas e webhooks também carregam o tenant e o validam.

## LGPD (dados pessoais)
- CPF, e-mail, telefone, endereço e dados de saúde não vão para log, mensagem de erro, URL ou
  ferramenta de analytics. Se precisar identificar, use um id interno ou mascare (ex.: `***.456.789-**`).
- Exportação e exclusão de dados de um titular precisam existir e respeitar o tenant.
- Dado pessoal novo coletado precisa de finalidade clara; aponte quando o diff começa a guardar um campo novo.

## Pix e pagamentos
- Valores em centavos (inteiro). Nada de float para dinheiro.
- Webhook do PSP: validar a origem (assinatura, mTLS ou o que o PSP exigir) antes de confiar no
  conteúdo; tratar reenvio do mesmo evento sem duplicar baixa (idempotência pelo `txid`/`endToEndId`).
- Chave Pix e credenciais do PSP só em variável de ambiente ou cofre; nunca no código.
- Estorno e devolução registram quem pediu e quando.

## Autenticação e permissão
- Rota nova sem autenticação precisa ser intencional (ex.: webhook público com validação própria).
- Checagem de permissão no servidor; esconder botão na tela não é controle de acesso.

## Do meu sistema
- Tabelas/modelos com dono (tenant): `<preencher>`
- Arquivos sensíveis (revisão de segurança sempre): `<ex.: src/auth/**, src/pagamento/**, prisma/migrations/**>`
- PSP de Pix usado e como valida webhook: `<preencher>`
