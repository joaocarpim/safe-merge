# O que o safemerge analisa

Cada análise compara a **sua branch** com o **destino** (detectado: `dev`, `develop`, `staging`… senão
`main`) e com as **outras branches abertas**. Tudo roda em cópias temporárias: nada no seu repositório é
alterado.

O veredito tem três níveis:

| Veredito | Quando |
| --- | --- |
| **Não mergear** | conflito de texto com o destino, conflito semântico (testes quebram só no merge) ou achado bloqueante |
| **Mergear com atenção** | avisos: outro PR vai conflitar, branch atrasada, PR empilhado, mesma função alterada, teste instável, achado não bloqueante |
| **Pode mergear** | nenhum dos anteriores (observações informativas não mudam o veredito) |

Um achado só **bloqueia** com arquivo, linha e evidência, e com gravidade e confiança acima do limite
configurado (`security.blockSeverity` e `security.blockConfidence`; padrão: gravidade alta e confiança
média). Heurísticas por nome têm confiança baixa e por isso avisam, mas não bloqueiam.

Cada verificação aparece na **cobertura** com um de cinco estados: *rodou*, *parcial* (regras internas no
lugar da ferramenta especializada), *pulou* (com o motivo), *ferramenta ausente* ou *erro*. O relatório
nunca mostra "0 problemas" para algo que não foi verificado.

## 1. Merge

