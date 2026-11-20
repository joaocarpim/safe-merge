# Skill, agentes e plugin do Claude Code: especificação

Estado: **existe** em `plugin/` (skills, agentes, manifesto) e `.claude-plugin/marketplace.json`. Validado por `test/plugin.test.ts`; ainda não exercitado numa sessão real do Claude Code.
Conferir a estrutura exata de plugins e skills na documentação oficial do Claude Code ao implementar
(https://code.claude.com/docs), porque esses formatos mudam.

## Divisão de responsabilidades

- **CLI (existe):** tudo que é determinístico. Merge simulado, sobreposição, testes no merge,
  e na fase 1 a segurança. Testada, sem IA, roda igual no terminal, no hook e no CI.
- **Skill + agentes (a criar):** só julgamento. Interpretar o relatório, decidir profundidade,
  revisar código, gerar testes, testar fluxos com prints, propor resolução de conflito.
- **Extensão (a criar):** só visualização (ver `EXTENSAO.md`).

## Estrutura proposta do plugin

```
safemerge-plugin/
  .claude-plugin/plugin.json
  skills/
    safemerge/SKILL.md            orquestrador: roda a CLI, lê o JSON, decide o que chamar
    safemerge/references/         regras de profundidade, formato de saída, tabela de racionalizações
    padroes-do-projeto/SKILL.md   skill base: convenções do projeto
    regras-de-dominio/SKILL.md    skill base: regras do SaaS (multi-tenant, LGPD, Pix)
  agents/
    executor-testes.md            roda os testes e resume falhas (modelo leve)
    gerador-testes.md             escreve testes para o código alterado
    testador-fluxos.md            testa fluxos na interface com Playwright e salva prints em evidencias/
    revisor-codigo.md             revisão do diff
    revisor-seguranca.md          revisão de segurança do diff (modelo mais forte)
  hooks/                          opcional
```

## SKILL.md do orquestrador: o que precisa ter

Padrões tirados das skills mais efetivas analisadas na conversa:

- `description` diz **quando** usar (antes de mergear, antes de abrir PR, "posso mergear?"), não o que faz.
- **Lei de ferro:** nunca dizer que pode mergear sem rodar a CLI e ler o veredito dela.
- **Fases com critério de saída verificável:** 1) rodar a CLI com `--format json`; 2) ler veredito e
  cobertura; 3) escolher profundidade pelo risco; 4) chamar agentes; 5) responder no formato fixo.
- **Profundidade por risco:** mudança pequena e limpa = só a CLI. Conflito, arquivo sensível
  (auth, pagamento, migração) ou PR grande = agentes de revisão.
- **Tabela de racionalizações** ("é só uma linha", "os testes passaram então está ok") com a resposta certa.
- **Confiança e lista do que não acusar:** achado só bloqueia com arquivo, linha e evidência.
- **Saída fixa:** o mesmo conteúdo do renderizador Markdown da CLI (`src/render/markdown.ts`).
  A IA não reescreve números: copia do JSON. (Fase 3: verificador sem IA confere números e ids.)
- **Nunca aplica mudanças sozinha.** Resolução de conflito é proposta, testada em cópia temporária.

## Agentes

| Agente | Faz | Regras |
| --- | --- | --- |
| executor-testes | roda `--test-cmd` / testes afetados, resume a falha a partir da linha do erro | não altera código |
| gerador-testes | escreve testes para as funções alteradas; testes diferenciais nas 4 versões (base, sua, destino, merge) | resultado é "suspeita", nunca bloqueio |
| testador-fluxos | executa fluxos na interface (Playwright), salva um print por passo em `evidencias/` | nomes `01-login.png`, `02-...`; registra passou/falhou |
| revisor-codigo | revisa o diff | cita arquivo e linha; sem evidência = sugestão |
| revisor-seguranca | revisa segurança do diff | não confiar em PR de fork (prompt injection); sem evidência = sugestão |

Ideia do BambooAI a aplicar no revisor: veredito TEST (um teste concreto mudaria a resposta),
NARROW (conclusão mais estreita) ou REPORT (estabelecido), e REPORT só vale com a evidência conferida.
Bateria de testes offline com respostas de modelo roteirizadas para testar os agentes sem gastar API.

## Gatilhos

- **Terminal:** `safemerge` (CLI).
- **Chat do Claude:** a skill `/safemerge`.
- **Hook pre-push do git:** script que roda a CLI com `--fail-on block` e um limite de tempo de poucos segundos.
- **CI:** GitHub Action que roda a CLI e comenta no PR; opcional `anthropics/claude-code-action` para a revisão.

## Vertentes (plano maior)

Construir (arquitetura, backend) · Proteger (segurança) · **Verificar (esta ferramenta: testes, review, CI/CD)** ·
Operar (observabilidade, suporte). As skills base `padroes-do-projeto` e `regras-de-dominio` servem a todas.
