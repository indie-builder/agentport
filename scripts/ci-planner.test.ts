import { describe, expect, test } from 'bun:test';
import {
  computeAffectedPackages,
  parseCiArgs,
  parseGitDiffNameStatus,
  parseGitStatusPorcelain,
  planCi,
} from './ci-planner.js';

describe('parseCiArgs', () => {
  test('parses defaults', () => {
    expect(parseCiArgs([])).toEqual({
      fast: false,
      changed: false,
      base: undefined,
      json: false,
      verbose: false,
      e2e: false,
      security: false,
      help: false,
    });
  });

  test('parses --changed with optional base and flags', () => {
    expect(parseCiArgs(['--changed', 'main', '--fast', '--json'])).toEqual({
      fast: true,
      changed: true,
      base: 'main',
      json: true,
      verbose: false,
      e2e: false,
      security: false,
      help: false,
    });

    expect(parseCiArgs(['--changed', '--verbose', '--e2e', '--security'])).toEqual({
      fast: false,
      changed: true,
      base: undefined,
      json: false,
      verbose: true,
      e2e: true,
      security: true,
      help: false,
    });

    expect(parseCiArgs(['--changed=HEAD~1'])).toEqual({
      fast: false,
      changed: true,
      base: 'HEAD~1',
      json: false,
      verbose: false,
      e2e: false,
      security: false,
      help: false,
    });
  });

  test('rejects unknown args and empty --changed=', () => {
    expect(() => parseCiArgs(['--bogus'])).toThrow('Unknown argument: --bogus');
    expect(() => parseCiArgs(['--changed='])).toThrow('Missing base ref after --changed=');
  });
});

describe('computeAffectedPackages', () => {
  test('propagates workspace dependency DAG transitively', () => {
    expect(computeAffectedPackages(['packages/shared/src/id.ts'])).toEqual([
      'shared',
      'contract',
      'core',
      'db',
      'sandbox',
      'worker',
      'api',
      'web',
    ]);
    expect(computeAffectedPackages(['packages/core/src/logger.ts'])).toEqual([
      'core',
      'db',
      'worker',
      'api',
      'web',
    ]);
    expect(computeAffectedPackages(['packages/contract/src/chat.ts'])).toEqual([
      'contract',
      'api',
      'web',
    ]);
    expect(computeAffectedPackages(['packages/db/src/client.ts'])).toEqual(['db', 'worker', 'api']);
    expect(computeAffectedPackages(['packages/web/src/App.tsx'])).toEqual(['web']);
    expect(computeAffectedPackages(['packages/sandbox/src/runner.ts'])).toEqual(['sandbox']);
  });

  test('ignores markdown docs inside packages', () => {
    expect(computeAffectedPackages(['packages/web/AGENTS.md', 'docs/DEV-WORKFLOW.md'])).toEqual([]);
  });
});

describe('git status and diff parsers', () => {
  test('parses porcelain v1 -z with renames and deletions', () => {
    const raw = [
      ' M scripts/ci.ts',
      '?? scripts/ci-planner.ts',
      ' D packages/web/old.ts',
      'R  packages/core/new.ts',
      'packages/core/old.ts',
      '',
    ].join('\0');
    expect(parseGitStatusPorcelain(raw)).toEqual({
      changedFiles: [
        'scripts/ci.ts',
        'scripts/ci-planner.ts',
        'packages/web/old.ts',
        'packages/core/new.ts',
        'packages/core/old.ts',
      ],
      deletedOrRenamedFiles: ['packages/web/old.ts', 'packages/core/old.ts'],
    });
  });

  test('marks old package and dependents affected on staged cross-package rename', () => {
    const raw = ['R  scripts/foo.ts', 'packages/core/src/foo.ts', ''].join('\0');
    const parsed = parseGitStatusPorcelain(raw);
    expect(parsed).toEqual({
      changedFiles: ['scripts/foo.ts', 'packages/core/src/foo.ts'],
      deletedOrRenamedFiles: ['packages/core/src/foo.ts'],
    });

    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: parsed.changedFiles,
      deletedOrRenamedFiles: parsed.deletedOrRenamedFiles,
    });
    const stages = new Map(plan.stages.map((stage) => [stage.stage, stage]));
    expect(plan.affectedPackages).toEqual(['core', 'db', 'worker', 'api', 'web']);
    expect(stages.get('typecheck')?.enabled).toBe(true);
    expect(stages.get('typecheck:scripts')?.enabled).toBe(true);
    expect(stages.get('lint:docs')?.enabled).toBe(true);
  });

  test('parses git diff --name-status -z', () => {
    const raw = [
      'M',
      'packages/api/src/index.ts',
      'D',
      'packages/web/dead.ts',
      'R100',
      'scripts/old.ts',
      'scripts/new.ts',
      '',
    ].join('\0');
    expect(parseGitDiffNameStatus(raw)).toEqual({
      changedFiles: [
        'packages/api/src/index.ts',
        'packages/web/dead.ts',
        'scripts/new.ts',
        'scripts/old.ts',
      ],
      deletedOrRenamedFiles: ['packages/web/dead.ts', 'scripts/old.ts'],
    });
  });
});

