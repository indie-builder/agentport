import { z } from 'zod';
/** 智能体可配置的权限模式，与 Agent SDK 的 PermissionMode 对齐。 */
export declare const permissionModeSchema: z.ZodEnum<{
    acceptEdits: "acceptEdits";
    auto: "auto";
    default: "default";
    dontAsk: "dontAsk";
    plan: "plan";
}>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
/** 内置工具列表，前端用来渲染「允许/禁止」开关。 */
export declare const BUILTIN_TOOLS: readonly ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'TaskStop'];
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
export declare const agentInputSchema: z.ZodObject<{
    slug: z.ZodString;
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    model: z.ZodDefault<z.ZodString>;
    systemPrompt: z.ZodDefault<z.ZodString>;
    serverIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    skillIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    subAgentIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    disallowedTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    permissionMode: z.ZodDefault<z.ZodEnum<{
        acceptEdits: "acceptEdits";
        auto: "auto";
        default: "default";
        dontAsk: "dontAsk";
        plan: "plan";
    }>>;
    maxTurns: z.ZodDefault<z.ZodNumber>;
    maxBudgetUsd: z.ZodDefault<z.ZodNumber>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    effort: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        max: "max";
        medium: "medium";
        xhigh: "xhigh";
    }>>;
    maxThinkingTokens: z.ZodOptional<z.ZodNumber>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type AgentInput = z.infer<typeof agentInputSchema>;
export declare const agentSchema: z.ZodIntersection<z.ZodObject<{
    slug: z.ZodString;
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    model: z.ZodDefault<z.ZodString>;
    systemPrompt: z.ZodDefault<z.ZodString>;
    serverIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    skillIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    subAgentIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    disallowedTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    permissionMode: z.ZodDefault<z.ZodEnum<{
        acceptEdits: "acceptEdits";
        auto: "auto";
        default: "default";
        dontAsk: "dontAsk";
        plan: "plan";
    }>>;
    maxTurns: z.ZodDefault<z.ZodNumber>;
    maxBudgetUsd: z.ZodDefault<z.ZodNumber>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    effort: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        max: "max";
        medium: "medium";
        xhigh: "xhigh";
    }>>;
    maxThinkingTokens: z.ZodOptional<z.ZodNumber>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    parentId: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>>;
export type Agent = z.infer<typeof agentSchema>;
/** 技能：可复用的操作流程，渲染为 .claude/skills/<slug>/SKILL.md。 */
export declare const skillInputSchema: z.ZodObject<{
    slug: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    body: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type SkillInput = z.infer<typeof skillInputSchema>;
export declare const skillSchema: z.ZodIntersection<z.ZodObject<{
    slug: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    body: z.ZodDefault<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>>;
export type Skill = z.infer<typeof skillSchema>;
/** 技能列表项：附带引用它的智能体数量，用于「被 N 个智能体使用」。 */
export declare const skillWithAgentCountSchema: z.ZodIntersection<z.ZodIntersection<z.ZodObject<{
    slug: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    body: z.ZodDefault<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>>, z.ZodObject<{
    agentCount: z.ZodNumber;
}, z.core.$strip>>;
export type SkillWithAgentCount = z.infer<typeof skillWithAgentCountSchema>;
/** 工作区文件预览：前端「文件」tab 用。 */
export declare const workspaceFilesSchema: z.ZodObject<{
    mcpJson: z.ZodString;
    claudeMd: z.ZodString;
    agentMd: z.ZodString;
    skills: z.ZodDefault<z.ZodArray<z.ZodObject<{
        slug: z.ZodString;
        content: z.ZodString;
    }, z.core.$strip>>>;
    subAgents: z.ZodDefault<z.ZodArray<z.ZodObject<{
        slug: z.ZodString;
        content: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type WorkspaceFiles = z.infer<typeof workspaceFilesSchema>;
//# sourceMappingURL=agent.d.ts.map