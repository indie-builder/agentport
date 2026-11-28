export const WORKSPACE_PACKAGES = [
  'shared',
  'contract',
  'core',
  'db',
  'sandbox',
  'worker',
  'api',
  'web',
] as const;

export type WorkspacePackage = (typeof WORKSPACE_PACKAGES)[number];

export type CiMode = 'full' | 'fast' | 'changed' | 'changed:fast';

export type StageName =
  | 'lint:biome'
  | 'lint:focus'
  | 'lint:design'
  | 'lint:contract'
  | 'lint:contract:test'
  | 'lint:lines'
  | 'lint:docs'
  | 'typecheck'
  | 'typecheck:scripts'
  | 'typecheck:e2e'
  | 'typecheck:tests'
  | 'formal'
  | 'build:web'
  | 'openui:check'
  | 'test'
  | 'test:web'
  | 'ci:planner:test'
  | 'e2e';

export type CiOptions = {
  fast: boolean;
  changed: boolean;
  base: string | undefined;
  json: boolean;
  verbose: boolean;
  e2e: boolean;
  help: boolean;
};

export type PlannedStage = {
  stage: StageName;
  args: string[];
  enabled: boolean;
  skipReason: string | undefined;
  fixHint: string | undefined;
  dependsOn: StageName[];
};

export type CiPlanInput = {
  options: CiOptions;
  changedFiles: string[];
  deletedOrRenamedFiles?: string[];
};

export type CiPlan = {
  mode: CiMode;
  fullRun: boolean;
  changedFiles: string[];
  affectedPackages: WorkspacePackage[];
  stages: PlannedStage[];
};

const BACKEND_PACKAGES: readonly WorkspacePackage[] = [
  'shared',
  'contract',
  'core',
  'db',
  'sandbox',
  'worker',
  'api',
];

const TEST_CHECKED_PACKAGES: readonly WorkspacePackage[] = [
  'shared',
  'contract',
  'core',
  'sandbox',
];

const DIRECT_DEPENDENTS: Record<WorkspacePackage, readonly WorkspacePackage[]> = {
  shared: ['contract', 'core', 'db', 'sandbox', 'worker', 'api', 'web'],
  core: ['db', 'worker', 'api', 'web'],
  contract: ['api', 'web'],
  db: ['worker', 'api'],
  sandbox: [],
  worker: [],
  api: [],
  web: [],
};

const ROOT_CONFIG_FILES = new Set([
  'package.json',
  'bun.lock',
  'biome.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.scripts.json',
  'tsconfig.e2e.json',
  'tsconfig.tests.json',
  'Dockerfile',
  'bunfig.toml',
  'vitest.config.ts',
]);

const WORKSPACE_PACKAGE_SET = new Set<string>(WORKSPACE_PACKAGES);

const isWorkspacePackage = (value: string): value is WorkspacePackage =>
  WORKSPACE_PACKAGE_SET.has(value);

export const normalizeRepoPath = (filePath: string): string =>
  filePath.replace(/\\/g, '/').replace(/^\.\//, '');

export const parseCiArgs = (argv: readonly string[]): CiOptions => {
  const options: CiOptions = {
    fast: false,
    changed: false,
    base: undefined,
    json: false,
    verbose: false,
    e2e: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--fast') {
      options.fast = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--e2e') {
      options.e2e = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--changed') {
      options.changed = true;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        options.base = next;
        index += 1;
      }
    } else if (arg.startsWith('--changed=')) {
      options.changed = true;
      const value = arg.slice('--changed='.length);
      if (value.length === 0) {
        throw new Error('Missing base ref after --changed=');
      }
      options.base = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

export const parseGitStatusPorcelain = (
  raw: string,
): { changedFiles: string[]; deletedOrRenamedFiles: string[] } => {
  const tokens = raw.split('\0');
  const changedFiles: string[] = [];
  const deletedOrRenamedFiles: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = normalizeRepoPath(entry.slice(3));
    changedFiles.push(filePath);
    if (xy.includes('D')) {
      deletedOrRenamedFiles.push(filePath);
    }
    if (xy.includes('R') || xy.includes('C')) {
      const origPath = tokens[index + 1];
      if (origPath) {
        const normalizedOrig = normalizeRepoPath(origPath);
        index += 1;
        if (xy.includes('R')) {
          changedFiles.push(normalizedOrig);
          deletedOrRenamedFiles.push(normalizedOrig);
        }
      }
    }
  }

  return { changedFiles, deletedOrRenamedFiles };
};

export const parseGitDiffNameStatus = (
  raw: string,
): { changedFiles: string[]; deletedOrRenamedFiles: string[] } => {
  const tokens = raw.split('\0');
  const changedFiles: string[] = [];
  const deletedOrRenamedFiles: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const firstPath = tokens[index + 1];
      const secondPath = tokens[index + 2];
      index += 2;
      if (secondPath) {
        changedFiles.push(normalizeRepoPath(secondPath));
      }
      if (code === 'R' && firstPath) {
        const normalizedOld = normalizeRepoPath(firstPath);
        changedFiles.push(normalizedOld);
        deletedOrRenamedFiles.push(normalizedOld);
      }
    } else {
      const filePath = tokens[index + 1];
      index += 1;
      if (filePath) {
        const normalized = normalizeRepoPath(filePath);
        changedFiles.push(normalized);
        if (code === 'D') {
          deletedOrRenamedFiles.push(normalized);
        }
      }
    }
  }

  return { changedFiles, deletedOrRenamedFiles };
};

