// Roda todos os test/*.test.ts. Existe porque no Windows o npm usa o cmd, que não expande `*`,
// e o Node 20 não expande glob no `--test`. Argumentos extras são repassados (ex.: um arquivo só).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const extra = process.argv.slice(2);
const files = extra.some((a) => a.endsWith('.ts'))
  ? []
  : ['test', 'extension/test'].filter((dir) => existsSync(dir)).flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.test.ts'))
        .sort()
        .map((f) => join(dir, f)),
    );

const res = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...extra, ...files], { stdio: 'inherit' });
process.exitCode = res.status ?? 1;
