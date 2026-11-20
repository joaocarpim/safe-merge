import type { AnalysisReport } from '../analyze.js';
import type { Finding } from '../findings.js';
import {
  ageLabel,
  confidenceLabel,
  conflictNotes,
  coverageLabel,
  findingWhere,
  headLabel,
  isolationLabel,
  kindLabel,
  overlapName,
  overlapWho,
  plural,
  renameNote,
  sameFunctionNote,
  seconds,
  semanticWhy,
  severityLabel,
} from './common.js';

/** Todo texto vindo do repositório (branches, commits, autores, código) passa por aqui. */
export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/*
 * Estética de ferramenta de desenvolvimento: neutros quentes, linhas finas, uma família sans + mono,
 * cor só para status. Estrutura de transcrição: cada etapa é uma linha "⏺ título  resumo" e o detalhe
 * fica embaixo, ligado por uma linha fina. Sem gradiente, sem cartão colorido, sem script, sem rede.
 * Tema: segue o sistema; data-theme="dark|light" força; no VS Code, body.vscode-dark/vscode-light.
 */
const DARK = `--bg:#151514;--panel:#1c1c1a;--ink:#e8e6e1;--ink2:#bdbab2;--muted:#8a877f;--line:#2e2d2a;--line2:#3d3c37;
--ok:#5fb98a;--warn:#d9a648;--bad:#e5675c;--info:#8aa4d6;--code:#191918;color-scheme:dark`;
const CSS = `
:root{--bg:#faf9f6;--panel:#ffffff;--ink:#1d1c1a;--ink2:#46443f;--muted:#7b7870;--line:#e6e4de;--line2:#d6d3cb;
--ok:#2f8a5b;--warn:#a86b00;--bad:#c2412f;--info:#3e5f9e;--code:#f6f5f1;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark],body.vscode-dark,body.vscode-high-contrast{${DARK}}
body.vscode-light{--bg:#faf9f6;--panel:#ffffff;--ink:#1d1c1a;--ink2:#46443f;--muted:#7b7870;--line:#e6e4de;--line2:#d6d3cb;--code:#f6f5f1;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13.5px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:980px;margin:0 auto;padding:28px 24px 48px}
code,pre,.mono,.path,.tag{font-family:var(--mono);font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}
.top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;color:var(--muted);font:12px/1.4 var(--mono)}
.top b{color:var(--ink2);font-weight:600}
.verdict{display:flex;align-items:center;gap:12px;margin:20px 0 10px}
.verdict .dot{width:10px;height:10px;border-radius:50%;flex:none}
.verdict .dot.ok{background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 18%,transparent)}
.verdict .dot.warn{background:var(--warn);box-shadow:0 0 0 4px color-mix(in srgb,var(--warn) 18%,transparent)}
.verdict .dot.block{background:var(--bad);box-shadow:0 0 0 4px color-mix(in srgb,var(--bad) 18%,transparent)}
.verdict h1{margin:0;font:600 22px/1.2 var(--sans);letter-spacing:-.01em}
.ok{color:var(--ok)}.warn{color:var(--warn)}.block{color:var(--bad)}.info{color:var(--info)}.none{color:var(--muted)}
.why{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.why li{display:grid;grid-template-columns:18px 1fr;gap:4px;color:var(--ink2)}
.why li.info{color:var(--muted)}
.g{font:12px/1.6 var(--mono)}
.stats{display:flex;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;background:var(--panel);margin:18px 0 6px;overflow:hidden}
.stat{flex:1 1 130px;padding:9px 14px;border-right:1px solid var(--line);min-width:0}
.stat:last-child{border-right:0}
.stat .k{display:block;font:11px/1.3 var(--sans);color:var(--muted)}
.stat .v{display:block;font:600 15px/1.5 var(--mono);color:var(--ink);font-variant-numeric:tabular-nums}
.stat .v.ok{color:var(--ok)}.stat .v.warn{color:var(--warn)}.stat .v.block{color:var(--bad)}.stat .v.none{color:var(--muted)}
.step{margin-top:24px}
.step > .h{display:flex;align-items:baseline;gap:10px}
.step > .h .m{font:11px/1 var(--mono);width:14px;flex:none}
.step > .h .t{font-weight:600;color:var(--ink)}
.step > .h .s{color:var(--muted);font-size:12.5px;margin-left:auto;text-align:right}
.body{margin:8px 0 0 6px;padding-left:18px;border-left:1px solid var(--line);display:grid;gap:10px}
.row{display:grid;grid-template-columns:18px 1fr;gap:4px;align-items:start}
.row .main{min-width:0}
.row .main b{font-weight:600}
.sub{color:var(--muted);font-size:12.5px}
.tag{display:inline-block;font-size:11px;line-height:1.5;color:var(--muted);border:1px solid var(--line2);border-radius:4px;padding:0 5px;margin-left:6px;vertical-align:1px;white-space:nowrap}
.tag.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,var(--line2))}
.tag.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,var(--line2))}
.tag.block{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,var(--line2))}
.tag.info{color:var(--info);border-color:color-mix(in srgb,var(--info) 45%,var(--line2))}
.path{font-size:12.5px;color:var(--ink);word-break:break-all}
.item{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px 14px;min-width:0}
.head{display:flex;gap:2px 0;align-items:baseline;flex-wrap:wrap}
.head b{font-weight:600;margin-right:2px}
.meta{margin-top:5px;color:var(--muted);font-size:12px;display:flex;gap:4px 12px;flex-wrap:wrap}
.meta .mono{color:var(--ink2)}
.item p{margin:8px 0 0;color:var(--ink2)}
.finding{display:grid;grid-template-columns:3px 1fr;gap:12px}
.sev{border-radius:2px;background:var(--line2)}
.sev.block{background:var(--bad)}.sev.warn{background:var(--warn)}.sev.info{background:var(--info)}
.diff{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:10px}
.side{background:var(--code);min-width:0}
.side .l{display:flex;justify-content:space-between;font:500 10.5px/1 var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:9px 10px 6px}
.side .l b{font-weight:600}.side.ours .l b{color:var(--info)}.side.theirs .l b{color:var(--warn)}
pre{margin:0;padding:2px 10px 10px;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;color:var(--ink)}
.more{font:11px/1 var(--mono);color:var(--muted);padding:0 10px 9px}
.ev{margin-top:10px;background:var(--code);border:1px solid var(--line);border-radius:6px}
.ev pre{padding:8px 10px}
.tail{max-height:240px;overflow:auto}
.cov{border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden}
.cov .c{display:grid;grid-template-columns:18px minmax(170px,250px) 1fr;gap:10px;padding:7px 12px;border-top:1px solid var(--line);align-items:baseline}
.cov .c:first-child{border-top:0}
.cov .c .n{color:var(--ink)}
.cov .c .r{color:var(--muted);font-size:12px;min-width:0;word-break:break-word}
.ran .g{color:var(--ok)}.partial .g{color:var(--info)}.skipped .g{color:var(--muted)}.missing-tool .g,.error .g{color:var(--warn)}
footer{margin-top:34px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font:11.5px/1.6 var(--mono)}
footer p{margin:2px 0}
@media (max-width:640px){.cov .c{grid-template-columns:18px 1fr}.cov .c .r{grid-column:2}.step > .h .s{display:none}}
`;

