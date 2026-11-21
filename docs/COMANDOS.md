# Comandos do safemerge

Referência de todos os comandos da CLI, dos scripts npm e da extensão do VS Code (versão 0.4.0).
Todos os comandos da CLI abaixo são conferidos de ponta a ponta por `npm run smoke` (47 verificações:
código de saída e trecho esperado da saída, nos repositórios de demonstração).

Somente leitura: nenhum comando altera branch, índice ou arquivos do seu repositório. As exceções são
explícitas: `install-hook` grava `.git/hooks/pre-push`, `--save` grava em `.safemerge/runs/` e o
"Aplicar na minha branch" da extensão grava um arquivo, só depois do seu clique e da confirmação.

## Instalação

```bash
npm install -g safemerge     # ou: npx safemerge
safemerge --version
```

Requisitos: Node 20+ e git 2.38+. Ferramentas externas são opcionais (gitleaks, semgrep, zizmor,
OSV-Scanner, TruffleHog, Docker, strace, Mergiraf): sem elas, o relatório marca "sem cobertura".

## Visão geral

| Comando | O que faz |
| --- | --- |
| `safemerge` | analisa a branch atual contra o destino (dev, develop, staging… senão main) |
| `safemerge` numa pasta com vários repositórios | analisa todos ao mesmo tempo (front e back) |
| `safemerge matrix` | todas as branches abertas × categoria, com a **ordem de merge** sugerida |
| `safemerge workspace [pasta]` | o mesmo que rodar na pasta raiz; `--all-branches` = todas as branches de cada repositório |
| `safemerge contracts [pasta]` | rotas de API que uma branch do back cria/remove e o front usa |
| `safemerge render --report r.json` | formata um relatório salvo, sem refazer a análise |
| `safemerge verify-text --report r.json texto.md` | confere ids, commits, PRs, `arquivo:linha` e números escritos por uma IA |
| `safemerge verify-resolution --target dev --file a.js=proposta.js` | testa uma proposta de resolução numa cópia temporária |
| `safemerge replay` | refaz merges antigos e mede conflitos (git × Mergiraf) |
| `safemerge install-hook` | instala o hook pre-push |
| `safemerge --version`, `safemerge help`, `safemerge <comando> --help` | versão e ajuda |

Códigos de saída: `0` ok · `1` o veredito atingiu `--fail-on` (padrão: `block`) · `2` erro de uso.

## `safemerge` (analyze)

```bash
safemerge                                   # branch atual
safemerge --head feature/outra              # outra branch, sem trocar de branch
safemerge --base main --target main         # destino escolhido
safemerge --test-cmd "npm test"             # testes no resultado do merge (conflito semântico)
safemerge --test-cmd auto                   # usa o comando de testes detectado no projeto
safemerge --body-file descricao.md          # confere a descrição do PR antes de abrir
safemerge --format markdown --out pr.md     # para colar no PR
safemerge --save                            # guarda tudo em .safemerge/runs/<data>/
safemerge --fail-on warn                    # CI: sai com 1 também nos avisos
```

| Opção | O que faz |
| --- | --- |
| `--head <branch>` | branch a analisar (padrão: a atual) |
| `--base <branch>` | destino que decide o veredito (padrão: detectado) |
| `--target <branch>` | compara só com estes destinos (repetível) |
| `--remote <nome>` | remoto (padrão: origin) |
| `--no-fetch` | não roda `git fetch` antes |
| `--no-overlap` | não procura outras branches/PRs nos mesmos arquivos |
| `--no-prs` | não usa o `gh` para associar branches a PRs |
| `--prs-file <json>` | PRs de um arquivo (formato do `gh pr list --json`) |
| `--body <texto>`, `--body-file <arquivo>` | descrição do PR (quando não há PR aberto ou sem `gh`) |
| `--test-cmd <cmd>` | testes no resultado do merge; `auto` = o comando detectado (`npm test`, `pytest`, `flutter test`, `go test ./...`…) |
| `--build-cmd <cmd>` | build antes dos testes |
| `--isolation auto\|docker\|none` | isolamento dos testes (Docker sem rede, se houver) |
| `--no-security` | pula segurança e deploy |
| `--format text\|markdown\|json\|html\|sarif\|github\|prompt` | formato da saída |
| `--out <arquivo>` | grava a saída num arquivo |
| `--sarif <arquivo>` | grava também SARIF 2.1.0 |
| `--save` | grava eventos e relatórios (txt, md, html, json, sarif, pedido para IA) em `.safemerge/runs/<id>/` |
| `--fail-on block\|warn\|never` | quando sair com código 1 |
| `--config <arquivo>` | configuração (padrão: `.safemerge/config.json`) |
| `--no-color` | sem cores |

O relatório traz o **plano para mergear**: o que fazer, em ordem, para a branch poder entrar (calculado
sem IA, cada passo com arquivo, linha, evidência e comando quando existem). Ele aparece no terminal, no
Markdown, no JSON (`plan`) e no pedido para IA (`--format prompt`).

## `safemerge matrix`

```bash
safemerge matrix                     # todas as branches abertas contra o destino
safemerge matrix --format markdown   # tabela + ordem de merge, para colar
safemerge matrix --jobs 8            # mais branches ao mesmo tempo
safemerge matrix --no-cache          # analisa tudo de novo
```

