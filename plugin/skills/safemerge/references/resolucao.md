# Resolução assistida de conflito

A IA propõe; a CLI verifica; a pessoa decide. Nada é aplicado sem confirmação.

1. Para cada arquivo em `targets[0].conflicts` (destino principal), leia os três lados no JSON:
   `hunks[].ours` (sua branch), `hunks[].base` (como era antes) e `hunks[].theirs` (destino).
   Leia também o arquivo inteiro dos dois lados: `git show HEAD:<arquivo>` e `git show <destino>:<arquivo>`.
2. Entenda a intenção de cada lado (mensagens de commit: `git log merge-base..HEAD -- <arquivo>` e
   `git log merge-base..<destino> -- <arquivo>`). Uma boa resolução preserva as duas intenções.
3. Escreva o arquivo resolvido completo numa pasta temporária fora do repositório
   (ex.: `/tmp/proposta/<arquivo>`). Não escreva no repositório.
4. Verifique:
   ```
   npx safemerge verify-resolution --target <destino> \
     --file <arquivo>=/tmp/proposta/<arquivo> [--file ...] --test-cmd "<testes>"
   ```
   - `VERIFICADA`: sem marcadores, sintaxe ok, build e testes passaram no merge com a proposta.
   - `NÃO VERIFICADA`: sem comando de testes; diga isso, não chame de verificada.
   - `FALHOU` ou `INCOMPLETA`: corrija e verifique de novo (no máximo 3 tentativas; depois explique o impasse).
5. Mostre a proposta como diff e o resultado da verificação. Pergunte se deve aplicar.
6. Só com um "sim" explícito: faça o merge normal (`git merge <destino>`), escreva os arquivos
   propostos e deixe o commit para a pessoa revisar.

Se os dois lados mudaram a mesma regra de negócio de formas incompatíveis (ex.: um arredonda,
o outro não), não escolha: explique as duas opções e pergunte.

Lockfile em conflito: não proponha conteúdo. Oriente a regenerar (`npm install`) depois do merge.
