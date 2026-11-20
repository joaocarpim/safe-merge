// Gera os prints do README (docs/imagens/*.png) a partir de saídas REAIS da ferramenta no cenário
// complexo (examples/make-demo-complex.sh). Usa o Edge ou o Chrome em modo headless.
// Rodar: npm run build && node scripts/screenshots.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const OUT = join(ROOT, 'docs', 'imagens');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const BROWSER = BROWSERS.find((b) => existsSync(b));
if (!BROWSER) throw new Error('Edge ou Chrome não encontrado');
if (!existsSync(CLI)) throw new Error('rode npm run build antes');

const tmp = mkdtempSync(join(tmpdir(), 'sm-prints-'));
const repo = join(tmp, 'repo');
mkdirSync(OUT, { recursive: true });

// ─── PNG: decodificar, cortar a sobra de baixo, codificar ────────────────────────────────────────
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8) throw new Error('PNG de 16 bits'); }
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG tipo ${type} não suportado`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
function encodePng({ w, h, bpp, px }) {
  const stride = w * bpp, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** Corta as linhas de baixo iguais ao fundo, deixando uma margem. */
function trimBottom(file, margin = 28) {
  const img = decodePng(readFileSync(file));
  const { w, h, bpp, px } = img, stride = w * bpp;
  const bg = px.subarray((h - 1) * stride, (h - 1) * stride + bpp);
  let last = h - 1;
  outer: for (; last > 0; last--) {
    for (let x = 0; x < w; x += 2) for (let k = 0; k < 3; k++) if (Math.abs(px[last * stride + x * bpp + k] - bg[k]) > 6) break outer;
  }
  const nh = Math.min(h, last + 1 + margin);
  writeFileSync(file, encodePng({ w, h: nh, bpp, px: px.subarray(0, nh * stride) }));
  return nh;
}

function shoot(html, png, width = 1280, height = 7000) {
  const htmlFile = join(tmp, `${png.replace(/\W/g, '_')}.html`);
  writeFileSync(htmlFile, html);
  const target = join(OUT, png);
  const r = spawnSync(BROWSER, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=1', `--user-data-dir=${join(tmp, 'browser')}`, `--window-size=${width},${height}`, `--screenshot=${target}`, pathToFileURL(htmlFile).href], { encoding: 'utf8', timeout: 120_000 });
  if (!existsSync(target)) throw new Error(`print falhou (${png}): ${r.stderr}`);
  const h = trimBottom(target);
  console.log(`  ${png} (${width}×${h})`);
}

// ─── terminal: ANSI → HTML com cara de terminal ──────────────────────────────────────────────────
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function ansiToHtml(text) {
  const cls = { 1: 'b', 2: 'd', 31: 'r', 32: 'g', 33: 'y', 36: 'c' };
  let out = '', open = 0;
  for (const part of text.split(/(\u001b\[\d+m)/)) {
    const m = part.match(/^\u001b\[(\d+)m$/);
    if (!m) { out += esc(part); continue; }
    if (m[1] === '0') { out += '</span>'.repeat(open); open = 0; } else if (cls[m[1]]) { out += `<span class="${cls[m[1]]}">`; open++; }
  }
  return out + '</span>'.repeat(open);
}
function terminal(title, command, output) {
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#e9ebe8;padding:28px;font-family:"Cascadia Mono","Cascadia Code",Consolas,"DejaVu Sans Mono",monospace}
.w{max-width:1180px;margin:0 auto;background:#14161a;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.25);overflow:hidden}
.t{background:#23262c;color:#9aa2ad;font:12.5px system-ui,sans-serif;padding:10px 14px;display:flex;gap:7px;align-items:center}
.t i{width:12px;height:12px;border-radius:50%;display:inline-block}.t span{margin-left:10px}
pre{margin:0;padding:18px 20px 22px;color:#d8dde3;font-size:14px;line-height:1.5;white-space:pre-wrap;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}
.p{color:#3cc489}.b{font-weight:700}.d{color:#7d8590}.r{color:#ff7b72}.g{color:#3fb950}.y{color:#e3b341}.c{color:#58a6ff}
</style><div class="w"><div class="t"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>${esc(title)}</span></div><pre><span class="p">$</span> ${esc(command)}\n${ansiToHtml(output)}</pre></div>`;
}

function cli(args, cwd = repo, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', ...extraEnv } });
}

// ─── cenário ─────────────────────────────────────────────────────────────────────────────────────
console.log('criando o cenário complexo…');
const made = spawnSync('bash', [join(ROOT, 'examples', 'make-demo-complex.sh'), repo], { encoding: 'utf8' });
if (made.status !== 0) throw new Error(made.stderr);
const prs = ['--prs-file', 'prs.json'];

const SITUACOES = [
  ['pode-mergear', 'feat/galeria-fotos', 'Pode mergear: merge limpo, testes passaram no merge'],
  ['conflito-de-texto', 'feat/desconto-orcamento', 'Conflito de texto com o destino, mesma função em outro PR, branch atrasada'],
  ['conflito-semantico', 'feat/recibo-pix', 'Conflito semântico: merge limpo, testes quebram, função removida no destino'],
  ['seguranca-e-deploy', 'feat/cobranca-pix', 'Segurança e deploy: 7 problemas numa branch'],
  ['workflow-perigoso', 'feat/ci-preview', 'Workflow de CI perigoso (pull_request_target + injeção)'],
  ['segredo-no-historico', 'feat/integracao-mercadopago', 'Segredo apagado mas ainda no histórico'],
  ['apagado-x-alterado', 'feat/relatorio-pdf', 'Arquivo alterado aqui e apagado no destino'],
  ['lockfile', 'chore/deps', 'Conflito só em lockfile: aviso para regenerar'],
  ['migracoes', 'feat/migracao-fotos', 'Duas branches com migração de mesmo número'],
  ['teste-instavel', 'feat/teste-instavel', 'Teste instável: repetido antes de acusar'],
  ['pr-empilhado', 'feat/agenda-notificacoes', 'PR empilhado sobre outro PR aberto'],
  ['renomeacao', 'fix/log-formato', 'Destino renomeou o arquivo que a branch alterou'],
  ['nada-a-mergear', 'feat/ja-mergeada', 'Branch que já está no destino'],
];

