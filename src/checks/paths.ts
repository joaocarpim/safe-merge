/**
 * Arquivos e linhas que as regras de revisão não devem cobrar: ninguém escreve à mão (gerados, de terceiros)
 * ou os valores de desenvolvimento são normais ali (configuração). Foi o que o teste em repositórios reais
 * mostrou: 100% do ruído vinha daqui ou de padrões amplos demais.
 */

/** Gerados, de build ou de terceiros. */
export const GENERATED =
  /\.(gen|generated)\.[^/]+$|(^|\/)(generated|__generated__|dist|build|out|vendor|node_modules|\.next|\.nuxt|coverage)\/|\.d\.ts$|\.min\.(js|css)$|\.map$|(^|\/)(routeTree\.gen\.ts|schema\.graphql|openapi\.json|swagger\.json)$/;

/** Configuração: URLs e valores padrão de desenvolvimento são normais aqui. */
export const CONFIG_FILE =
  /(^|\/)((settings|config)(\.[\w-]+)?\.(py|js|ts|mjs|cjs|json|ya?ml)|[\w.-]*\.config\.[cm]?[jt]s|docker-compose[\w.-]*\.ya?ml|\.env[\w.-]*|conftest\.py|playwright\.config\.[jt]s)$/;

/** Linha que é só comentário. */
export function isCommentLine(text: string): boolean {
  return /^\s*(\/\/|#|\*|\/\*|--|<!--)/.test(text);
}

/** Valor com cara de exemplo, não de segredo. */
export function looksLikePlaceholder(text: string): boolean {
  return /changeme|change-me|example|your[_-]|xxx|<[^>]+>|\*{3,}|dummy|fake|sample|placeholder|test|senha123|password123|secret123|123456/i.test(text);
}
