# Formato da resposta

Use o mesmo conteúdo do Markdown da CLI (`npx safemerge --format markdown`). Você pode resumir,
mas não mudar números, ids ou o veredito. Estrutura:

```
**<🔴 NÃO MERGEAR | 🟡 MERGEAR COM ATENÇÃO | 🟢 PODE MERGEAR>** (veredito da CLI)

Motivos (do verdict.reasons, na ordem):
- ...

Sem cobertura (coverage com missing-tool/error):
- <verificação>: <motivo>

O que os agentes acharam (só se rodaram; cada item com arquivo:linha e evidência):
- [arquivo:linha] ...

Próximo passo:
- <uma ação concreta: resolver conflito em X, revogar segredo Y, renumerar migração Z>
```

Depois de escrever, salve em `resposta.md` e rode:

```
npx safemerge verify-text --report .safemerge/ultimo.json resposta.md
```

Só envie se sair com 0. Se algo não conferir, corrija copiando do JSON.