console.log('relatórios (painel da extensão), tema claro e escuro:');
const index = [];
for (const [nome, branch, legenda] of SITUACOES) {
  const r = cli(['--head', branch, '--no-fetch', ...prs, '--format', 'html', '--fail-on', 'never']);
  if (r.status !== 0) throw new Error(`${branch}: ${r.stderr}`);
  shoot(r.stdout.replace('<html lang="pt-BR">', '<html lang="pt-BR" data-theme="light">'), `relatorio-${nome}.png`);
  shoot(r.stdout.replace('<html lang="pt-BR">', '<html lang="pt-BR" data-theme="dark">'), `relatorio-${nome}-escuro.png`);
  index.push({ nome, branch, legenda });
}

console.log('terminal:');
const term = (png, title, cmdShown, args, cwd, env) => {
  const r = cli(args, cwd, env);
  shoot(terminal(title, cmdShown, r.stdout + (r.stderr && !r.stdout ? r.stderr : '')), png, 1240);
};
term('terminal-nao-mergear.png', 'safemerge · feat/cobranca-pix', 'safemerge --head feat/cobranca-pix', ['--head', 'feat/cobranca-pix', '--no-fetch', ...prs]);
term('terminal-pode-mergear.png', 'safemerge · feat/galeria-fotos', 'safemerge --head feat/galeria-fotos', ['--head', 'feat/galeria-fotos', '--no-fetch', ...prs]);
term('terminal-matrix.png', 'safemerge matrix', 'safemerge matrix', ['matrix', '--no-fetch']);
term('terminal-replay.png', 'safemerge replay', 'safemerge replay --limit 300', ['replay', '--limit', '300']);

// verify-text: resumo de IA com um id inventado e uma contagem errada
const rep = cli(['--head', 'feat/cobranca-pix', '--no-fetch', ...prs, '--format', 'json', '--fail-on', 'never']);
writeFileSync(join(tmp, 'r.json'), rep.stdout);
const j = JSON.parse(rep.stdout);
writeFileSync(join(tmp, 'resposta.md'), `Não mergear: há ${j.summary.findings.block} bloqueios, entre eles ${j.findings[0].id} (${j.findings[0].file}:${j.findings[0].line}).\nTambém corrija o achado SM-deadbeef e os 9 arquivos em conflito.\n`);
term('terminal-verify-text.png', 'safemerge verify-text', 'safemerge verify-text --report r.json resposta.md', ['verify-text', '--report', join(tmp, 'r.json'), join(tmp, 'resposta.md')]);

// verify-resolution: proposta boa e proposta que quebra o teste
spawnSync('git', ['checkout', '-q', 'feat/desconto-orcamento'], { cwd: repo });
const boa = "const { prisma } = require('../db');\n\n// Total com desconto, arredondado em centavos.\nfunction calcularTotal(itens, descontoPercentual = 0) {\n  const bruto = itens.reduce((soma, i) => soma + i.preco * i.quantidade, 0);\n  return Math.round(bruto * (1 - descontoPercentual / 100) * 100) / 100;\n}\n\nfunction listarOrcamentos(tenantId) {\n  return prisma.orcamento.findMany({ where: { tenantId } });\n}\n\nmodule.exports = { calcularTotal, listarOrcamentos };\n";
writeFileSync(join(tmp, 'boa.js'), boa);
writeFileSync(join(tmp, 'ruim.js'), boa.replace('return Math.round', 'return 2 * Math.round'));
term('terminal-resolucao-verificada.png', 'safemerge verify-resolution', 'safemerge verify-resolution --target dev --file src/server/services/orcamento.js=boa.js', ['verify-resolution', '--target', 'dev', '--file', `src/server/services/orcamento.js=${join(tmp, 'boa.js')}`, '--isolation', 'none']);
term('terminal-resolucao-falhou.png', 'safemerge verify-resolution', 'safemerge verify-resolution --target dev --file src/server/services/orcamento.js=ruim.js', ['verify-resolution', '--target', 'dev', '--file', `src/server/services/orcamento.js=${join(tmp, 'ruim.js')}`, '--isolation', 'none']);

// hook pre-push bloqueando
cli(['install-hook']);
// commit novo: sem ele o push não tem o que enviar e o hook nem roda
writeFileSync(join(repo, 'docs-nota.md'), 'nota\n');
spawnSync('git', ['add', 'docs-nota.md'], { cwd: repo });
spawnSync('git', ['commit', '-q', '-m', 'nota'], { cwd: repo });
const push = spawnSync('git', ['push', 'origin', 'feat/desconto-orcamento'], { cwd: repo, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1' } });
shoot(terminal('git push (hook pre-push do safemerge)', 'git push origin feat/desconto-orcamento', `${push.stdout}${push.stderr}`), 'terminal-hook-pre-push.png', 1240);

// erro: fora de um repositório
term('terminal-erro.png', 'safemerge fora de um repositório', 'safemerge', [], tmp);

writeFileSync(join(OUT, 'situacoes.json'), `${JSON.stringify(index, null, 2)}\n`);
rmSync(tmp, { recursive: true, force: true });
console.log(`pronto: ${OUT}`);
