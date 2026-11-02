import { Bot } from 'lucide-react';
import { AgentAvatar } from './agent-avatar.js';
import { Button } from './ui/button.js';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from './ui/combobox.js';

type AgentPickerAgent = {
  name: string;
  description: string;
  role?: string | null;
  slug?: string | null;
};

/** 专家选择：欢迎态与历史面板共用；触发器是头像+名称+箭头的按钮，弹层内搜索。 */
export function AgentPicker({
  agent,
  agentId,
  agentOptions,
  onSwitchAgent,
}: {
  agent: AgentPickerAgent | null;
  agentId?: string | null;
  agentOptions: Array<{ value: string; label: string; agent?: AgentPickerAgent }>;
  onSwitchAgent: (id: string) => void;
}) {
  return (
    <Combobox
      items={agentOptions}
      value={agentOptions.find((option) => option.value === agentId) ?? null}
      onValueChange={(next: (typeof agentOptions)[number] | null) => {
        if (next) onSwitchAgent(next.value);
      }}
      itemToStringLabel={(option: (typeof agentOptions)[number]) => option.label}
      itemToStringValue={(option: (typeof agentOptions)[number]) => option.value}
      isItemEqualToValue={(a: (typeof agentOptions)[number], b: (typeof agentOptions)[number]) =>
        a.value === b.value
      }
      filter={(option: (typeof agentOptions)[number], query: string) => {
        const needle = query.trim().toLowerCase();
        return `${option.label} ${option.agent?.role ?? ''} ${option.agent?.slug ?? ''}`
          .toLowerCase()
          .includes(needle);
      }}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="ghost"
            aria-label={agent ? `选择专家：${agent.name}` : '选择专家'}
            title="切换专家"
            className="h-8 w-full min-w-0 justify-start gap-2 px-2 font-normal"
          />
        }
      >
        {agent ? (
          <AgentAvatar agent={agent} className="size-5" />
        ) : (
          <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-left text-sm text-fg">
          {agent?.name ?? '选择专家'}
        </span>
      </ComboboxTrigger>
      <ComboboxContent className="min-w-[16rem]">
        <ComboboxInput
          aria-label="搜索专家"
          placeholder="搜索名称、角色或 Slug…"
          showTrigger={false}
        />
        <ComboboxEmpty>没有匹配的专家</ComboboxEmpty>
        <ComboboxList>
          {(option: (typeof agentOptions)[number]) => (
            <ComboboxItem key={option.value} value={option} className="py-1.5">
              {option.agent ? (
                <AgentAvatar agent={option.agent} className="size-6" />
              ) : (
                <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="min-w-0 break-words text-sm text-fg">{option.label}</span>
                <span className="min-w-0 break-words text-xs text-muted-foreground">
                  {option.agent?.role?.trim() || '通用助手'}
                </span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
