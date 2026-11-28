import type { ContractContext, RuleModule } from './context.js';

const DB_RULES = ['db-no-process-env', 'db-like-call', 'db-like-sql', 'db-enum-check'] as const;

const likeFix = '改用 packages/db/src/repo/like.ts 的 ilikeContains / likePrefix / containsPattern';
const likeCallRe = /\b(?:i?like)\s*\(/g;
const DB_ENUM_CHECK_ALLOWLIST = new Set([
  'packages/db/src/schema/chat.ts:channel_wakes_status_check',
  'packages/db/src/schema/governance.ts:budget_limits_scope_metric_check',
  'packages/db/src/schema/integrations.ts:webhook_deliveries_status_check',
  'packages/db/src/schema/knowledge-bases.ts:knowledge_model_profiles_dimensions_check',
  'packages/db/src/schema/knowledge-documents.ts:knowledge_document_tags_origin_check',
]);

function findSqlLikeViolations(ctx: ContractContext, src: string): number[] {
  const lines: number[] = [];
  const startRe = /(?<![\w$.])sql\s*`/g;
  for (const m of src.matchAll(startRe)) {
    if (m.index === undefined) continue;
    const tpl = ctx.scanTemplateLiteral(src, m.index + m[0].length - 1);
    if (
      tpl.expressions.length > 0 &&
      /\b(?:i?like)\b/i.test(tpl.staticText) &&
      !/\b(?:containsPattern|prefixPattern|escapeLike)\b/.test(tpl.exprText)
    ) {
      lines.push(ctx.lineAt(src, m.index));
    }
  }
  return lines;
}

export const dbRulesModule: RuleModule = {
  rules: DB_RULES,
  run(ctx) {
    if (ctx.hasRule('db-no-process-env')) {
      ctx.checkEnvAccess(ctx.dbFiles, null, (displayPath, line, source) =>
        ctx.report(
          'db-no-process-env',
          `${displayPath}:${line}: db 模块禁止直接访问 ${source}.env（连接串等配置由调用方经 createDb 或参数传入）`,
        ),
      );
    }

    if (ctx.hasAnyRule(['db-like-call', 'db-like-sql'])) {
      for (const file of ctx.dbFiles) {
        const displayPath = ctx.rel(file);
        if (displayPath === 'packages/db/src/repo/like.ts') continue;
        const src = ctx.read(file);
        if (ctx.hasRule('db-like-call')) {
          for (const m of src.matchAll(likeCallRe)) {
            if (m.index !== undefined) {
              ctx.report(
                'db-like-call',
                `${displayPath}:${ctx.lineAt(src, m.index)}: 直接调用 ${m[0].replace(/\($/, '')}（${likeFix}）`,
              );
            }
          }
        }
        if (ctx.hasRule('db-like-sql')) {
          for (const line of findSqlLikeViolations(ctx, src)) {
            ctx.report(
              'db-like-sql',
              `${displayPath}:${line}: sql 模板中未转义的 LIKE/ILIKE（${likeFix}）`,
            );
          }
        }
      }
    }

    if (ctx.hasRule('db-enum-check')) {
      for (const file of ctx.dbSchemaFiles) {
        const displayPath = ctx.rel(file);
        const code = ctx.readStripped(file);
        for (const m of code.matchAll(/\bcheck\s*\(\s*(['"])([^'"]+)\1\s*,/g)) {
          const checkName = m[2];
          if (!checkName || m.index === undefined) continue;
          const callEnd = ctx.skipBalancedParens(code, m.index + m[0].indexOf('(') + 1);
          const callBody = code.slice(m.index, callEnd);
          const sqlMatch = callBody.match(/(?<![\w$.])sql\s*`/);
          if (!sqlMatch || sqlMatch.index === undefined) continue;
          const tpl = ctx.scanTemplateLiteral(callBody, sqlMatch.index + sqlMatch[0].length - 1);
          const hasInCheck = /\bin\s*\(/i.test(tpl.staticText);
          const hasArraySubsetCheck = /<@\s*array\s*\[/i.test(tpl.staticText);
          if (!hasInCheck && !hasArraySubsetCheck) continue;
          const hasHardcodedList =
            /\bin\s*\([^)]*'/i.test(tpl.staticText) ||
            /<@\s*array\s*\[[^\]]*'/i.test(tpl.staticText);
          const derivesFromOptions = /\.options\b/.test(tpl.exprText);
          if (hasHardcodedList || !derivesFromOptions) {
            const key = `${displayPath}:${checkName}`;
            if (!DB_ENUM_CHECK_ALLOWLIST.has(key)) {
              ctx.report(
                'db-enum-check',
                `${displayPath}:${ctx.lineAt(code, m.index)}: DB check '${checkName}' 未从 @agentport/shared 的 *.options 派生（改用 \${schema}.options 派生枚举，或确认属 DB 内部约束后加入 DB_ENUM_CHECK_ALLOWLIST）`,
              );
            }
          }
        }
      }
    }
  },
};