export const computeAffectedPackages = (changedFiles: readonly string[]): WorkspacePackage[] => {
  const direct = new Set<WorkspacePackage>();
  for (const rawFile of changedFiles) {
    const file = normalizeRepoPath(rawFile);
    const match = /^packages\/([^/]+)\/(.+)$/.exec(file);
    if (!match) continue;
    const pkg = match[1];
    const rest = match[2];
    if (!pkg || !rest || !isWorkspacePackage(pkg)) continue;
    if (rest.toLowerCase().endsWith('.md')) continue;
    direct.add(pkg);
  }

  const visited = new Set<WorkspacePackage>(direct);
  const queue: WorkspacePackage[] = [...direct];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const dependent of DIRECT_DEPENDENTS[current]) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return WORKSPACE_PACKAGES.filter((pkg) => visited.has(pkg));
};

const isFormalTriggerFile = (file: string): boolean =>
  file.startsWith('formal/') ||
  file === 'scripts/verify-formal.ts' ||
  file.startsWith('packages/worker/src/runs/') ||
  file.startsWith('packages/worker/src/scheduling/') ||
  file === 'packages/worker/src/knowledge/scheduler.ts' ||
  file.startsWith('packages/api/src/modules/chat/') ||
  file.startsWith('packages/api/src/modules/runs/') ||
  file.startsWith('packages/db/src/repo/runs') ||
  file.startsWith('packages/db/src/schema');

const isOpenuiTriggerFile = (file: string): boolean =>
  file.startsWith('packages/web/src/openui/') ||
  file.startsWith('packages/core/src/generated/') ||
  file.startsWith('packages/core/src/openui') ||
  file.startsWith('packages/shared/src/openui/') ||
  file === 'scripts/generate-openui-meta.mjs' ||
  file === 'scripts/check-openui.mjs' ||
  file === 'package.json';

const isCiPlannerFile = (file: string): boolean =>
  file === 'scripts/ci.ts' ||
  file === 'scripts/ci-planner.ts' ||
  file === 'scripts/ci-planner.test.ts';

const resolveMode = (options: CiOptions): CiMode => {
  if (options.changed) {
    return options.fast ? 'changed:fast' : 'changed';
  }
  return options.fast ? 'fast' : 'full';
};

