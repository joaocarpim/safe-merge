import type { BranchRef } from '../branches.js';
import type { Config } from '../config.js';
import type { CoverageEntry, FindingDraft } from '../findings.js';
import type { ToolRunner } from '../tools.js';

export interface CheckContext {
  cwd: string;
  /** Referência da sua branch (pode ser `HEAD`). */
  headRef: string;
  headSha: string;
  /** Destino que decide o veredito. */
  target: BranchRef;
  /** Ponto de partida comum entre a sua branch e o destino. */
  mergeBase: string;
  /** Commit solto com o resultado do merge com o destino; null se há conflito de texto. */
  mergedCommit?: string | null;
  /** Outras branches ainda não mergeadas (para migrações conflitantes). */
  others: BranchRef[];
  cfg: Config;
  tools: ToolRunner;
}

export interface CheckOutput {
  coverage: Omit<CoverageEntry, 'findings'>;
  findings: FindingDraft[];
}

export interface Check {
  id: string;
  label: string;
  run(ctx: CheckContext): CheckOutput;
}