| O que | Como | Resultado |
| --- | --- | --- |
| Conflito de texto com o destino | `git merge-tree --write-tree` (merge de verdade, sem tocar no repositório) | bloqueia; mostra os blocos com sua branch, como era antes (zdiff3) e o destino, com linhas e quem mexeu por último |
| Conflito com outros destinos (`main`, `staging`…) | o mesmo, para cada branch principal | aviso |
| Apagado × alterado, criado nos dois lados, renomeado × apagado | tipo informado pelo git | bloqueia, com o tipo explicado |
| Conflito só em lockfile | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `go.sum`, `Cargo.lock`… | aviso: regenere depois do merge |
| Mesma função alterada pelos dois lados | diff por função (JS/TS, Python, Go, Ruby, PHP, Java, Kotlin, C#) nos arquivos que o git juntou sozinho | aviso (observação se os testes no merge passaram) |
| Destino renomeou um arquivo que você alterou | detecção de renomeação do git | observação: suas mudanças vão para o arquivo novo |
| Arquivos alterados dos dois lados e juntados sozinhos | diff dos dois lados contra o ponto de partida | observação: vale conferir |
| Branch atrasada | commits do destino que a branch não tem (limite `warnBehindCommits`, padrão 30) | aviso, com o comando de rebase |
| Branch sem nada a mergear | nenhum commit que o destino não tenha | observação |
| Branch local diferente da remota | commits locais não enviados no destino, ou sua branch atrás do remoto | aviso no rodapé |
| Conflito real × só de linha | [Mergiraf](https://mergiraf.org) (opcional) nos conflitos de conteúdo | observação; sem Mergiraf: ferramenta ausente |

## 2. Outras branches e PRs abertos

Para cada branch aberta (não mergeada, com commit nos últimos `overlap.maxAgeDays` dias, padrão 60), só as
que mexem nos mesmos arquivos são aprofundadas:

| O que | Resultado |
| --- | --- |
| Vai conflitar com a sua quando as duas forem mergeadas | aviso, com os arquivos, o número do PR e o autor (com `gh` logado) |
| Altera a mesma função que a sua, sem conflito de texto | aviso: quem mergear depois confere a lógica |
| Sua branch está empilhada sobre ela (PR empilhado) | **um** motivo só, com a base mais próxima e o tamanho da stack; aviso se a base é um PR aberto, informação se são só branches locais |
| Ela depende da sua | informação na lista |
| Ela renomeou um arquivo que você alterou | nota na lista |

Lockfiles em comum são ignorados (configurável em `overlap.ignorePaths`). Branches de preview, rascunho e
backup (`local/`, `preview`, `wip/`, `tmp/`, `backup/`, `archive/`, `old/`…) ficam fora do cruzamento
(`overlap.ignoreBranches`), a não ser que tenham PR aberto; a cobertura diz quantas foram ignoradas.

## 3. Testes no resultado do merge (conflito semântico)

Sem `--test-cmd`, o safemerge **não roda testes sozinho** (rodar testes executa código do repositório), mas
detecta o comando provável do projeto (`npm test`, `pnpm test`, `pytest`, `python manage.py test`,
`flutter test`, `go test ./...`, `cargo test`, Gradle, Maven, RSpec, PHPUnit) e o sugere na cobertura.

Com `--test-cmd` (ou `semantic.command`), o safemerge faz o merge numa cópia temporária e roda os testes
no resultado. Se falharem, roda também no destino e na sua branch para dizer a causa:

| Causa | Significado | Resultado |
| --- | --- | --- |
| conflito semântico | cada lado passa sozinho, a junção quebra | bloqueia |
| a sua branch já falha | o problema não é a junção | aviso |
| o destino já falha | não é culpa da sua branch | observação |
| instável | falhou e passou ao repetir (`semantic.retries`) | aviso, não acusado como conflito |

Também: `--build-cmd` roda o build antes e diz qual etapa quebrou. **Isolamento:** com Docker, os testes
rodam num container **sem rede** (`docker run --network none`); sem Docker, rodam na máquina com
**ambiente limpo** (só as variáveis de `isolation.envAllow`; tokens e chaves ficam de fora e o relatório diz
quantas). No Linux, com `strace`, registra rede, arquivos fora do projeto e programas que os testes
tocaram (observação, nunca bloqueio).

## 4. Segurança do que a branch introduz

| Verificação | Com a ferramenta | Sem ela |
| --- | --- | --- |
| Segredos em **todos os commits** da branch (mesmo apagados depois) | [gitleaks](https://github.com/gitleaks/gitleaks) com `--redact` | regras internas (GitHub, AWS, Stripe, Slack, Google, Mercado Pago, Asaas, npm, SendGrid, chave privada, segredo atribuído no código); cobertura parcial |
| Segredo **ativo** (confirmado com o provedor) | [TruffleHog](https://github.com/trufflesecurity/trufflehog) `--only-verified`; desligado por padrão porque contata o provedor | pulou |
| Dependência nova com script de instalação (vetor de worms como o Shai-Hulud) | interno (package-lock v2/v3) | — |
| Dependência de fora do registro permitido (git, tarball, outro host) | interno | — |
| Dependência sem `integrity` ou com hash fraco | interno | — |
| Vulnerabilidade (CVE) **nova** em dependência | [OSV-Scanner](https://google.github.io/osv-scanner/) no lockfile antes e depois (npm, yarn, pnpm, Python, Go, Rust, PHP, Ruby, Java…); só o que a branch trouxe | ferramenta ausente |
| Workflow de CI perigoso | [zizmor](https://github.com/zizmorcore/zizmor) | regras internas: `pull_request_target` com checkout do PR, texto do PR/issue dentro de `run:`, `permissions: write-all`; cobertura parcial |
| SAST só no código novo | [semgrep](https://semgrep.dev) com `--baseline-commit`; com merge limpo, escaneia o **resultado do merge** contra o destino | ferramenta ausente |

Os segredos nunca aparecem no relatório: só o começo e o tamanho.

## 5. Deploy e regras de domínio (SaaS no Brasil)

| Verificação | Resultado |
| --- | --- |
| Duas migrações com o mesmo número (destino ou outra branch aberta) | bloqueia (destino) ou aviso (outra branch) |
| Migração fora de ordem ou com número menor que uma já existente no destino | aviso (o Flyway recusa por padrão; outras ferramentas rodam fora de ordem) |
| Variável de ambiente nova sem documentação no `.env.example` | aviso (com documentação: lembrete de deploy) |
| Função/constante que o destino removeu ou renomeou e a branch ainda usa | bloqueia quando a linha importa do arquivo de onde o nome saiu; senão aviso |
| Dado pessoal em log (CPF, CNPJ, e-mail, telefone, senha, cartão…) — LGPD | aviso |
| Rota nova sem autenticação (Express/Fastify, FastAPI/Flask, Next.js) | aviso; rotas públicas em `domain.publicRoutes` |
| Consulta sem filtro de tenant (Prisma, SQL, ORM) nos modelos de `domain.tenantModels` | aviso |
| Código alterado sem teste com o nome dele | observação: os testes no merge provavelmente não cobrem essas linhas |

Formatos de migração reconhecidos: `001_x.sql`, `20261120103000_x.ts`, `V12__x.sql` (Flyway) e pastas do
Prisma (`prisma/migrations/20261120_x/migration.sql`). Pastas em `migrations.paths`.

## 6. Revisão do código novo (higiene e riscos de produção)

Só nas linhas que a branch acrescenta, com a linha como evidência:

| Verificação | Resultado |
| --- | --- |
| Marcador de conflito commitado (`<<<<<<<`, `>>>>>>>`) | bloqueia |
| SQL montado com concatenação/interpolação (inclusive `$queryRawUnsafe` com `+`) | bloqueia |
| Arquivo que não deveria entrar: `.env`, chave/certificado, chave SSH, credencial de nuvem, `.npmrc` | bloqueia |
| TLS/CSRF/permissão desligados, comparação de segredo com `==` | aviso |
| `console.log`/`debugger`/`print` esquecidos, URL local/IP fixo, `any`/`@ts-ignore` | aviso |
| `.only`/`.skip` em teste | aviso |
| Consulta ao banco dentro de laço (N+1), chamada HTTP sem timeout, exceção engolida | observação (heurística de texto: erra; catch com comentário e `fetch` dentro de string/JS injetado não contam) |
| Contador/versão sem lock, idempotência sem reservar a chave antes da chamada externa | aviso |
| Transação com lock segurando I/O, lista de entrada sem limite, SQL destrutivo no código | aviso |
| Migração destrutiva (DROP/TRUNCATE) ou sem volta | aviso |
| Reformatação em massa misturada com a mudança | aviso |
| TODO/FIXME novo | observação |

## 6b. Processo do PR (descrição e commits)

Lê a descrição do PR (pelo `gh`, ou `--body`/`--body-file` quando ainda não há PR) e as mensagens dos
commits. A cobertura diz qual dos dois foi lido.

| Verificação | Resultado |
| --- | --- |
| Migração na branch e nenhuma menção a migração/deploy/rollback na descrição | aviso (confiança alta com descrição; média lendo só os commits) |
| Commits de rascunho (`fixup!`, `squash!`, `WIP`…) | aviso: faça squash |
| Descrição vazia ou curta (`process.minDescription`) | aviso |
| Seção obrigatória do time faltando (`process.requiredSections`, ex.: `^#+\s*como testar`) | aviso |
| PR grande (`process.maxFiles`/`process.maxLines`, padrão 40 arquivos ou 1000 linhas) | observação |

## Nível dos achados

Bloqueia só o que tem arquivo, linha, evidência e gravidade/confiança acima de `security.blockSeverity`/
`blockConfidence`. Heurística de **baixa confiança** (por nome ou texto) vira **observação** e não muda o
veredito, a não ser que a gravidade seja alta: "mergear com atenção" fica para o que vale a pena ler.

## 6c. Vários repositórios de uma vez (front e back)

Rodando `safemerge` numa pasta que não é repositório mas tem repositórios dentro (até 3 níveis), ele acha
todos e analisa ao mesmo tempo, um processo por repositório (`--jobs`, padrão 4), e junta o resultado. O
veredito geral é o mais grave. `--all-branches` roda a matriz (todas as branches abertas) em cada um;
`--test-cmd auto` usa o comando de testes detectado em cada repositório. Também como `safemerge workspace`.
Não cruza um repositório com o outro (contrato de API entre front e back não é verificado).

## 6d. Plano para mergear e ordem de merge

**Plano por branch** (no relatório, em `plan`, e no Markdown): o que fazer, em ordem, para a branch poder
entrar. Sai só do relatório, sem IA: cada passo vem de um conflito, teste ou achado, com arquivo, linha,
evidência e comando quando existem. Ordem fixa: o que precisa entrar antes (stack), atualizar a branch,
conflitos (lockfile: regenerar), testes, bloqueios, avisos, combinar com quem mexe nos mesmos arquivos,
sugestões e analisar de novo. Observações não viram passo.

**Ordem de merge** (no `safemerge matrix`): todas as branches abertas em sequência. Stacks respeitadas (a
base antes); entre as livres, primeiro quem já pode mergear, depois quem pede atenção, por último quem
precisa de trabalho. Em cada par que conflita, diz quem resolve o conflito (quem entra depois).
Sem estimativa de tempo nem nota de prioridade.

## 7. IA com verificação (plugin do Claude Code)

| Comando | O que garante |
| --- | --- |
| `safemerge verify-text --report r.json texto.md` | todo id de achado, commit, PR, `arquivo:linha` e contagem citados pela IA existem no relatório; avisa se o relatório ficou velho |
| `safemerge verify-resolution --target dev --file a.js=proposta.js --test-cmd "..."` | a proposta de resolução cobre todos os arquivos em conflito, não mexe em outros, não deixou marcadores, tem sintaxe válida (JSON, JS) e passa no build e nos testes, numa cópia temporária; nunca aplica |

## 8. Visão do time

| Comando | O que mostra |
| --- | --- |
| `safemerge matrix` | todas as branches abertas × categoria (conflito, outros PRs, testes, segredos, dependências, CI, SAST, migrações, variáveis, tenant, autenticação, LGPD) |
| `safemerge replay` | os merges antigos do repositório refeitos: quantos conflitos o git deu e, com Mergiraf, quantos ele resolveria igual ao que o dev commitou |

## Onde aparece

Terminal (texto), Markdown (PR, chat), HTML (página autônoma), JSON (schema 2), SARIF 2.1.0 (GitHub Code
Scanning e editores que leem SARIF), anotações do GitHub Actions (marcas na linha do diff do PR), pedido
pronto para assistente de IA (`--format prompt`), hook pre-push e GitHub Action. O conteúdo é o mesmo; só
muda a forma.

## Medido

No cenário de produção complexo (`examples/make-demo-complex.sh`: ~150 módulos, 160 commits na `dev`,
18 branches abertas com situações plantadas), sem nenhuma ferramenta externa instalada, no Windows:

- situações plantadas detectadas: **34 de 34**; veredito certo: **18 de 18** branches; alarmes falsos: **0**;
- tempo por branch: mediana **2,2 s** (inclui rodar a suíte de testes no merge).

Esse cenário foi escrito junto com a ferramenta; o número que importa é o do seu repositório. Reproduza com
`npm run test:complex`.

## Limites conhecidos

- Heurísticas por nome (mesma função, função removida, domínio, código sem teste) podem errar; por isso
  não bloqueiam sozinhas, exceto função removida quando a linha importa do arquivo de onde o nome saiu.
- As integrações com gitleaks, zizmor, semgrep, OSV-Scanner, TruffleHog, Docker, strace e Mergiraf foram
  testadas com as saídas no formato real de cada uma, não com as ferramentas instaladas.
- `strace` só no Linux. Testes no Docker usam a imagem `isolation.image` (padrão `node:20-bookworm-slim`).
- Não revisa lógica nem arquitetura (máquina de estados, idempotência do domínio, desenho do módulo): isso é
  do revisor humano ou de uma revisão por IA. O processo do PR confere só o que dá para conferir no texto.
- Sem descrição de PR (sem `gh` logado, sem PR aberto e sem `--body`), a checagem de processo lê só as
  mensagens dos commits.