export const planCi = (input: CiPlanInput): CiPlan => {
  const { options } = input;
  const changedFiles = [...new Set(input.changedFiles.map(normalizeRepoPath))].sort();
  const deletedOrRenamedFiles = [
    ...new Set((input.deletedOrRenamedFiles ?? []).map(normalizeRepoPath)),
  ].sort();

  const mode = resolveMode(options);
  const noChanges = options.changed && changedFiles.length === 0;
  const hasRootConfigChange = changedFiles.some((file) => ROOT_CONFIG_FILES.has(file));
  const fullRun = !options.changed || hasRootConfigChange;
  const affectedPackages = noChanges
    ? []
    : fullRun
      ? [...WORKSPACE_PACKAGES]
      : computeAffectedPackages(changedFiles);

  const affectedSet = new Set<WorkspacePackage>(affectedPackages);
  const anyPackageAffected = affectedPackages.length > 0;
  const anyBackendAffected = BACKEND_PACKAGES.some((pkg) => affectedSet.has(pkg));
  const webAffected = affectedSet.has('web');

  const stageFromFlag = (
    stage: StageName,
    args: string[],
    active: boolean,
    opts: {
      fastSkipped?: boolean;
      fixHint?: string;
      dependsOn?: StageName[];
    } = {},
  ): PlannedStage => {
    const fastBlocked = Boolean(opts.fastSkipped && options.fast);
    const enabled = !noChanges && active && !fastBlocked;
    const skipReason = enabled
      ? undefined
      : noChanges
        ? 'no changes'
        : fastBlocked
          ? '--fast'
          : 'unchanged';
    return {
      stage,
      args,
      enabled,
      skipReason,
      fixHint: opts.fixHint,
      dependsOn: opts.dependsOn ?? [],
    };
  };

  const openuiActive = fullRun || changedFiles.some(isOpenuiTriggerFile);
  const typecheckActive = fullRun || anyPackageAffected || (openuiActive && !options.fast);
  const testSupportChanged = changedFiles.some((file) => file.startsWith('tests/support/'));
  const testActive = fullRun || anyBackendAffected || testSupportChanged;
  const testEnabled = testActive && !options.fast;

  const stages: PlannedStage[] = [
    stageFromFlag(
      'lint:biome',
      ['run', 'lint'],
      fullRun || changedFiles.some((file) => /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file)),
      { fixHint: 'bun run lint:fix' },
    ),
    stageFromFlag(
      'lint:focus',
      ['run', 'lint:focus'],
      fullRun || webAffected || changedFiles.includes('scripts/check-focus-contract.mjs'),
    ),
    stageFromFlag(
      'lint:design',
      ['run', 'lint:design'],
      fullRun || webAffected || changedFiles.includes('packages/web/.oxlintrc.json'),
    ),
    stageFromFlag(
      'lint:contract',
      ['run', 'lint:contract'],
      fullRun ||
        anyPackageAffected ||
        changedFiles.includes('Dockerfile') ||
        changedFiles.includes('scripts/check-project-contract.mjs'),
    ),
    stageFromFlag(
      'lint:contract:test',
      ['run', 'lint:contract:test'],
      fullRun ||
        changedFiles.includes('scripts/check-project-contract.mjs') ||
        changedFiles.includes('scripts/check-project-contract.test.ts'),
    ),
    stageFromFlag(
      'lint:lines',
      ['run', 'lint:lines'],
      fullRun ||
        changedFiles.some((file) => /\.(?:[jt]sx?|mjs|json)$/.test(file)) ||
        changedFiles.includes('scripts/check-file-lines.mjs'),
    ),
    stageFromFlag(
      'lint:docs',
      ['run', 'lint:docs'],
      fullRun ||
        changedFiles.some((file) => file.toLowerCase().endsWith('.md')) ||
        changedFiles.includes('scripts/check-docs.mjs') ||
        deletedOrRenamedFiles.some((file) => /^(?:packages|scripts|tests)\//.test(file)),
    ),
    stageFromFlag('typecheck', ['run', 'typecheck'], typecheckActive),
    stageFromFlag(
      'typecheck:scripts',
      ['run', 'typecheck:scripts'],
      fullRun ||
        anyPackageAffected ||
        testSupportChanged ||
        changedFiles.some((file) => file.startsWith('scripts/')),
      { dependsOn: ['typecheck'] },
    ),
    stageFromFlag(
      'typecheck:e2e',
      ['run', 'typecheck:e2e'],
      fullRun || anyBackendAffected || changedFiles.some((file) => file.startsWith('tests/')),
      { dependsOn: ['typecheck'] },
    ),
    stageFromFlag(
      'typecheck:tests',
      ['run', 'typecheck:tests'],
      fullRun || TEST_CHECKED_PACKAGES.some((pkg) => affectedSet.has(pkg)),
      { dependsOn: ['typecheck'] },
    ),
    stageFromFlag(
      'formal',
      ['run', 'verify:formal'],
      fullRun || changedFiles.some(isFormalTriggerFile),
      { fastSkipped: true },
    ),
    stageFromFlag(
      'build:web',
      ['run', '--filter', '@agentport/web', 'build'],
      fullRun || webAffected,
      { fastSkipped: true, dependsOn: ['typecheck'] },
    ),
    stageFromFlag(
      'openui:check',
      testEnabled ? ['run', 'openui:check', '--', '--no-tests'] : ['run', 'openui:check'],
      openuiActive,
      {
        fastSkipped: true,
        fixHint: 'bun run openui:spec',
        dependsOn: ['typecheck'],
      },
    ),
    stageFromFlag('test', ['run', 'test:sharded'], testActive, {
      fastSkipped: true,
      dependsOn: ['typecheck'],
    }),
    stageFromFlag('test:web', ['run', 'test:web', '--', '--maxWorkers=4'], fullRun || webAffected, {
      fastSkipped: true,
      dependsOn: ['typecheck'],
    }),
    stageFromFlag(
      'ci:planner:test',
      ['test', '--cwd', 'scripts', './ci-planner.test.ts'],
      fullRun || changedFiles.some(isCiPlannerFile),
    ),
  ];

  if (options.e2e) {
    stages.push(
      stageFromFlag('e2e', ['run', 'e2e:suite'], true, {
        fastSkipped: true,
        dependsOn: ['typecheck', 'typecheck:e2e', 'build:web', 'openui:check', 'test', 'test:web'],
      }),
    );
  }

  return {
    mode,
    fullRun,
    changedFiles,
    affectedPackages,
    stages,
  };
};
