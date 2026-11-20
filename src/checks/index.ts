import { domainCheck } from './domain.js';
import { envVarsCheck } from './envvars.js';
import { hygieneCheck } from './hygiene.js';
import { riskCheck } from './risk.js';
import { sastCheck, secretsCheck, workflowsCheck } from './external.js';
import { lockfileCheck } from './lockfile.js';
import { migrationsCheck } from './migrations.js';
import { osvCheck } from './osv.js';
import type { Check } from './types.js';
import { symbolsCheck } from './symbols.js';
import { activeSecretsCheck } from './trufflehog.js';
import { untestedCheck } from './untested.js';

/** Verificações da fase de segurança e deploy, na ordem em que aparecem no relatório. */
export const SECURITY_CHECKS: Check[] = [secretsCheck, activeSecretsCheck, lockfileCheck, osvCheck, workflowsCheck, sastCheck, migrationsCheck, envVarsCheck, symbolsCheck, domainCheck, hygieneCheck, riskCheck, untestedCheck];

export type { Check, CheckContext, CheckOutput } from './types.js';
