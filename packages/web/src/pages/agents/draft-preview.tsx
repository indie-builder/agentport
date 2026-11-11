// 只引用纯函数子路径：core 根入口还导出 node:crypto 相关模块，浏览器不能加载。
import type { McpJsonEntry } from '@agentport/core/tools';
import { renderWorkspace, type WorkspaceFiles } from '@agentport/core/workspace';
import { type AgentInput, knowledgeMcpEntry, type Server } from '@agentport/shared';
import { ChevronRight } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { type Control, useWatch } from 'react-hook-form';
import { CodeBlock } from '../../components/code-block.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/motion-collapsible.js';
import { cn } from '../../lib/cn.js';
import { type AgentDraft, toolLines } from './shared.js';

type PreviewSkill = { slug: string; name: string; description: string; body: string };
type PreviewSubAgent = {
  slug: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  maxTurns: number;
  timeoutMs: number;
  permissionMode: AgentInput['permissionMode'];
  effort?: AgentInput['effort'] | null;
  allowedTools: string[];
  disallowedTools: string[];
  skills?: PreviewSkill[];
};
type DraftPreviewInput = Pick<
  AgentInput,
  | 'slug'
  | 'name'
  | 'description'
  | 'model'
  | 'systemPrompt'
  | 'maxTurns'
  | 'permissionMode'
  | 'effort'
  | 'allowedTools'
  | 'disallowedTools'
>;

const previewFieldNames = [
  'slug',
  'name',
  'description',
  'model',
  'systemPrompt',
  'maxTurns',
  'permissionMode',
  'effort',
  'allowedTools',
  'disallowedTools',
] as const;

/** 草稿预览：折叠在表单里；展开后才挂载渲染，内容随表单实时变化。 */
export function DraftPreview({
  title,
  view,
  control,
  servers,
  skills,
  subAgents,
}: {
  title: string;
  view: 'claude' | 'files';
  control: Control<AgentDraft, unknown, AgentDraft>;
  servers: Server[];
  skills: PreviewSkill[];
  subAgents: PreviewSubAgent[];
}) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();

  // Collapsible is unstyled; keep the draft border, 8px corners, and compact muted trigger.
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-item border">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-item px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out-soft',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="body"
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="border-t p-2">
                <DraftPreviewBody
                  view={view}
                  control={control}
                  servers={servers}
                  skills={skills}
                  subAgents={subAgents}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 预览正文只在展开时存在：局部订阅草稿字段，避免每次按键重算整页。 */
function DraftPreviewBody({
  view,
  control,
  servers,
  skills,
  subAgents,
}: {
  view: 'claude' | 'files';
  control: Control<AgentDraft, unknown, AgentDraft>;
  servers: Server[];
  skills: PreviewSkill[];
  subAgents: PreviewSubAgent[];
}) {
  const [
    slug,
    name,
    description,
    model,
    systemPrompt,
    maxTurns,
    permissionMode,
    effort,
    allowedTools,
    disallowedTools,
  ] = useWatch({ control, name: previewFieldNames });
  const draft = draftFiles(
    {
      slug,
      name,
      description,
      model,
      systemPrompt,
      maxTurns,
      permissionMode,
      effort,
      allowedTools: toolLines(allowedTools),
      disallowedTools,
    },
    servers,
    skills,
    subAgents,
  );
  return (
    <CodeBlock
      code={view === 'claude' ? draft.claudeMd : previewFileDraft(draft, slug)}
      maxHeight="22rem"
    />
  );
}

function previewFileDraft(draft: WorkspaceFiles, slug: string): string {
  return [
    '// .mcp.json',
    draft.mcpJson,
    `// .claude/agents/${slug || '<slug>'}.md（主智能体，仅预览）`,
    draft.agentMd,
    ...(draft.subAgents.length > 0
      ? [
          '// 子智能体文件（各用自己的配置）',
          ...draft.subAgents.map((sub) => `// .claude/agents/${sub.slug}.md`),
        ]
      : []),
  ].join('\n');
}

/**
 * 草稿预览直接调用 core 的渲染函数——不复制实现。
 *
 * 之前这里有一份「同构」副本，结果 core 新增「等待规则」与子智能体表格后
 * 副本没有跟上，预览与真实落盘内容出现差异，正好违背「配置即契约」。
 * core/workspace.ts 是纯函数、无 Node 依赖，浏览器可直接用。
 */
function draftFiles(
  draft: DraftPreviewInput,
  servers: Server[],
  skills: PreviewSkill[],
  subAgents: PreviewSubAgent[],
): WorkspaceFiles {
  return renderWorkspace({
    agent: {
      slug: draft.slug,
      name: draft.name,
      description: draft.description,
      model: draft.model,
      systemPrompt: draft.systemPrompt,
      maxTurns: draft.maxTurns,
      permissionMode: draft.permissionMode,
      effort: draft.effort ?? null,
      allowedTools: draft.allowedTools,
      disallowedTools: draft.disallowedTools,
    },
    // 预览只给键名：真实密钥永不出现在这里。
    servers: servers.map((server) => ({
      name: server.name,
      entry: previewEntry(server),
    })),
    skills,
    subAgents,
    ...(draft.allowedTools.length > 0 ? { toolsAllow: draft.allowedTools } : {}),
    ...(draft.disallowedTools.length > 0 ? { toolsDeny: draft.disallowedTools } : {}),
  });
}

/** `.mcp.json` 预览条目：密钥替换为占位符。 */
function previewEntry(server: Server): McpJsonEntry {
  if (server.kind === 'knowledge') {
    // 与运行时同一构造器：地址由平台拼，凭证按 run 注入，草稿里只留占位。
    return knowledgeMcpEntry({
      apiUrl: '<平台>',
      serverId: server.id,
      runId: '<run-id>',
      runToken: '<run-token>',
    });
  }
  if (server.kind === 'stdio') {
    return {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(Object.keys(server.env).map((key) => [key, '<已配置>'])),
    };
  }
  if (server.kind === 'http') {
    return {
      type: 'http',
      url: server.url,
      headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, '<已配置>'])),
    };
  }
  return {
    type: 'http',
    url: `<平台 /mcp/${server.id}>`,
    headers: { Authorization: '<运行时注入>' },
  };
}
