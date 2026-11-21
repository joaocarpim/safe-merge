import { touchedFiles, findLine, showFile } from '../diff.js';
import type { FindingDraft } from '../findings.js';
import type { Check, CheckContext, CheckOutput } from './types.js';

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  hasInstallScript?: boolean;
  link?: boolean;
  optional?: boolean;
}

interface ParsedLock {
  version: number;
  packages: Map<string, LockEntry>;
}

export function parseLock(text: string | null): ParsedLock | null {
  if (!text) return null;
  try {
    const doc = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, LockEntry> };
    const packages = new Map<string, LockEntry>();
    for (const [key, entry] of Object.entries(doc.packages ?? {})) if (key !== '') packages.set(key, entry ?? {});
    return { version: doc.lockfileVersion ?? 1, packages };
  } catch {
    return null;
  }
}

/** Pacotes populares cujo script de instalação é legítimo (binário nativo, download da plataforma). */
export const KNOWN_INSTALL_SCRIPTS = new Set([
  'fsevents', 'esbuild', 'sharp', 'core-js', 'husky', 'bcrypt', 'sqlite3', 'better-sqlite3', 'canvas', 'puppeteer', 'playwright',
  'cypress', 'electron', 'protobufjs', 'nodemon', 'unrs-resolver', 'msw', 'prisma', 'lightningcss', 'node-sass', 'sass', 're2',
  'bufferutil', 'utf-8-validate', 'keytar', 'tree-sitter', 'nx', 'turbo', 'workerd', 'bun', 'oxc-resolver',
]);

function isKnownInstaller(name: string): boolean {
  return KNOWN_INSTALL_SCRIPTS.has(name) || /^@(esbuild|swc|parcel|rollup|next|img|biomejs|napi-rs|tailwindcss|prisma|sentry|oxc-resolver|unrs|lightningcss)\//.test(name);
}

function packageName(key: string): string {
  const i = key.lastIndexOf('node_modules/');
  return i === -1 ? key : key.slice(i + 'node_modules/'.length);
}

/**
 * Compara o package-lock do ponto de partida com o da branch e acusa, nos pacotes novos ou trocados:
 * script de instalação (vetor do Shai-Hulud), origem fora do registro permitido e falta de integrity sha512.
 */
export function diffLock(path: string, beforeText: string | null, afterText: string, allowed: string[]): { findings: FindingDraft[]; error?: string } {
  const after = parseLock(afterText);
  if (!after) return { findings: [], error: `${path} não é JSON válido` };
  if (after.version < 2) return { findings: [], error: `${path} usa lockfileVersion ${after.version}; só 2 e 3 são verificados` };
  const before = parseLock(beforeText)?.packages ?? new Map<string, LockEntry>();
  const findings: FindingDraft[] = [];

  for (const [key, entry] of after.packages) {
    if (!key.includes('node_modules/') || entry.link) continue; // pacote do próprio workspace
    const old = before.get(key);
    const changed = !old || old.version !== entry.version || old.resolved !== entry.resolved || old.integrity !== entry.integrity || old.hasInstallScript !== entry.hasInstallScript;
    if (!changed) continue;
    const name = packageName(key);
    const at = `${name}@${entry.version ?? '?'}`;
    const keyLine = findLine(afterText, `"${key}": {`) ?? null;
    const base = { file: path, source: 'safemerge', category: 'supply-chain' } as const;

    const known = isKnownInstaller(name) || entry.optional === true;
    if (entry.hasInstallScript && !old?.hasInstallScript) {
      const line = keyLine ? (findLine(afterText, '"hasInstallScript"', keyLine) ?? keyLine) : null;
      findings.push({
        ...base,
        rule: 'install-script',
        title: 'Pacote novo com script de instalação',
        message: known
          ? `${at} roda código na instalação, mas é um pacote conhecido por isso (binário nativo ou download da plataforma)${entry.optional ? ' e é dependência opcional' : ''}. Só confira se é o pacote oficial.`
          : `${at} roda código na instalação (preinstall/install/postinstall). É o vetor de worms como o Shai-Hulud: confira se o pacote é esperado e confiável.`,
        severity: known ? 'info' : 'high',
        confidence: 'high',
        line,
        evidence: `${key}: "hasInstallScript": true (versão ${entry.version ?? '?'})`,
      });
    }

    const resolved = entry.resolved;
    const isHttp = resolved ? /^https?:\/\//.test(resolved) : false;
    if (resolved && !allowed.some((prefix) => resolved.startsWith(prefix))) {
      const line = keyLine ? (findLine(afterText, '"resolved"', keyLine) ?? keyLine) : null;
      findings.push({
        ...base,
        rule: 'untrusted-source',
        title: 'Pacote baixado de fora do registro permitido',
        message: `${at} vem de ${resolved}. Origens fora do registro oficial (git, tarball, outro host) não passam pelas proteções do registro.`,
        severity: 'high',
        confidence: 'high',
        line,
        evidence: `${key}: "resolved": "${resolved}"`,
      });
    }
    if (resolved && isHttp && !entry.integrity) {
      findings.push({
        ...base,
        rule: 'missing-integrity',
        title: 'Pacote sem hash de integridade',
        message: `${at} não tem "integrity": o npm não consegue conferir se o arquivo baixado é o esperado.`,
        severity: 'medium',
        confidence: 'high',
        line: keyLine,
        evidence: `${key}: sem "integrity"`,
      });
    } else if (entry.integrity && !entry.integrity.startsWith('sha512-')) {
      const line = keyLine ? (findLine(afterText, '"integrity"', keyLine) ?? keyLine) : null;
      findings.push({
        ...base,
        rule: 'weak-integrity',
        title: 'Hash de integridade fraco',
        message: `${at} usa ${entry.integrity.split('-')[0]} em vez de sha512.`,
        severity: 'low',
        confidence: 'high',
        line,
        evidence: `${key}: "integrity": "${entry.integrity.slice(0, 20)}…"`,
      });
    }
  }
  return { findings };
}

function isPackageLock(path: string): boolean {
  return path === 'package-lock.json' || path.endsWith('/package-lock.json');
}

export const lockfileCheck: Check = {
  id: 'lockfile',
  label: 'Dependências novas no package-lock',
  run(ctx: CheckContext): CheckOutput {
    const changed = touchedFiles(ctx.cwd, ctx.mergeBase, ctx.headRef);
    const locks = changed.filter(isPackageLock);
    const others = changed.filter((f) => /(^|\/)(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(f));
    const note = others.length > 0 ? `; ${others.join(', ')} mudou e não é verificado` : '';
    if (locks.length === 0) {
      return { coverage: { check: this.id, label: this.label, status: 'skipped', reason: `package-lock.json não mudou nesta branch${note}` }, findings: [] };
    }
    const findings: FindingDraft[] = [];
    const errors: string[] = [];
    for (const path of locks) {
      const after = showFile(ctx.cwd, ctx.headRef, path, 100_000_000);
      if (after === null) {
        errors.push(`não consegui ler ${path}`);
        continue;
      }
      const before = showFile(ctx.cwd, ctx.mergeBase, path, 100_000_000);
      const res = diffLock(path, before, after, ctx.cfg.security.allowedRegistries);
      if (res.error) errors.push(res.error);
      findings.push(...res.findings);
    }
    const status = errors.length > 0 && findings.length === 0 && errors.length === locks.length ? 'error' : 'ran';
    const reason = [...errors, ...(note ? [note.slice(2)] : [])].join('; ') || undefined;
    return { coverage: { check: this.id, label: this.label, status, reason }, findings };
  },
};
