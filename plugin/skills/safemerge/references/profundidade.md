# Profundidade por risco

Comece pela linha mais alta da tabela que se aplicar.

| Situação (do JSON e do diff) | Profundidade |
| --- | --- |
| `verdict.level` = `block` por conflito com o destino | Explicar o conflito; oferecer resolução assistida (`resolucao.md`) |
| Achado `block` de segurança (`secret`, `supply-chain`, `ci`) | `revisor-seguranca` no arquivo do achado; pedir revogação de segredo |
| Diff toca auth, sessão, permissão, pagamento (Pix, cartão), migração, multi-tenant, dados pessoais | `revisor-seguranca` + `revisor-codigo` |
| Diff com mais de ~400 linhas alteradas ou mais de ~20 arquivos | `revisor-codigo`; `executor-testes` se houver testes |
| `coverage-gap` em código de regra de negócio | `gerador-testes` (resultado = suspeita) |
| Mudança em tela/fluxo de usuário e o projeto tem Playwright | `testador-fluxos` |
| `ok`, diff pequeno, nada sensível | Só a CLI. Responder e parar. |

Os limites de linhas e arquivos são pontos de partida para conversar, não números medidos:
ajuste em `.safemerge/config.json` ou na skill `padroes-do-projeto` do seu projeto.

Arquivos sensíveis do projeto ficam listados na skill `regras-de-dominio`.
