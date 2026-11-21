import type { AnalysisReport } from '../analyze.js';
import { findingWhere, kindLabel, semanticWhy, verdictTitle } from './common.js';

export interface PromptOptions {
  /** Caminho do report.json, para a IA conferir a própria resposta com verify-text. */
  reportPath?: string;
  /** Caminho do cli.js que gerou o relatório: para rodar o safemerge quando o comando não está instalado. */
  cliPath?: string;
}

/**
 * Pedido pronto para colar (ou enviar) a qualquer assistente de IA: o que o safemerge encontrou, com os
 * trechos dos dois lados, e as regras para a IA propor sem aplicar e verificar o que propuser.
 * Só formata o relatório: nenhum número é calculado aqui.
 */
export function renderPrompt(report: AnalysisReport, opts: PromptOptions = {}): string {
  const head = report.head.name ?? 'HEAD';
  const target = report.primary;
  const test = report.semantic[0]?.command ?? report.inputs?.testCommand ?? null;
  const out: string[] = [];
  const line = (s = '') => out.push(s);

  line(`Me ajude a resolver o que o safemerge encontrou antes de mergear \`${head}\` em \`${target}\`.`);
  line();
  line('Como rodar o safemerge: use o comando `safemerge` se ele existir no terminal.');
  if (opts.cliPath) line(`Se não existir (por exemplo, a CLI veio embutida numa extensão), troque \`safemerge\` por \`node "${opts.cliPath}"\` (precisa do Node 20 ou mais novo).`);
  else line('Se não existir, instale com `npm install -g github:joaocarpim/safe-merge` ou use `npx`.');
  line();
  line('Regras:');
  line('- Não aplique nenhuma mudança sem eu confirmar. Proponha, mostre o diff e espere.');
  line('- Comece pelo que bloqueia o merge; depois os avisos. Explique cada problema em uma frase.');
  line('- Para conflito: escreva o arquivo resolvido completo fora do repositório e verifique antes de me mostrar:');
  line(`  \`safemerge verify-resolution --target ${target} --file <caminho>=<arquivo-proposto>${test ? ` --test-cmd "${test}"` : ''}\``);
  line('  Só chame de "verificada" se o comando disser VERIFICADA.');
  line('- Preserve a intenção dos dois lados do conflito. Se forem incompatíveis (regra de negócio diferente), pergunte.');
  line('- Use só ids, commits, arquivos e números que estão abaixo. Não invente.');
  if (opts.reportPath) line(`- Antes de responder, confira o seu texto com: \`safemerge verify-text --report "${opts.reportPath}" resposta.md\``);
  line('- Conflito em lockfile: não edite; regenere depois do merge (ex.: npm install).');
  line();
  line(`## Veredito: ${verdictTitle(report.verdict.level)}`);
  line();
  for (const r of report.verdict.reasons) line(`- ${r.level === 'block' ? '[bloqueia]' : r.level === 'warn' ? '[aviso]' : '[info]'} ${r.text}`);
  line();

  for (const t of report.targets.filter((x) => x.conflicts.length > 0)) {
    line(`## Conflitos com \`${t.target}\``);
    for (const c of t.conflicts) {
      line();
      line(`### ${c.path} (${kindLabel(c.kind)})${c.hint === 'regenerate-lockfile' ? ' — lockfile: regenerar' : ''}`);
      if (c.lastTouchOnTarget) line(`Última mudança em ${t.target}: ${c.lastTouchOnTarget.author}, "${c.lastTouchOnTarget.subject}" (${c.lastTouchOnTarget.sha}).`);
      for (const h of c.hunks.slice(0, 5)) {
        line();
        line(`Sua branch${h.oursLine ? ` (linha ${h.oursLine})` : ''}:`);
        line('```');
        line(h.ours.join('\n'));
        if (h.oursTotal > h.ours.length) line("… (continua; leia o arquivo)");
        line('```');
        if (h.base.length) {
          line('Antes (ponto de partida):');
          line('```');
          line(h.base.join('\n'));
          line('```');
        }
        line(`${t.target}${h.theirsLine ? ` (linha ${h.theirsLine})` : ''}:`);
        line('```');
        line(h.theirs.join('\n'));
        if (h.theirsTotal > h.theirs.length) line("… (continua; leia o arquivo)");
        line('```');
      }
    }
    line();
  }

  for (const s of report.semantic.filter((x) => x.status === 'failed' || x.status === 'flaky')) {
    line('## Testes no resultado do merge');
    line();
    line(`\`${s.command}\`: ${s.status === 'flaky' ? 'instável (falhou e passou ao repetir)' : semanticWhy(s)}.`);
    line('```');
    line(s.outputTail.split('\n').slice(-25).join('\n'));
    line('```');
    line();
  }

  const findings = report.findings.filter((f) => f.level !== 'info');
  if (findings.length) {
    line('## Segurança e deploy');
    for (const f of findings) {
      line();
      line(`### [${f.id}] ${f.title}${findingWhere(f) ? ` — ${findingWhere(f)}` : ''} (${f.level === 'block' ? 'bloqueia' : 'aviso'})`);
      line(f.message);
      if (f.evidence) {
        line('```');
        line(f.evidence);
        line('```');
      }
    }
    line();
  }

  const others = report.overlaps.filter((o) => o.wouldConflict || o.sameFunctions?.length || o.relation === 'ours-contains-theirs');
  if (others.length) {
    line('## Outras branches e PRs');
    for (const o of others) {
      const what = o.wouldConflict ? `vai conflitar em ${o.conflictFiles.join(', ')}` : o.relation === 'ours-contains-theirs' ? 'esta branch está empilhada sobre ela' : `altera a mesma função: ${o.sameFunctions.map((x) => x.functions.join(', ')).join('; ')}`;
      line(`- ${o.pr ? `#${o.pr.number} ` : ''}${o.branch}: ${what}`);
    }
    line();
  }

  const plan = (report.plan ?? []).filter((p) => p.kind !== 'done');
  if (plan.length) {
    line('## Plano do safemerge (siga nesta ordem)');
    for (const p of plan) line(`${p.n}. ${p.title}${p.file ? ` (${p.file}${p.line ? `:${p.line}` : ''})` : ''}${p.command ? ` — \`${p.command}\`` : ''}`);
    line();
  }

  line('Responda com: (1) a lista do que bloqueia e do que é aviso, (2) a proposta para cada item, seguindo a ordem do plano, (3) o resultado do verify-resolution para cada conflito.');
  return `${out.join('\n')}\n`;
}
