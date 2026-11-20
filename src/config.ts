import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Confidence, Severity } from './findings.js';

export interface Config {
  /** Expressões (casamento exato) das branches que contam como principais. */
  mainBranchPatterns: string[];
  /** Para onde feature/fix devem apontar: a primeira que existir. */
  integrationPriority: string[];
  /** Avisa quando a branch está atrás da base por mais commits que isso. */
  warnBehindCommits: number;
  overlap: {
    /** Ignora branches remotas sem commits há mais dias que isso. */
    maxAgeDays: number;
    /** Arquivos que conflitam o tempo todo e se resolvem sozinhos (expressões). */
    ignorePaths: string[];
  };
  semantic: {
    /** Comando de testes rodado no resultado do merge. Sem ele, a checagem é pulada. */
    command: string | null;
    /** Comando de build rodado antes dos testes no resultado do merge (opcional). */
    buildCommand: string | null;
    /** Pastas ligadas por link simbólico dentro da cópia temporária. */
    symlink: string[];
    timeoutSec: number;
    /** Quantas vezes repetir um teste que falhou antes de acusar (resultado que muda = instável). */
    retries: number;
  };
  isolation: {
    /** `auto`: Docker sem rede se disponível, senão local com ambiente limpo. `docker`: exige. `none`: local. */
    mode: 'auto' | 'docker' | 'none';
    image: string;
    /** Registra rede, arquivos e processos tocados pelos testes com strace (só Linux, só modo local). */
    trace: boolean;
    /** Variáveis de ambiente repassadas aos testes no modo local. O resto (tokens, chaves) fica de fora. */
    envAllow: string[];
  };
  security: {
    enabled: boolean;
    blockSeverity: Severity;
    blockConfidence: Confidence;
    /** Prefixos aceitos no `resolved` do package-lock. */
    allowedRegistries: string[];
    semgrepConfig: string;
    /** Confirma com o provedor se o segredo está ativo (TruffleHog). Desligado: pode gerar alerta no provedor. */
    verifySecrets: boolean;
    /** Nome ou caminho de cada ferramenta externa. */
    tools: { gitleaks: string; semgrep: string; zizmor: string; docker: string; mergiraf: string; strace: string; osvScanner: string; trufflehog: string };
  };
  migrations: {
    /** Expressões que identificam arquivos de migração. */
    paths: string[];
  };
  mergiraf: {
    /** Tenta o Mergiraf (se instalado) nos arquivos em conflito para separar conflito real de conflito só de linha. */
    enabled: boolean;
  };
  domain: {
    /** Modelos/tabelas que pertencem a um tenant (ex.: ["Orcamento", "Cliente"]). Vazio: regra não roda. */
    tenantModels: string[];
    /** Nomes do campo de tenant aceitos no filtro. */
    tenantFields: string[];
    /** Palavras que indicam autenticação na rota ou no arquivo. */
    authMarkers: string[];
    /** Rotas públicas de propósito (expressões sobre o caminho). */
    publicRoutes: string[];
  };
}

export const DEFAULT_CONFIG: Config = {
  mainBranchPatterns: ['main', 'master', 'dev', 'develop', 'staging', 'homolog(acao)?', 'prod(ucao|uction)?'],
  integrationPriority: ['dev', 'develop', 'staging', 'homolog'],
  warnBehindCommits: 30,
  overlap: {
    maxAgeDays: 60,
    ignorePaths: [
      '(^|/)package-lock\\.json$',
      '(^|/)yarn\\.lock$',
      '(^|/)pnpm-lock\\.yaml$',
      '(^|/)poetry\\.lock$',
      '(^|/)Pipfile\\.lock$',
      '(^|/)composer\\.lock$',
      '(^|/)Gemfile\\.lock$',
      '(^|/)go\\.sum$',
      '(^|/)Cargo\\.lock$',
    ],
  },
  semantic: { command: null, buildCommand: null, symlink: ['node_modules'], timeoutSec: 600, retries: 1 },
  isolation: {
    mode: 'auto',
    image: 'node:20-bookworm-slim',
    trace: true,
    envAllow: [
      'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'SYSTEMROOT', 'windir',
      'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
      'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'TERM', 'SHELL',
      'USER', 'LOGNAME', 'TZ', 'NODE_ENV',
    ],
  },
  security: {
    enabled: true,
    blockSeverity: 'high',
    blockConfidence: 'medium',
    allowedRegistries: ['https://registry.npmjs.org/'],
    semgrepConfig: 'p/default',
    verifySecrets: false,
    tools: { gitleaks: 'gitleaks', semgrep: 'semgrep', zizmor: 'zizmor', docker: 'docker', mergiraf: 'mergiraf', strace: 'strace', osvScanner: 'osv-scanner', trufflehog: 'trufflehog' },
  },
  migrations: {
    paths: [
      '(^|/)migrations?/',
      '(^|/)db/migrate/',
      '(^|/)supabase/migrations/',
      '(^|/)prisma/migrations/',
      '(^|/)db/migration/',
    ],
  },
  mergiraf: { enabled: true },
  domain: {
    tenantModels: [],
    tenantFields: ['tenantId', 'tenant_id', 'empresaId', 'empresa_id', 'companyId', 'company_id', 'organizationId', 'organization_id', 'contaId', 'conta_id'],
    authMarkers: ['auth', 'authenticate', 'requireAuth', 'isAuthenticated', 'ensureAuth', 'protect', 'verifyToken', 'jwt', 'getServerSession', 'currentUser', 'Depends(get_current', 'login_required', 'passport', 'clerk', 'withAuth'],
    publicRoutes: ['^/?(health|healthz|status|ping|ready|live)', 'webhook', '^/?public/'],
  },
};

export const CONFIG_PATH = '.safemerge/config.json';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Mescla em profundidade; listas são substituídas por inteiro. */
export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? mergeConfig((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

export function loadConfig(repoDir: string, explicitPath?: string): Config {
  const path = explicitPath ?? join(repoDir, CONFIG_PATH);
  if (!existsSync(path)) {
    if (explicitPath) throw new Error(`arquivo de configuração não encontrado: ${explicitPath}`);
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`configuração inválida em ${path}: ${(err as Error).message}`);
  }
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

export function compileRegexes(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p);
    } catch {
      throw new Error(`expressão regular inválida na configuração: ${p}`);
    }
  });
}
