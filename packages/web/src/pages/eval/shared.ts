export type EvalTab = 'runs' | 'cases' | 'compare';

export type EvalDiffFilter = 'changed' | 'regressed' | 'all';

export type EvalSearchPatch = {
  agent?: string | undefined;
  tab?: EvalTab | undefined;
  run?: string | undefined;
  failedOnly?: string | undefined;
  caseId?: string | undefined;
  base?: string | undefined;
  head?: string | undefined;
  diff?: EvalDiffFilter | undefined;
};
