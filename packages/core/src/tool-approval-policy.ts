import { canonicalJson } from './canonical-json.js';
import { sha256Hex } from './outputs.js';

export type ApprovalMode = 'allow' | 'ask' | 'deny';

export interface ApprovalRuleSelector {
  id: string;
  version: number;
  approvalMode: ApprovalMode;
  agentId: string | null;
  serverId: string | null;
  toolId: string | null;
  role: string | null;
  httpMethod: string | null;
  pathTemplate: string | null;
  enabled: boolean;
}

export interface ApprovalContext {
  agentId: string | null;
  serverId: string;
  toolId: string;
  method: string;
  pathTemplate: string;
  baseUrl: string;
  paramsIn: string;
  roles: readonly string[];
}

export interface ApprovalDecision {
  effectiveMode: ApprovalMode;
  baseline: ApprovalMode;
  matchedRules: Array<{ id: string; version: number; approvalMode: ApprovalMode }>;
  decisionHash: string;
}

const RANK: Record<ApprovalMode, number> = { allow: 0, ask: 1, deny: 2 };

function matches(rule: ApprovalRuleSelector, ctx: ApprovalContext): boolean {
  if (!rule.enabled) return false;
  if (rule.agentId !== null && rule.agentId !== ctx.agentId) return false;
  if (rule.serverId !== null && rule.serverId !== ctx.serverId) return false;
  if (rule.toolId !== null && rule.toolId !== ctx.toolId) return false;
  if (rule.role !== null && !ctx.roles.includes(rule.role)) return false;
  if (rule.httpMethod !== null && rule.httpMethod !== ctx.method) return false;
  if (rule.pathTemplate !== null && rule.pathTemplate !== ctx.pathTemplate) return false;
  return true;
}

export function evaluateToolApproval(
  baseline: ApprovalMode,
  rules: readonly ApprovalRuleSelector[],
  ctx: ApprovalContext,
): ApprovalDecision {
  const matchedRules = rules
    .filter((rule) => matches(rule, ctx))
    .map(({ id, version, approvalMode }) => ({ id, version, approvalMode }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let effectiveMode = baseline;
  for (const rule of matchedRules) {
    if (RANK[rule.approvalMode] > RANK[effectiveMode]) effectiveMode = rule.approvalMode;
  }

  const decisionHash = sha256Hex(
    canonicalJson({
      v: 1,
      serverId: ctx.serverId,
      toolId: ctx.toolId,
      method: ctx.method,
      pathTemplate: ctx.pathTemplate,
      baseUrl: ctx.baseUrl,
      paramsIn: ctx.paramsIn,
      agentId: ctx.agentId,
      roles: [...ctx.roles].sort(),
      baseline,
      effectiveMode,
      matched: matchedRules,
    }),
  );

  return { effectiveMode, baseline, matchedRules, decisionHash };
}
