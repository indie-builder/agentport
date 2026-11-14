import { Bot } from 'lucide-react';
import { type FocusEventHandler, type Ref, useRef, useState } from 'react';
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
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const shouldRestoreFocus = useRef(false);
  const items = agentOptions.map((option) => ({ value: option, label: option.label }));
  const selectedLabel = agentOptions.find((option) => option.value === agentId)?.label;
  return (
    <Combobox
      disabled={disabled ?? false}
      items={items}
      value={agentOptions.find((option) => option.value === agentId) ?? null}
      onValueChange={(next) => {
        if (next) onSwitchAgent(next.value);
      }}
      query={query}
      onQueryChange={setQuery}
      onOpenChange={(open, details) => {
        shouldRestoreFocus.current =
          !open && (details.reason === 'item-press' || details.reason === 'escape-key');
        if (open) setQuery('');
      }}
      onOpenChangeComplete={(open) => {
        if (!open && shouldRestoreFocus.current) button?.focus();
      }}
      itemToLabel={(option) => option.label}
      itemToValue={(option) => option.value}
      isItemEqualToValue={(a, b) => a.value === b.value}
      filter={({ value: option }, query) => {
        const needle = query.trim().toLowerCase();
        return `${option.label} ${option.agent?.role ?? ''} ${option.agent?.slug ?? ''}`
          .toLowerCase()
          .includes(needle);
      }}
    >
      {triggerVariant === 'field' ? (
        <ComboboxTrigger
          ref={setButton}
          render={
            <Button
              variant="plain"
              {...(triggerRef === undefined ? {} : { ref: triggerRef })}
              {...(onBlur === undefined ? {} : { onBlur })}
              {...(disabled === undefined ? {} : { disabled })}
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
          ref={setButton}
          render={
            <Button
              variant="ghost"
              {...(triggerRef === undefined ? {} : { ref: triggerRef })}
              {...(onBlur === undefined ? {} : { onBlur })}
              {...(disabled === undefined ? {} : { disabled })}
              id={triggerId}
              aria-label={triggerAriaLabel ?? (agent ? `选择专家：${agent.name}` : placeholder)}
              aria-invalid={ariaInvalid}
              aria-describedby={ariaDescribedby}
              title="切换专家"
              className={cn(
                'h-8 w-full min-w-0 justify-start gap-2 px-2 font-normal',
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
          <span className="min-w-0 flex-1 truncate text-left text-sm text-fg">
            {agent?.name ?? selectedLabel ?? placeholder}
          </span>
        </ComboboxTrigger>
      )}
      <ComboboxContent anchor={button} className="min-w-64">
        <ComboboxInput
          autoFocus
          aria-label="搜索专家"
          placeholder="搜索名称、角色或 Slug…"
          className="m-1 mb-0 w-[calc(100%---spacing(2))] bg-surface"
        />
        <ComboboxEmpty>没有匹配的专家</ComboboxEmpty>
        <ComboboxList>
          {(state) =>
            (state.items as typeof items).map(({ value: option, label }) => (
              <ComboboxItem key={option.value} value={option} label={label} className="py-1.5">
                {option.agent ? (
                  <AgentAvatar agent={option.agent} className="size-6" />
                ) : (
                  <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 break-words text-sm text-fg">{label}</span>
                  <span className="min-w-0 break-words text-xs text-muted-foreground">
                    {option.agent?.role?.trim() || '通用助手'}
                  </span>
                </span>
              </ComboboxItem>
            ))
          }
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
