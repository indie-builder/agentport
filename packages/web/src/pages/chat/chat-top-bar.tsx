import type { AgentSummary } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import {
  GitBranch,
  MoreHorizontal,
  PanelLeftDashed,
  PanelRightDashed,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { type RefObject, useRef } from 'react';
import { AgentPicker } from '../../components/agent/agent-picker.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { can } from '../../lib/access.js';
import { meQuery } from '../../lib/queries.js';

export function ChatTopBar({
  title,
  conversationId,
  deleting,
  agent,
  agentOptions,
  showAgentPicker,
  onSwitchAgent,
  historyVisible,
  historyPanelId,
  onToggleHistory,
  onOpenSearch,
  workspaceOpen,
  workspacePanelId,
  onToggleWorkspace,
  workspaceToggleRef,
  onRename,
  onFork,
  onDelete,
}: {
  title: string;
  conversationId: string | null;
  deleting: boolean;
  agent: AgentSummary | null;
  agentOptions: Array<{ value: string; label: string; agent?: AgentSummary }>;
  showAgentPicker: boolean;
  onSwitchAgent: (id: string | null) => void;
  historyVisible: boolean;
  historyPanelId: string;
  onToggleHistory: () => void;
  onOpenSearch: (trigger: HTMLElement) => void;
  workspaceOpen: boolean;
  workspacePanelId: string;
  onToggleWorkspace: () => void;
  workspaceToggleRef: RefObject<HTMLButtonElement | null>;
  onRename: (trigger: HTMLElement) => void;
  onFork: () => void;
  onDelete: (trigger: HTMLElement) => void;
}) {
  const headerTriggerRef = useRef<HTMLButtonElement>(null);
  const me = useQuery(meQuery);
  const canUpdate = can(me.data, 'conversations.update');
  const canDelete = can(me.data, 'conversations.delete');
  const canCreate = can(me.data, 'conversations.create');
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 px-6">
      <Button
        variant="ghost"
        size="icon"
        aria-label={historyVisible ? '隐藏会话历史' : '显示会话历史'}
        title={historyVisible ? '隐藏会话历史' : '显示会话历史'}
        aria-expanded={historyVisible}
        aria-controls={historyPanelId}
        onClick={onToggleHistory}
        className="shrink-0 text-muted-foreground hover:text-fg"
      >
        <PanelLeftDashed />
      </Button>
      {historyVisible ? null : (
        <Button
          variant="ghost"
          size="icon"
          aria-label="搜索会话"
          title="搜索会话"
          onClick={(event) => onOpenSearch(event.currentTarget)}
          className="shrink-0 text-muted-foreground hover:text-fg"
        >
          <Search />
        </Button>
      )}
      {showAgentPicker ? (
        <div className="min-w-0 shrink basis-44">
          <AgentPicker
            agent={agent?.isDefault ? null : agent}
            agentId={agent?.id ?? null}
            agentOptions={agentOptions}
            onSwitchAgent={onSwitchAgent}
            placeholder="通用助手"
            triggerAriaLabel={agent && !agent.isDefault ? `切换专家：${agent.name}` : '召唤专家'}
            disabled={agentOptions.length === 0}
          />
        </div>
      ) : null}
      {showAgentPicker && agent && !agent.isDefault ? (
        <Button
          variant="ghost"
          aria-label="移除专家，回到通用助手"
          onClick={() => onSwitchAgent(null)}
        >
          移除专家
        </Button>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h1
          title={title}
          className="min-w-0 truncate text-base font-medium tracking-[-0.01em] text-fg"
        >
          {title}
        </h1>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                ref={headerTriggerRef}
                variant="ghost"
                size="icon"
                aria-label="会话操作"
                title={conversationId ? '会话操作' : '先发送消息，保存会话后可操作'}
                disabled={!conversationId || deleting}
                className="shrink-0 text-muted-foreground hover:text-fg"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" sideOffset={4} className="w-40">
            <DropdownMenuGroup>
              {canUpdate ? (
                <DropdownMenuItem
                  disabled={deleting}
                  onSelect={() => {
                    const trigger = headerTriggerRef.current;
                    if (trigger) onRename(trigger);
                  }}
                >
                  <Pencil /> 重命名
                </DropdownMenuItem>
              ) : null}
              {canCreate ? (
                <DropdownMenuItem disabled={deleting} onSelect={onFork}>
                  <GitBranch /> Fork 会话
                </DropdownMenuItem>
              ) : null}
              {canDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={deleting}
                  onSelect={() => {
                    const trigger = headerTriggerRef.current;
                    if (trigger) onDelete(trigger);
                  }}
                >
                  <Trash2 /> 删除会话
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button
        ref={workspaceToggleRef}
        variant="ghost"
        size="icon"
        aria-label={workspaceOpen ? '隐藏会话成果' : '打开会话成果'}
        title={workspaceOpen ? '隐藏会话成果' : '打开会话成果'}
        aria-expanded={workspaceOpen}
        aria-controls={workspacePanelId}
        onClick={onToggleWorkspace}
        className="shrink-0 gap-1.5 text-muted-foreground hover:text-fg lg:w-auto lg:px-2"
      >
        <PanelRightDashed />
        <span className="hidden text-sm lg:inline">会话成果</span>
      </Button>
    </div>
  );
}
