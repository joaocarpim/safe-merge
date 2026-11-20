---
name: padroes-do-projeto
description: Use ao revisar, escrever ou gerar código e testes neste projeto, para seguir as convenções dele (estrutura de pastas, nomes, comandos de build e teste, estilo). Serve a todas as skills e agentes do safemerge.
---

# Padrões do projeto

> **Modelo para preencher.** O plugin traz este arquivo com perguntas, não com respostas.
> Copie para `.claude/skills/padroes-do-projeto/SKILL.md` no seu repositório e preencha.
> Enquanto estiver vazio, os agentes devem descobrir lendo o código e dizer que estão supondo.

## Comandos
- Instalar dependências: `<ex.: npm ci>`
- Build: `<ex.: npm run build>`
- Testes (todos): `<ex.: npm test>`
- Testes de um arquivo: `<ex.: npx vitest run caminho>`
- Testes de interface (Playwright): `<ex.: npx playwright test>`

Use os mesmos em `.safemerge/config.json` (`semantic.command`, `semantic.buildCommand`).

## Estrutura
- Onde fica cada camada (rotas, serviços, acesso a dados, telas): `<preencher>`
- Onde ficam os testes e como se chamam: `<ex.: ao lado do arquivo, *.test.ts>`
- Migrações de banco: `<ex.: prisma/migrations>`

## Convenções que a revisão deve cobrar
- `<ex.: toda rota nova passa pelo middleware de autenticação>`
- `<ex.: valores em centavos (inteiro), nunca float>`
- `<ex.: datas em UTC no banco, America/Sao_Paulo só na tela>`

## Limites da revisão
- PR grande a partir de quantas linhas alteradas: `<ex.: 400>`
- Pastas que não precisam de revisão: `<ex.: gerados, vendor>`
