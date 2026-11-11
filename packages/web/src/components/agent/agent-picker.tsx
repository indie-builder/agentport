import { Bot } from 'lucide-react';
import type { FocusEventHandler, Ref } from 'react';
import { cn } from '../../lib/cn.js';
import { Button } from '../ui/button.js';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '../ui/combobox.js';
import { AgentAvatar, type AgentDisplay } from './agent-avatar.js';

/** 专家选择：欢迎态与历史面板共用；触发器是头像+名称+箭头的按钮，弹层内搜索。 */
export function AgentPicker({
  agent,
  agentId,
  agentOptions,
  onSwitchAgent,
  triggerVariant = 'ghost',
  placeholder = '选择专家',
  triggerClassName,
  triggerAriaLabel,
  disabled,
  triggerId,
  triggerRef,
  onBlur,
  ariaInvalid,
  ariaDescribedby,
}: {
  agent: AgentDisplay | null;
  agentId?: string | null;
  agentOptions: Array<{ value: string; label: string; agent?: AgentDisplay }>;
  onSwitchAgent: (id: string) => void;
  triggerVariant?: 'ghost' | 'field';
  placeholder?: string;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  disabled?: boolean;
  triggerId?: string;
  triggerRef?: Ref<HTMLButtonElement> | undefined;
  onBlur?: FocusEventHandler<HTMLButtonElement> | undefined;
  ariaInvalid?: boolean | undefined;
  ariaDescribedby?: string | undefined;
}) {
  const selectedLabel = agentOptions.find((option) => option.value === agentId)?.label;
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
      {triggerVariant === 'field' ? (
        <ComboboxTrigger
          render={
            <Button
              variant="plain"
              ref={triggerRef}
              onBlur={onBlur}
              disabled={disabled}
              id={triggerId}
              aria-label={triggerAriaLabel ?? placeholder}
              aria-invalid={ariaInvalid}
              aria-describedby={ariaDescribedby}
              className={cn(
                'flex w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none cds-focus-glow focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-[0.35]',
                triggerClassName,
              )}
            />
          }
        >
          {agent ? (
            <AgentAvatar agent={agent} className="size-5" />
          ) : (
            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {agent?.name ?? selectedLabel ?? placeholder}
          </span>
        </ComboboxTrigger>
      ) : (
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
      )}
      <ComboboxContent className="min-w-64">
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