| Opção | O que faz |
| --- | --- |
| `--base <branch>` | destino (padrão: detectado) |
| `--limit <n>` | no máximo n branches (padrão 30) |
| `--test-cmd <cmd\|auto>` | testes em cada branch |
| `--no-security`, `--no-fetch` | como no analyze |
| `--jobs <n>` | branches analisadas ao mesmo tempo (padrão: até 4) |
| `--no-cache` | ignora o cache |
| `--format text\|markdown\|json`, `--out`, `--config` | saída e configuração |

**Ordem de merge:** stacks respeitadas (a base antes); entre as livres, primeiro quem já pode mergear,
depois quem pede atenção, por último quem precisa de trabalho; em cada par que conflita, diz quem
resolve (quem entra depois); em migrações com o mesmo número, diz quem renumera.

**Cache:** guarda o resultado de cada branch numa pasta temporária do sistema (nada é escrito no
repositório). Vale enquanto a branch, o destino, as outras branches da matriz, a configuração, o comando
de testes e a versão forem os mesmos. Medido no demo de 17 branches: 42,2 s um por vez, 13,6 s com 4 em
paralelo, 1,2 s repetindo sem mudanças.

## Vários repositórios (`workspace`)

```bash
cd meu-saas            # pasta com frontend/ e backend/ dentro (até 3 níveis)
safemerge              # analisa os dois ao mesmo tempo, um processo por repositório
safemerge --all-branches --test-cmd auto
safemerge workspace ../outra-pasta --format markdown
```

| Opção | O que faz |
| --- | --- |
| `--all-branches` | roda a matriz (todas as branches abertas) em cada repositório |
| `--jobs <n>` | repositórios ao mesmo tempo (padrão 4) |
| `--depth <n>` | níveis de pasta para procurar (padrão 3) |
| `--format text\|markdown\|json`, `--out`, `--fail-on` | saída |
| outras opções | vão para a análise de cada repositório (`--no-fetch`, `--base`, `--test-cmd auto`…) |

O veredito geral é o mais grave. O resultado inclui o **contrato de API** entre os repositórios.

## `safemerge contracts`

```bash
safemerge contracts               # branches atuais de cada repositório
safemerge contracts --all-branches
safemerge contracts --format json
```

Avisa quando a branch do back **remove** uma rota que o front ainda chama, e quando o front chama uma
rota que **só existe** na branch do back (o back precisa entrar antes). Heurística por texto: Express,
Fastify, Koa, Nest, FastAPI, Flask e Django no back; fetch, axios e clientes parecidos no front. Avisa,
nunca bloqueia.

## Relatório salvo, IA e hook

```bash
safemerge render --report .safemerge/runs/<id>/report.json --format html --out r.html
safemerge verify-text --report r.json resposta-da-ia.md
safemerge verify-resolution --target dev --file src/a.js=proposta.js --test-cmd "npm test"
safemerge replay --limit 200
safemerge install-hook             # --force para substituir um hook existente; --timeout <s>
```

`verify-resolution` diz `verified` (sem marcadores, sintaxe ok, build e testes passaram), `unverified`
(passou no que deu para checar, mas sem comando de testes), `failed` ou `incomplete`. Nunca aplica.

## Scripts npm (desenvolvimento)

| Script | O que faz |
| --- | --- |
| `npm run build` | compila para `dist/` |
| `npm run typecheck` | confere os tipos |
| `npm test` | testes unitários e de integração da CLI e da lógica da extensão |
| `npm run test:complex` | acertividade no cenário de 18 branches (gabarito em `test/complex/expected.json`): hoje 34/34 situações detectadas, veredito certo em 18/18, 0 alarmes falsos |
| `npm run smoke` | roda todos os comandos e opções da CLI compilada nos demos (47 verificações) |
| `npm run dev -- <opções>` | roda a CLI direto do TypeScript |
| `node scripts/screenshots.mjs` | refaz os prints do relatório e do terminal em `docs/imagens/` |
| `npm pack` | gera o pacote do npm (só `dist/`, `action.yml`, `LICENSE`, `README.md`) |

## Extensão do VS Code

Comandos (Ctrl+Shift+P → "safemerge"):

| Comando | O que faz |
| --- | --- |
| Analisar branch | analisa a branch atual (pergunta qual repositório se houver vários) |
| Analisar todos os repositórios da pasta | front e back ao mesmo tempo; tela Repositórios |
| Escolher repositório | troca o repositório analisado |
| Abrir relatório | painel com abas: Visão geral, Plano, Motivos, Conflitos, Branches, Semântico, Segurança, Testes, Cobertura |
| Ordem de merge de todas as branches | ordem sugerida (um bloco por repositório) e contrato de API entre eles |
| Resolver com Claude (ou a IA que você usa) | manda o pedido para a IA escolhida ou detectada |
| Escolher a IA do "Resolver com IA" | Claude Code, Copilot, Gemini, Codex, Continue, Cline… |
| Verificar uma proposta de resolução | testa um arquivo resolvido numa cópia temporária; "Aplicar" só se verificada |
| Ver os dois lados do conflito | comparação somente leitura destino ↔ sua branch |
| Copiar relatório (texto) · Copiar para o PR · Salvar relatório… | compartilhar |
| Instalar hook pre-push · Testar som | — |

Scripts da extensão (pasta `extension/`): `npm run build`, `npm run typecheck`,
`npm run test:integration` (abre um VS Code real e confere diagnóstico, CodeLens, hover, painel,
comparação e cópias), `npm run screenshots` (prints num VS Code real), `npm run package` (gera o `.vsix`).