describe('planCi', () => {
  const byName = (plan: ReturnType<typeof planCi>) =>
    new Map(plan.stages.map((stage) => [stage.stage, stage]));

  test('runs full mode with openui:check --no-tests when test is scheduled', () => {
    const plan = planCi({
      options: parseCiArgs([]),
      changedFiles: [],
    });
    const stages = byName(plan);
    expect(plan.mode).toBe('full');
    expect(plan.fullRun).toBe(true);
    expect(stages.get('lint:contract:test')?.enabled).toBe(true);
    expect(stages.get('build:web')?.args).toEqual(['run', '--filter', '@agentport/web', 'build']);
    expect(stages.get('openui:check')?.args).toEqual(['run', 'openui:check', '--', '--no-tests']);
    expect(stages.get('openui:audit')?.enabled).toBe(true);
    expect(stages.get('openui:audit')?.args).toEqual(['run', 'openui:audit']);
    expect(stages.get('openui:audit')?.dependsOn).toEqual([]);
    expect(stages.get('openui:audit')?.fixHint).toBeUndefined();
    expect(stages.get('e2e')).toBeUndefined();
  });

  test('skips heavy stages in --fast mode', () => {
    const plan = planCi({
      options: parseCiArgs(['--fast', '--e2e']),
      changedFiles: [],
    });
    const stages = byName(plan);
    expect(plan.mode).toBe('fast');
    expect(stages.get('typecheck')?.enabled).toBe(true);
    expect(stages.get('typecheck:scripts')?.enabled).toBe(true);
    expect(stages.get('typecheck:e2e')?.enabled).toBe(true);
    expect(stages.get('typecheck:tests')?.enabled).toBe(true);
    expect(stages.get('lint:deadcode')?.enabled).toBe(true);
    expect(stages.get('lint:ratchet')?.enabled).toBe(true);
    expect(stages.get('openui:audit')?.enabled).toBe(true);
    expect(stages.get('openui:audit')?.dependsOn).toEqual([]);
    expect(stages.get('scripts:test')?.enabled).toBe(true);
    for (const skipped of [
      'build:web',
      'openui:check',
      'formal',
      'test',
      'test:web',
      'e2e',
    ] as const) {
      expect(stages.get(skipped)?.enabled).toBe(false);
      expect(stages.get(skipped)?.skipReason).toBe('--fast');
    }
  });

  test('skips everything when --changed detects zero files', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed', '--fast', '--e2e']),
      changedFiles: [],
    });
    expect(plan.mode).toBe('changed:fast');
    expect(plan.fullRun).toBe(false);
    expect(plan.affectedPackages).toEqual([]);
    expect(plan.stages.length).toBeGreaterThan(0);
    expect(plan.stages.every((stage) => !stage.enabled && stage.skipReason === 'no changes')).toBe(
      true,
    );
  });

  test('activates typecheck:e2e with typecheck dependency when backend package changes', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/db/src/index.ts'],
    });
    const stages = byName(plan);
    expect(stages.get('typecheck:e2e')?.enabled).toBe(true);
    expect(stages.get('typecheck:e2e')?.dependsOn).toEqual(['typecheck']);
    expect(stages.get('typecheck:tests')?.enabled).toBe(true);
    expect(stages.get('typecheck:tests')?.dependsOn).toEqual(['typecheck']);
  });

  test('activates typecheck:tests when packages/db test files change', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/db/test/runs-repo.test.ts'],
    });
    const stages = byName(plan);
    expect(stages.get('typecheck:tests')?.enabled).toBe(true);
    expect(stages.get('typecheck:tests')?.dependsOn).toEqual(['typecheck']);
  });

  test('scopes web-only change precisely', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/web/src/App.tsx'],
    });
    const stages = byName(plan);
    expect(plan.affectedPackages).toEqual(['web']);
    expect(stages.get('lint:biome')?.enabled).toBe(true);
    expect(stages.get('lint:focus')?.enabled).toBe(true);
    expect(stages.get('lint:design')?.enabled).toBe(true);
    expect(stages.get('lint:contract')?.enabled).toBe(true);
    expect(stages.get('lint:contract:test')?.enabled).toBe(false);
    expect(stages.get('lint:docs')?.enabled).toBe(false);
    expect(stages.get('typecheck')?.enabled).toBe(true);
    expect(stages.get('typecheck:tests')?.enabled).toBe(false);
    expect(stages.get('build:web')?.enabled).toBe(true);
    expect(stages.get('test:web')?.enabled).toBe(true);
    expect(stages.get('test')?.enabled).toBe(false);
    expect(stages.get('openui:check')?.enabled).toBe(false);
    expect(stages.get('openui:audit')?.enabled).toBe(false);
    expect(stages.get('formal')?.enabled).toBe(false);
  });

  test('runs openui:check with tests when backend test stage is disabled', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/web/src/openui/library.tsx'],
    });
    const stages = byName(plan);
    expect(stages.get('openui:check')?.enabled).toBe(true);
    expect(stages.get('openui:check')?.args).toEqual(['run', 'openui:check']);
    expect(stages.get('openui:audit')?.enabled).toBe(true);
    expect(stages.get('openui:audit')?.dependsOn).toEqual([]);
  });

  test('triggers lint:docs when files under packages/scripts/tests are deleted', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['scripts/old-helper.ts'],
      deletedOrRenamedFiles: ['scripts/old-helper.ts'],
    });
    const stages = byName(plan);
    expect(stages.get('lint:docs')?.enabled).toBe(true);
    expect(stages.get('typecheck:scripts')?.enabled).toBe(true);
    expect(stages.get('typecheck')?.enabled).toBe(false);
  });

  test('triggers full run when root config file changes', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['tsconfig.json'],
    });
    expect(plan.fullRun).toBe(true);
    expect(plan.affectedPackages).toHaveLength(8);
    expect(byName(plan).get('lint:contract:test')?.enabled).toBe(true);
  });

  test('activates openui:check and typecheck for shared/script openui triggers without build:web dependency', () => {
    const sharedPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/shared/src/openui/definitions.ts'],
    });
    expect(byName(sharedPlan).get('openui:check')?.enabled).toBe(true);

    const scriptPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['scripts/check-openui.mjs'],
    });
    const scriptStages = byName(scriptPlan);
    expect(scriptStages.get('typecheck')?.enabled).toBe(true);
    expect(scriptStages.get('openui:check')?.enabled).toBe(true);
    expect(scriptStages.get('openui:check')?.dependsOn).toEqual(['typecheck']);

    const fastScriptPlan = planCi({
      options: parseCiArgs(['--changed', '--fast']),
      changedFiles: ['scripts/check-openui.mjs'],
    });
    expect(byName(fastScriptPlan).get('typecheck')?.enabled).toBe(false);
    expect(byName(fastScriptPlan).get('openui:check')?.skipReason).toBe('--fast');
    expect(byName(fastScriptPlan).get('openui:audit')?.enabled).toBe(true);
  });

  test('activates openui:audit independently for audit script, registry, openui sources, and deleted web tests', () => {
    const auditScriptPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['scripts/audit-openui-coverage.mjs'],
    });
    const auditScriptStages = byName(auditScriptPlan);
    expect(auditScriptStages.get('openui:audit')?.enabled).toBe(true);
    expect(auditScriptStages.get('openui:audit')?.args).toEqual(['run', 'openui:audit']);
    expect(auditScriptStages.get('openui:audit')?.dependsOn).toEqual([]);
    expect(auditScriptStages.get('openui:check')?.enabled).toBe(false);
    expect(auditScriptStages.get('openui:check')?.skipReason).toBe('unchanged');
    expect(auditScriptStages.get('typecheck')?.enabled).toBe(false);
    expect(auditScriptStages.get('typecheck')?.skipReason).toBe('unchanged');

    const fastAuditScriptPlan = planCi({
      options: parseCiArgs(['--changed', '--fast']),
      changedFiles: ['scripts/audit-openui-coverage.mjs'],
    });
    expect(byName(fastAuditScriptPlan).get('openui:audit')?.enabled).toBe(true);

    const registryPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/web/test/openui-coverage-registry.json'],
    });
    const registryStages = byName(registryPlan);
    expect(registryStages.get('openui:audit')?.enabled).toBe(true);
    expect(registryStages.get('openui:audit')?.dependsOn).toEqual([]);
    expect(registryStages.get('openui:check')?.enabled).toBe(false);
    expect(registryStages.get('openui:check')?.skipReason).toBe('unchanged');

    const fastRegistryPlan = planCi({
      options: parseCiArgs(['--changed', '--fast']),
      changedFiles: ['packages/web/test/openui-coverage-registry.json'],
    });
    expect(byName(fastRegistryPlan).get('openui:audit')?.enabled).toBe(true);

    const openuiSourcePlan = planCi({
      options: parseCiArgs(['--changed', '--fast']),
      changedFiles: ['packages/web/src/openui/components/data.tsx'],
    });
    expect(byName(openuiSourcePlan).get('openui:audit')?.enabled).toBe(true);

    const deletedEvidencePlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/web/test/openui-form-fixes.test.ts'],
      deletedOrRenamedFiles: ['packages/web/test/openui-form-fixes.test.ts'],
    });
    const deletedEvidenceStages = byName(deletedEvidencePlan);
    expect(deletedEvidenceStages.get('openui:audit')?.enabled).toBe(true);
    expect(deletedEvidenceStages.get('openui:check')?.enabled).toBe(false);
    expect(deletedEvidenceStages.get('openui:check')?.skipReason).toBe('unchanged');

    const backendPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/api/src/modules/chat/router.ts'],
    });
    const backendStage = byName(backendPlan).get('openui:audit');
    expect(backendStage?.enabled).toBe(false);
    expect(backendStage?.skipReason).toBe('unchanged');
  });

  test('activates formal for worker scheduling changes', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/worker/src/scheduling/single-flight.ts'],
    });
    expect(byName(plan).get('formal')?.enabled).toBe(true);
  });

  test('activates typecheck:scripts and test for tests/support changes', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['tests/support/execution-stack.ts'],
    });
    const stages = byName(plan);
    expect(stages.get('typecheck:scripts')?.enabled).toBe(true);
    expect(stages.get('typecheck:e2e')?.enabled).toBe(true);
    expect(stages.get('test')?.enabled).toBe(true);
  });

  test('includes typecheck:e2e in e2e dependsOn and always uses @agentport/web build filter', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed', '--e2e']),
      changedFiles: ['scripts/ci.ts'],
    });
    const stages = byName(plan);
    expect(stages.get('typecheck')?.enabled).toBe(false);
    expect(stages.get('build:web')?.args).toEqual(['run', '--filter', '@agentport/web', 'build']);
    expect(stages.get('e2e')?.dependsOn).toEqual([
      'typecheck',
      'typecheck:e2e',
      'build:web',
      'openui:check',
      'openui:audit',
      'test',
      'test:web',
    ]);
  });

  test('triggers lint:deadcode, lint:ratchet, lint:lines and scripts:test appropriately', () => {
    const knipPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['knip.json'],
    });
    expect(knipPlan.fullRun).toBe(true);
    expect(knipPlan.affectedPackages).toHaveLength(8);
    expect(byName(knipPlan).get('lint:deadcode')?.enabled).toBe(true);

    const deletePlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['docs/README.md'],
      deletedOrRenamedFiles: ['packages/core/src/dead.ts'],
    });
    expect(byName(deletePlan).get('lint:deadcode')?.enabled).toBe(true);

    const pkgJsonPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['packages/web/package.json'],
    });
    expect(byName(pkgJsonPlan).get('lint:deadcode')?.enabled).toBe(true);

    const ratchetPlan = planCi({
      options: parseCiArgs(['--changed', '--fast']),
      changedFiles: ['scripts/baselines/suppressions.json'],
    });
    const ratchetStages = byName(ratchetPlan);
    expect(ratchetStages.get('lint:ratchet')?.enabled).toBe(true);
    expect(ratchetStages.get('lint:ratchet')?.fixHint).toBe('bun run ratchet:tighten');
    expect(ratchetStages.get('scripts:test')?.enabled).toBe(true);
    expect(ratchetStages.get('scripts:test')?.args).toEqual([
      'test',
      '--cwd',
      'scripts',
      './ci-planner.test.ts',
      './check-ratchets.test.ts',
      './check-dist-fresh.test.ts',
      './check-db-migrations.test.ts',
    ]);

    const linesPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['scripts/baselines/file-lines.json'],
    });
    const linesStages = byName(linesPlan);
    expect(linesStages.get('lint:lines')?.enabled).toBe(true);
    expect(linesStages.get('lint:lines')?.fixHint).toBe('bun run ratchet:tighten');
    expect(linesStages.get('scripts:test')?.enabled).toBe(true);

    const distFreshPlan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['scripts/check-dist-fresh.ts'],
    });
    expect(byName(distFreshPlan).get('scripts:test')?.enabled).toBe(true);
  });

  test('includes audit:high only when --security is passed and keeps it enabled in --fast', () => {
    const defaultPlan = planCi({
      options: parseCiArgs([]),
      changedFiles: [],
    });
    expect(byName(defaultPlan).get('audit:high')).toBeUndefined();

    const securityFastPlan = planCi({
      options: parseCiArgs(['--security', '--fast']),
      changedFiles: [],
    });
    const auditStage = byName(securityFastPlan).get('audit:high');
    expect(auditStage).toEqual({
      stage: 'audit:high',
      args: ['run', 'audit:high'],
      enabled: true,
      skipReason: undefined,
      fixHint: 'bun audit --registry https://registry.npmjs.org',
      dependsOn: [],
    });
  });

  test('activates lint:db with typecheck prerequisite across schema, migration and script triggers', () => {
    for (const file of [
      'packages/db/src/schema/agents.ts',
      'packages/db/migrations/0109_bounded_document_titles.sql',
      'scripts/check-db-migrations.ts',
    ]) {
      const plan = planCi({
        options: parseCiArgs(['--changed', '--fast']),
        changedFiles: [file],
      });
      const stages = byName(plan);
      expect(stages.get('typecheck')?.enabled).toBe(true);
      expect(stages.get('lint:db')).toEqual({
        stage: 'lint:db',
        args: ['run', 'lint:db'],
        enabled: true,
        skipReason: undefined,
        fixHint: 'bun run db:generate',
        dependsOn: ['typecheck'],
      });
    }

    const dbScriptStages = byName(
      planCi({
        options: parseCiArgs(['--changed']),
        changedFiles: ['scripts/check-db-migrations.ts'],
      }),
    );
    expect(dbScriptStages.get('scripts:test')?.enabled).toBe(true);

    const unrelatedStages = byName(
      planCi({
        options: parseCiArgs(['--changed']),
        changedFiles: ['packages/web/src/App.tsx'],
      }),
    );
    expect(unrelatedStages.get('lint:db')?.enabled).toBe(false);
    expect(unrelatedStages.get('lint:db')?.skipReason).toBe('unchanged');
  });

  test('triggers both lint:contract and lint:contract:test for scripts/contract/ changes', () => {
    const plan = planCi({
      options: parseCiArgs(['--changed']),
      changedFiles: ['scripts/contract/rules-manifests.ts'],
    });
    const stages = byName(plan);
    expect(stages.get('lint:contract')?.enabled).toBe(true);
    expect(stages.get('lint:contract:test')?.enabled).toBe(true);
  });
});
