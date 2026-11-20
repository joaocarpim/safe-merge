import { posix } from 'node:path';
import { compileRegexes } from '../config.js';
import { addedFiles, listTree } from '../diff.js';
import type { FindingDraft } from '../findings.js';
import { isAncestor, mergeBase } from '../git.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

export interface Migration {
  path: string;
  dir: string;
  name: string;
  /** Número/carimbo de ordem, como texto (pode ter 14 dígitos). */
  seq: string;
}

/** Reconhece `001_x.sql`, `20261120103000_x.ts`, `V12__x.sql` (Flyway) e pastas `20261120_x/migration.sql` (Prisma). */
export function parseMigration(path: string): Migration | null {
  const dir = posix.dirname(path);
  const name = posix.basename(path);
  let m = name.match(/^V?(\d+)[_.-]/);
  if (m) return { path, dir, name, seq: m[1]! };
  // Prisma: prisma/migrations/20261120_nome/migration.sql → a ordem está no nome da pasta
  const parent = posix.basename(dir);
  m = parent.match(/^(\d+)[_.-]/);
  if (m) return { path, dir: posix.dirname(dir), name: parent, seq: m[1]! };
  return null;
}

export function compareSeq(a: string, b: string): number {
  const x = a.replace(/^0+/, '') || '0';
  const y = b.replace(/^0+/, '') || '0';
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** Todas as migrações que existem no destino. */
function existingInTarget(ctx: CheckContext): Migration[] {
  const patterns = compileRegexes(ctx.cfg.migrations.paths);
  return listTree(ctx.cwd, ctx.target.ref)
    .filter((p) => patterns.some((re) => re.test(p)))
    .map(parseMigration)
    .filter((m): m is Migration => m !== null);
}

function migrationsAdded(ctx: CheckContext, from: string, to: string): Migration[] {
  const patterns = compileRegexes(ctx.cfg.migrations.paths);
  return addedFiles(ctx.cwd, from, to)
    .filter((p) => patterns.some((re) => re.test(p)))
    .map(parseMigration)
    .filter((m): m is Migration => m !== null);
}

/**
 * Migrações novas da branch contra as do destino e as de outras branches abertas:
 * mesmo número com nome diferente (as duas não convivem) e número anterior a uma que já entrou no destino.
 */
export const migrationsCheck: Check = {
  id: 'migrations',
  label: 'Migrações de banco conflitantes',
  run(ctx: CheckContext): CheckOutput {
    const ours = migrationsAdded(ctx, ctx.mergeBase, ctx.headRef);
    if (ours.length === 0) {
      return { coverage: { check: this.id, label: this.label, status: 'skipped', reason: 'nenhuma migração nova nesta branch' }, findings: [] };
    }
    const findings: FindingDraft[] = [];
    const branches = [ctx.target, ...ctx.others.filter((o) => o.name !== ctx.target.name)];
    for (const other of branches) {
      if (isAncestor(ctx.cwd, other.ref, ctx.headRef)) continue; // já está na sua branch
      const mb = mergeBase(ctx.cwd, ctx.headRef, other.ref);
      if (!mb) continue;
      const theirs = migrationsAdded(ctx, mb, other.ref);
      const isTarget = other.name === ctx.target.name;
      for (const m of ours) {
        const sameDir = theirs.filter((t) => t.dir === m.dir);
        const clash = sameDir.find((t) => compareSeq(t.seq, m.seq) === 0 && t.name !== m.name);
        if (clash) {
          findings.push({
            category: 'migration',
            rule: 'duplicate-number',
            title: 'Duas migrações com o mesmo número',
            message: `${m.name} (sua branch) e ${clash.name} (${other.name}) usam o número ${m.seq} em ${m.dir}. Depois do merge, uma das duas não roda ou roda na ordem errada: renumere a sua.`,
            severity: isTarget ? 'high' : 'medium',
            confidence: 'high',
            file: m.path,
            line: 1,
            evidence: `${m.path} × ${clash.path} em ${other.name}`,
            source: 'safemerge',
          });
          continue;
        }
        if (!isTarget) continue;
        // migração que já existia no destino antes da branch nascer, com número maior que a nova
        const existing = existingInTarget(ctx).filter((t) => t.dir === m.dir && compareSeq(t.seq, m.seq) > 0 && !ours.some((o) => o.path === t.path));
        const newestExisting = existing.sort((a, b) => compareSeq(b.seq, a.seq))[0];
        if (newestExisting && !sameDir.some((t) => compareSeq(t.seq, m.seq) > 0)) {
          findings.push({
            category: 'migration',
            rule: 'older-than-existing',
            title: 'Migração nova com número menor que uma já aplicada',
            message: `${m.name} tem número menor que ${newestExisting.name}, que já está em ${other.name}. Em produção, a ${newestExisting.name} provavelmente já rodou: ferramentas como Flyway recusam migração "do passado" e outras rodam fora de ordem. Gere de novo com um número atual.`,
            severity: 'medium',
            confidence: 'high',
            file: m.path,
            line: 1,
            evidence: `${m.seq} < ${newestExisting.seq} (${newestExisting.path} em ${other.name})`,
            source: 'safemerge',
          });
          continue;
        }
        const newer = sameDir.filter((t) => compareSeq(t.seq, m.seq) > 0).sort((a, b) => compareSeq(b.seq, a.seq))[0];
        if (newer) {
          findings.push({
            category: 'migration',
            rule: 'out-of-order',
            title: 'Migração fora de ordem',
            message: `${m.name} tem número menor que ${newer.name}, que já entrou em ${other.name}. Ferramentas que rodam só "as mais novas que a última aplicada" vão pular a sua: gere de novo com um número atual.`,
            severity: 'medium',
            confidence: 'high',
            file: m.path,
            line: 1,
            evidence: `${m.seq} < ${newer.seq} (${newer.path} em ${other.name})`,
            source: 'safemerge',
          });
        }
      }
    }
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason: `${ours.length} migração(ões) nova(s) comparada(s) com ${branches.length} branch(es)` }, findings };
  },
};
