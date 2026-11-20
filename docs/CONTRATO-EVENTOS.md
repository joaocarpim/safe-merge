# Contrato de eventos (versão 1)

Fonte da verdade: `src/events.ts`. Com `--save`, a CLI grava `.safemerge/runs/<id>/events.ndjson`,
uma linha JSON por evento. A pasta `runs/` recebe um `.gitignore` com `*`, então o `git status` fica limpo.

Todo evento tem `v` (versão, hoje 1), `run` (id da execução, `AAAAMMDD-HHMMSS`), `t` (ISO 8601) e `type`.

| type | campos |
| --- | --- |
| `run.start` | `head`, `headSha`, `targets[]` |
| `phase.start` | `phase`: `branches` \| `merge` \| `overlap` \| `semantic` \| `security` |
| `phase.end` | `phase`, `status`: `ok` \| `warn` \| `block` \| `skipped` \| `error`, `ms`, `summary` |
| `merge.result` | `target`, `status`, `conflicts`, `behind` |
| `overlap.result` | `branch`, `wouldConflict`, `shared` |
| `semantic.result` | `target`, `status`: `passed` \| `failed` \| `flaky` \| `skipped` \| `error`, `cause?` |
| `security.result` | `check`: `secrets` \| `active-secrets` \| `lockfile` \| `cve` \| `workflows` \| `sast` \| `migrations` \| `env` \| `symbols` \| `domain` \| `untested`; `status`: `ran` \| `skipped` \| `missing-tool` \| `error`; `findings` |
| `run.end` | `level`: `ok` \| `warn` \| `block`, `reasons[]` |

Exemplo real (demo `examples/make-demo.sh`):

```
{"v":1,"run":"20261119-114018","t":"2026-11-19T14:40:18.416Z","type":"run.start","head":"feature/aprovacao-orcamento","headSha":"b4534d4","targets":["dev","main"]}
{"v":1,"run":"20261119-114018","t":"2026-11-19T14:40:18.456Z","type":"merge.result","target":"dev","status":"conflict","conflicts":1,"behind":8}
{"v":1,"run":"20261119-114018","t":"2026-11-19T14:40:18.552Z","type":"overlap.result","branch":"fix/desconto-itens","wouldConflict":true,"shared":1}
```

Regra para evoluir: campo novo pode ser acrescentado sem mudar a versão; mudar ou remover campo exige `v: 2`.
A fase de segurança (`phase: "security"` e `security.result`) entrou sem mudar a versão, porque só acrescenta.
O relatório final (`report.json`) é outra coisa: está no schema 2 (`findings[]` com id estável e `coverage[]`).
Com `--save`, a pasta da execução também recebe `report.sarif`.
