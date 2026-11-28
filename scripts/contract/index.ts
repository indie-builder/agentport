import { createContractContext, type RuleModule } from './context.js';
import { apiRulesModule } from './rules-api.js';
import { boundariesRulesModule } from './rules-boundaries.js';
import { dbRulesModule } from './rules-db.js';
import { manifestsRulesModule } from './rules-manifests.js';
import { webRulesModule } from './rules-web.js';
import { workerRulesModule } from './rules-worker.js';

const RULE_MODULES: readonly RuleModule[] = [
  webRulesModule,
  boundariesRulesModule,
  apiRulesModule,
  dbRulesModule,
  workerRulesModule,
  manifestsRulesModule,
];

export const CONTRACT_RULE_IDS: readonly string[] = RULE_MODULES.flatMap((mod) => mod.rules).sort();

const CONTRACT_RULE_SET = new Set<string>(CONTRACT_RULE_IDS);

export type ContractCheckOptions = {
  root?: string;
  rules?: readonly string[];
};

export function runContractCheck(options: ContractCheckOptions = {}): string[] {
  const root = options.root ?? process.cwd();
  const requested = options.rules;
  if (requested) {
    for (const rule of requested) {
      if (!CONTRACT_RULE_SET.has(rule)) {
        throw new Error(`未知契约规则 ID: ${rule}`);
      }
    }
  }
  const activeRules = requested && requested.length > 0 ? new Set(requested) : null;
  const ctx = createContractContext(root, activeRules);
  for (const mod of RULE_MODULES) {
    if (!activeRules || mod.rules.some((rule) => activeRules.has(rule))) {
      mod.run(ctx);
    }
  }
  return ctx.problems;
}

type ParsedCliArgs =
  | { ok: true; listRules: boolean; rules: string[] }
  | { ok: false; error: string };

function parseRuleList(raw: string): { ok: true; ids: string[] } | { ok: false; error: string } {
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === '')) {
    return { ok: false, error: `无效的 --rule 参数值: ${JSON.stringify(raw)}` };
  }
  for (const id of parts) {
    if (!CONTRACT_RULE_SET.has(id)) {
      return { ok: false, error: `未知契约规则 ID: ${id}（使用 --list-rules 查看全部规则）` };
    }
  }
  return { ok: true, ids: parts };
}

function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let listRules = false;
  const rules: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--list-rules') {
      listRules = true;
      continue;
    }
    if (arg === '--rule') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, error: '--rule 缺少规则 ID 参数' };
      }
      i += 1;
      const parsed = parseRuleList(value);
      if (!parsed.ok) return parsed;
      rules.push(...parsed.ids);
      continue;
    }
    if (arg.startsWith('--rule=')) {
      const parsed = parseRuleList(arg.slice('--rule='.length));
      if (!parsed.ok) return parsed;
      rules.push(...parsed.ids);
      continue;
    }
    return { ok: false, error: `未知参数: ${arg}` };
  }

  return { ok: true, listRules, rules };
}

export function runContractCli(argv: readonly string[]): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  if (parsed.listRules) {
    console.log(CONTRACT_RULE_IDS.join('\n'));
    return 0;
  }
  const problems = runContractCheck(
    parsed.rules.length > 0
      ? { root: process.cwd(), rules: parsed.rules }
      : { root: process.cwd() },
  );
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  console.log('project contract OK');
  return 0;
}