type Tone = 'ok' | 'warn' | 'block' | 'info' | 'none';
const GLYPH: Record<string, string> = { block: '✗', warn: '!', info: '·', ok: '✓', none: '–' };
const COV_GLYPH: Record<string, string> = { ran: '✓', partial: '◐', skipped: '–', 'missing-tool': '!', error: '!' };
const CATEGORY: Record<string, string> = {
  secret: 'segredo',
  'supply-chain': 'dependência',
  ci: 'ci',
  sast: 'sast',
  migration: 'migração',
  env: 'variável',
  semantic: 'semântico',
  'coverage-gap': 'sem teste',
  runtime: 'execução',
  tenant: 'tenant',
  auth: 'autenticação',
  lgpd: 'lgpd',
};
const TITLE = { ok: 'Pode mergear', warn: 'Mergear com atenção', block: 'Não mergear' } as const;

function tag(level: Tone, text: string): string {
  return `<span class="tag ${level}">${esc(text)}</span>`;
}

function step(mark: Tone, title: string, summary: string, body: string): string {
  return `<section class="step"><div class="h"><span class="m ${mark}">⏺</span><span class="t">${esc(title)}</span><span class="s">${esc(summary)}</span></div><div class="body">${body}</div></section>`;
}

function codeLines(list: string[], total: number): string {
  const more = total > list.length ? `<div class="more">+${total - list.length} linha(s)</div>` : '';
  return `<pre>${list.length ? esc(list.join('\n')) : '<span class="sub">(não existia)</span>'}</pre>${more}`;
}

