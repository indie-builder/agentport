import { renderWorkspace, type WorkspaceFiles } from '@agentport/core/workspace';
import {
  type AgentInput,
  knowledgeMcpEntry,
  type McpJsonArtifactEntry,
  type Server,
} from '@agentport/shared';
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

function previewEntry(server: Server): McpJsonArtifactEntry {
  if (server.kind === 'knowledge' || server.kind === 'data_domain') {
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
