import { compileRegexes } from '../config.js';
import { touchedFiles } from '../diff.js';
import type { FindingDraft } from '../findings.js';
import { git } from '../git.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

/**
 * Processo do PR: o que a descrição e os commits dizem (ou deixam de dizer) sobre o que a branch faz.
 * É o que um revisor cobra antes de aprovar: migração sem passo de deploy, commits de rascunho, PR
 * grande demais, seções obrigatórias do time faltando. Lê a descrição do PR (gh ou --body) e, sem ela,
 * as mensagens dos commits; o relatório diz qual das duas foi lida.
 */

export interface CommitInfo {
  sha: string;
  subject: string;
  body: string;
}

/** Commits da branch que o destino não tem (mais antigo primeiro). */
export function branchCommits(cwd: string, from: string, to: string): CommitInfo[] {
  const res = git(cwd, ['log', '--reverse', '--no-merges', '--format=%h%x1f%s%x1f%b%x1e', `${from}..${to}`]);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\x1e')
    .map((c) => c.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((c) => {
      const [sha = '', subject = '', body = ''] = c.split('\x1f');
      return { sha, subject: subject.trim(), body: body.trim() };
    });
}

const DEPLOY_WORDS = /migra|migrat|deploy|rollout|rollback|backfill|manage\.py\s+migrate|prisma\s+migrate|db:migrate|alembic|flyway|liquibase|passo a passo|ordem de deploy/i;
const DRAFT_COMMIT = /^(fixup!|squash!|amend!|wip\b|WIP\b|tmp\b|temp\b|\.+$|asdf|teste?\s*$)/i;

/** Mudanças em linhas (acrescentadas + removidas) da branch. */
function diffSize(cwd: string, from: string, to: string): { files: number; lines: number } {
  const res = git(cwd, ['diff', '--numstat', '--no-renames', from, to]);
  let files = 0;
  let lines = 0;
  for (const l of res.stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
    if (!m) continue;
    files++;
    lines += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
  }
  return { files, lines };
}

export const processCheck: Check = {
  id: 'process',
  label: 'Descrição do PR e commits (deploy, rascunho, tamanho, padrões do time)',
  run(ctx: CheckContext): CheckOutput {
    const p = ctx.cfg.process;
    const description = ctx.description?.trim() ?? null;
    const commits = branchCommits(ctx.cwd, ctx.mergeBase, ctx.headRef);
    const commitText = commits.map((c) => `${c.subject}\n${c.body}`).join('\n');
    const source = description ? (ctx.pr ? `descrição do PR #${ctx.pr.number}` : 'descrição passada em --body') : 'mensagens dos commits (sem descrição de PR)';
    const text = description ? `${description}\n${commitText}` : commitText;
    const findings: FindingDraft[] = [];
    const base = { category: 'process', source: 'safemerge' } as const;

    // 1. migração sem passo de deploy na descrição
    const migrationRes = compileRegexes(ctx.cfg.migrations.paths);
    const touched = touchedFiles(ctx.cwd, ctx.mergeBase, ctx.headRef);
    const migrations = touched.filter((f) => migrationRes.some((re) => re.test(f)));
    if (migrations.length > 0 && !DEPLOY_WORDS.test(text)) {
      findings.push({
        ...base,
        rule: 'deploy-undocumented',
        title: 'Migração sem passo de deploy descrito',
        message: `A branch traz ${migrations.length} migração(ões) e a ${source} não fala de migração, deploy ou rollback. Escreva no PR a ordem do deploy (rodar a migração antes/depois do código, backfill, como voltar).${description ? '' : ' Passe a descrição com --body (ou abra o PR) para conferir o texto real.'}`,
        severity: 'medium',
        confidence: description ? 'high' : 'medium',
        file: migrations[0]!,
        line: 1,
        evidence: `${migrations.length} migração(ões): ${migrations.slice(0, 3).join(', ')}${migrations.length > 3 ? '…' : ''}; nenhuma menção a migração/deploy em: ${source}`,
      });
    }

    // 2. commits de rascunho (fixup!, WIP…) que vão para o histórico do destino
    const drafts = commits.filter((c) => DRAFT_COMMIT.test(c.subject));
    if (drafts.length > 0) {
      findings.push({
        ...base,
        rule: 'draft-commits',
        title: `${drafts.length} commit(s) de rascunho na branch`,
        message: `Commits como "${drafts[0]!.subject}" vão para o histórico de ${ctx.target.name}. Faça squash (ou mergeie com "squash and merge").`,
        severity: 'low',
        confidence: 'high',
        file: null,
        line: null,
        evidence: drafts.slice(0, 3).map((c) => `${c.sha} ${c.subject}`).join('; '),
      });
    }

    // 3. PR grande demais para revisar bem
    const size = diffSize(ctx.cwd, ctx.mergeBase, ctx.headRef);
    if (size.files > p.maxFiles || size.lines > p.maxLines) {
      findings.push({
        ...base,
        rule: 'large-pr',
        title: 'PR grande para uma revisão só',
        message: `${size.files} arquivo(s) e ${size.lines} linha(s) alteradas (limite configurado: ${p.maxFiles} arquivos ou ${p.maxLines} linhas). Revisão de PR grande deixa passar mais coisa; considere dividir.`,
        severity: 'info',
        confidence: 'high',
        file: null,
        line: null,
        evidence: `${size.files} arquivos, ${size.lines} linhas (git diff --numstat)`,
      });
    }

    // 4. descrição: vazia ou sem as seções que o time exige
    if (description !== null) {
      if (description.length < p.minDescription) {
        findings.push({
          ...base,
          rule: 'empty-description',
          title: 'Descrição do PR vazia ou curta demais',
          message: `A descrição tem ${description.length} caractere(s). Diga o que muda, por que e como testar: é o que o revisor e quem fizer o deploy leem.`,
          severity: 'low',
          confidence: 'high',
          file: null,
          line: null,
          evidence: description ? `"${description.slice(0, 60)}"` : '(vazia)',
        });
      }
      const missing = p.requiredSections.filter((s) => !new RegExp(s, 'im').test(description));
      if (missing.length > 0) {
        findings.push({
          ...base,
          rule: 'missing-section',
          title: 'Descrição do PR sem seção obrigatória do time',
          message: `Faltam na descrição: ${missing.join(', ')} (process.requiredSections na configuração).`,
          severity: 'low',
          confidence: 'high',
          file: null,
          line: null,
          evidence: `seções ausentes: ${missing.join(', ')}`,
        });
      }
    }

    const reason = `${source}; ${commits.length} commit(s); ${size.files} arquivo(s), ${size.lines} linha(s)`;
    return { coverage: { check: this.id, label: this.label, status: 'ran', reason: description ? reason : `${reason}. Sem descrição: passe --body/--body-file ou abra o PR para conferir o texto` }, findings };
  },
};
