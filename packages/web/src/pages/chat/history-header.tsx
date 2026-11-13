import type { AgentSummary } from '@agentport/shared';
import { Plus, X } from 'lucide-react';
import { AgentPicker } from '../../components/agent/agent-picker.js';
import { Button } from '../../components/ui/button.js';

export function HistoryHeader({
  onNew,
  onClose,
  agent,
  agentId,
  agentOptions,
  onSwitchAgent,
}: {
  onNew: () => void;
  onClose?: () => void;
  agent?: AgentSummary | null;
  agentId?: string | null;
  agentOptions?: Array<{ value: string; label: string; agent?: AgentSummary }>;
  onSwitchAgent?: (id: string | null) => void;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 px-3">
      {agentOptions && onSwitchAgent ? (
        <div className="min-w-0 flex-1">
          <AgentPicker
            agent={agent?.isDefault ? null : (agent ?? null)}
            agentId={agentId ?? null}
            agentOptions={agentOptions}
            onSwitchAgent={onSwitchAgent}
            placeholder="通用助手"
            triggerAriaLabel={agent && !agent.isDefault ? `切换专家：${agent.name}` : '召唤专家'}
            disabled={agentOptions.length === 0}
          />
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {agent && !agent.isDefault && onSwitchAgent ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label="移除专家，回到通用助手"
          title="移除专家"
          onClick={() => onSwitchAgent(null)}
        >
          <X />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        aria-label="新建会话"
        title="新建会话"
        onClick={() => onNew()}
      >
        <Plus />
      </Button>
      {onClose ? (
        <Button variant="ghost" size="icon" aria-label="关闭会话列表" onClick={onClose}>
          <X className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}