function findingItem(f: Finding): string {
  const where = findingWhere(f);
  const lvl: Tone = f.level === 'info' ? 'info' : f.level;
  const tagText = f.level === 'block' ? 'bloqueia' : f.level === 'warn' ? 'aviso' : 'observação';
  return (
    `<div class="item finding" id="${esc(f.id)}"><span class="sev ${lvl}"></span><div>` +
    `<div class="head"><b>${esc(f.title)}</b>${tag(lvl, tagText)}${tag('none', CATEGORY[f.category] ?? f.category)}</div>` +
    `<div class="meta"><span class="mono">${esc(f.id)}</span>${where ? `<span class="mono">${esc(where)}</span>` : ''}<span>gravidade ${esc(severityLabel(f.severity))}</span><span>confiança ${esc(confidenceLabel(f.confidence))}</span><span>${esc(f.source)}</span></div>` +
    `<p>${esc(f.message)}</p>${f.evidence ? `<div class="ev"><pre>${esc(f.evidence)}</pre></div>` : ''}</div></div>`
  );
}

/** Página única e autônoma (sem rede, sem script). */
export function renderHtml(report: AnalysisReport): string {
  const v = report.verdict;
  const s = report.summary;
  const out: string[] = [];
  const add = (x: string) => out.push(x);

  // cabeçalho e veredito
  add(`<div class="top"><b>safemerge</b><span>${esc(headLabel(report))} → ${esc(report.primary)}</span><span>·</span><span>${esc(report.repo)}</span><span>·</span><span>${esc(seconds(report.durationMs))}</span><span>·</span><span>somente leitura</span></div>`);
  add(`<div class="verdict" title="${v.level === 'block' ? 'NÃO MERGEAR' : v.level === 'warn' ? 'MERGEAR COM ATENÇÃO' : 'PODE MERGEAR'}"><span class="dot ${v.level}"></span><h1 class="${v.level}">${esc(TITLE[v.level])}</h1></div>`);
  add(
    `<ul class="why">${
      v.reasons.length
        ? v.reasons.map((r) => `<li class="${r.level}"><span class="g ${r.level}">${GLYPH[r.level]}</span><span>${esc(r.text)}</span></li>`).join('')
        : '<li class="info"><span class="g ok">✓</span><span>sem conflitos e sem avisos</span></li>'
    }</ul>`,
  );

  // linha de status
  if (s) {
    const tests: [Tone, string] =
      s.tests === 'passed' ? ['ok', '✓ passaram'] : s.tests === 'failed' ? ['block', '✗ falharam'] : s.tests === 'flaky' ? ['warn', '~ instáveis'] : s.tests === 'error' ? ['warn', '! erro'] : ['none', s.tests === 'skipped' ? '– pulados' : '– sem comando'];
    const gap = s.coverage.missing + s.coverage.error;
    const stats: Array<[string, Tone, string]> = [
      ['conflitos', s.conflictFiles ? 'block' : 'ok', String(s.conflictFiles)],
      ['outros PRs', s.otherBranchConflicts ? 'warn' : 'ok', String(s.otherBranchConflicts)],
      ['testes no merge', tests[0], tests[1]],
      ['bloqueios', s.reasons.block ? 'block' : 'ok', String(s.reasons.block)],
      ['avisos', s.reasons.warn ? 'warn' : 'ok', String(s.reasons.warn)],
      ['cobertura', gap || s.coverage.partial ? 'warn' : 'ok', `${s.coverage.ran + s.coverage.partial}/${s.coverage.total}`],
    ];
    add(`<div class="stats">${stats.map(([k, t, val]) => `<div class="stat"><span class="k">${esc(k)}</span><span class="v ${t}">${esc(val)}</span></div>`).join('')}</div>`);
  }

  // merge simulado
  {
    const rows: string[] = [];
    let mark: Tone = 'ok';
    for (const t of report.targets) {
      const primary = t.target === report.primary;
      const onlyLocks = t.conflicts.length > 0 && t.conflicts.every((c) => c.hint === 'regenerate-lockfile');
      const lvl: Tone = t.status === 'clean' ? 'ok' : t.status === 'conflict' ? (primary && !onlyLocks ? 'block' : 'warn') : 'warn';
      if (lvl === 'block' || (lvl === 'warn' && mark === 'ok')) mark = lvl;
      const res = t.status === 'clean' ? 'limpo' : t.status === 'conflict' ? plural(t.conflicts.length, 'arquivo em conflito', 'arquivos em conflito') : `não simulado: ${t.error ?? ''}`;
      const extra = [`${plural(t.behind, 'commit', 'commits')} atrás`, `${plural(t.ahead, 'commit', 'commits')} à frente`];
      if (t.autoMerged.length && primary) extra.push(`juntado sozinho: ${t.autoMerged.slice(0, 3).join(', ')}`);
      for (const r of t.renamedOnTarget ?? []) extra.push(`${t.target} renomeou ${r.from} → ${r.to}`);
      const same = primary ? sameFunctionNote(t.sameFunction) : '';
      rows.push(
        `<div class="row"><span class="g ${lvl}">${GLYPH[lvl]}</span><div class="main"><span class="path">${esc(t.target)}</span>${primary ? tag('info', 'destino') : ''} <span class="${lvl}">${esc(res)}</span><div class="sub">${esc(extra.join(' · '))}</div>${same ? `<div class="sub warn">${esc(same)}</div>` : ''}</div></div>`,
      );
    }
    add(step(mark, 'Merge simulado', `${report.targets.length} destino(s)`, rows.join('')));
  }

  // conflitos
  for (const t of report.targets.filter((x) => x.conflicts.length > 0)) {
    const items = t.conflicts.map((f) => {
      const notes = conflictNotes(f);
      const parts = [`<div class="head"><span class="path">${esc(f.path)}</span>${tag('none', kindLabel(f.kind))}${notes.map((n) => tag(/conflito real/.test(n) ? 'block' : 'info', n)).join('')}</div>`];
      for (const h of f.hunks.slice(0, 3)) {
        const at = (l: number | null) => (l ? `linha ${l}` : '');
        parts.push('<div class="diff">');
        parts.push(`<div class="side ours"><div class="l"><b>sua branch</b><span>${at(h.oursLine)}</span></div>${codeLines(h.ours, h.oursTotal)}</div>`);
        if (h.base.length || h.baseTotal) parts.push(`<div class="side base"><div class="l"><b>antes</b><span>ponto de partida</span></div>${codeLines(h.base, h.baseTotal)}</div>`);
        parts.push(`<div class="side theirs"><div class="l"><b>${esc(t.target)}</b><span>${at(h.theirsLine)}</span></div>${codeLines(h.theirs, h.theirsTotal)}</div>`);
        parts.push('</div>');
      }
      if (f.hunks.length > 3) parts.push(`<div class="sub" style="margin-top:6px">+${f.hunks.length - 3} bloco(s) neste arquivo</div>`);
      if (f.lastTouchOnTarget) {
        const l = f.lastTouchOnTarget;
        parts.push(`<div class="meta"><span>última mudança em ${esc(t.target)}</span><span class="mono">${esc(l.sha)}</span><span>${esc(l.author)}</span><span>${esc(l.date)}</span><span>${esc(l.subject)}</span></div>`);
      }
      return `<div class="item">${parts.join('')}</div>`;
    });
    add(step(t.target === report.primary && !t.conflicts.every((c) => c.hint) ? 'block' : 'warn', `Conflitos com ${t.target}`, plural(t.conflicts.length, 'arquivo', 'arquivos'), items.join('')));
  }

  // outras branches
  if (report.overlaps.length > 0) {
    let mark: Tone = 'ok';
    const rows = report.overlaps.map((o) => {
      const files = (o.wouldConflict ? o.conflictFiles : o.sharedFiles).slice(0, 4).map((f) => `<span class="path">${esc(f)}</span>`).join(', ');
      const same = (o.sameFunctions?.length ?? 0) > 0;
      const [lvl, text]: [Tone, string] = o.wouldConflict
        ? ['block', 'vai conflitar']
        : o.relation === 'ours-contains-theirs'
          ? ['warn', 'empilhada: entra antes']
          : o.relation === 'theirs-contains-ours'
            ? ['warn', 'depende desta']
            : same
              ? ['warn', 'mesma função']
              : ['ok', 'junta sem conflito'];
      if (lvl !== 'ok') mark = 'warn';
      const notes = [renameNote(o), sameFunctionNote(o.sameFunctions)].filter(Boolean).join(' · ');
      return `<div class="row"><span class="g ${lvl}">${GLYPH[lvl]}</span><div class="main"><b>${esc(overlapName(o))}</b><span class="sub">${esc(overlapWho(o))} · ${esc(ageLabel(o.ageDays))}</span>${tag(lvl, text)}<div class="sub">${files}</div>${notes ? `<div class="sub ${same ? 'warn' : ''}">${esc(notes)}</div>` : ''}</div></div>`;
    });
    add(step(mark, 'Outras branches e PRs', plural(report.overlaps.length, 'branch nos mesmos arquivos', 'branches nos mesmos arquivos'), rows.join('')));
  }

  // testes
  for (const t of report.semantic) {
    const lvl: Tone = t.status === 'passed' ? 'ok' : t.status === 'failed' ? (t.cause === 'semantic-conflict' ? 'block' : 'warn') : t.status === 'skipped' ? 'none' : 'warn';
    const title =
      t.status === 'passed' ? `passaram no merge com ${t.target}` :
      t.status === 'skipped' ? `pulados: ${t.reason ?? ''}` :
      t.status === 'error' ? `não rodaram: ${t.reason ?? ''}` :
      t.status === 'flaky' ? `instáveis: falharam e passaram ao repetir (${t.attempts} tentativas); não acusado como conflito` :
      semanticWhy(t);
    const cmd = t.buildCommand ? `${t.buildCommand} && ${t.command ?? ''}` : (t.command ?? '');
    const body = [
      `<div class="row"><span class="g ${lvl}">${GLYPH[lvl]}</span><div class="main"><span class="${lvl === 'none' ? '' : lvl}">${esc(title)}</span>` +
        `<div class="sub"><span class="mono">${esc(cmd)}</span>${t.durationMs ? ` · ${esc(seconds(t.durationMs))}` : ''}${t.isolation ? ` · ${esc(isolationLabel(t))}` : ''}</div></div></div>`,
    ];
    if (t.outputTail && t.status !== 'passed' && t.status !== 'skipped') body.push(`<div class="ev tail"><pre>${esc(t.outputTail)}</pre></div>`);
    const label = { passed: 'passaram', failed: 'falharam', flaky: 'instáveis', skipped: 'pulados', error: 'erro' }[t.status];
    add(step(lvl, 'Testes no resultado do merge', label, body.join('')));
  }

  // achados
  if (report.findings.length > 0) {
    const b = report.findings.filter((f) => f.level === 'block').length;
    const w = report.findings.filter((f) => f.level === 'warn').length;
    const i = report.findings.length - b - w;
    const summary = [b ? `${b} bloqueia` : '', w ? `${w} ${w === 1 ? 'aviso' : 'avisos'}` : '', i ? `${i} ${i === 1 ? 'observação' : 'observações'}` : ''].filter(Boolean).join(' · ');
    add(step(b ? 'block' : w ? 'warn' : 'info', 'Segurança e deploy', summary, report.findings.map(findingItem).join('')));
  }

  // cobertura
  if (report.coverage.length > 0) {
    const ran = report.coverage.filter((c) => c.status === 'ran' || c.status === 'partial').length;
    const rows = report.coverage
      .map((c) => {
        const n = c.status === 'ran' || c.status === 'partial' ? ` · ${plural(c.findings, 'problema', 'problemas')}` : '';
        return `<div class="c ${c.status}"><span class="g">${COV_GLYPH[c.status] ?? '?'}</span><span class="n">${esc(c.label)}</span><span class="r">${esc(coverageLabel(c.status))}${esc(n)}${c.reason ? ` · ${esc(c.reason)}` : ''}</span></div>`;
      })
      .join('');
    const gap = report.coverage.filter((c) => c.status === 'missing-tool' || c.status === 'error').length;
    add(step(gap ? 'warn' : 'ok', 'Cobertura', `${ran}/${report.coverage.length} verificações rodaram${gap ? ` · ${gap} sem cobertura` : ''}`, `<div class="cov">${rows}</div>`));
  }

  add(`<footer>${report.warnings.map((w) => `<p>aviso: ${esc(w)}</p>`).join('')}<p>safemerge ${esc(report.inputs?.version ?? '')} · ${esc(report.head.shortSha)} · ${esc(new Date(report.generatedAt).toLocaleString('pt-BR'))} · nenhuma branch ou arquivo foi alterado</p></footer>`);

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>safemerge · ${esc(headLabel(report))}</title><style>${CSS}</style></head><body><main>${out.join('')}</main></body></html>\n`;
}
