import type { GovernanceIdentity } from '@agentport/shared';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { StatusBadge } from '../../components/status-badge.js';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '../../components/ui/combobox.js';
import { FieldError } from '../../components/ui/field.js';
import { errorMessage } from '../../lib/api.js';
import { useGovernanceIdentities } from '../../lib/queries.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';

function formatAccountLabel(
  account: Pick<GovernanceIdentity, 'name' | 'businessId' | 'accountActive'>,
): string {
  return `${account.name}（${account.businessId}）${account.accountActive ? '' : ' · 非活跃'}`;
}

export function AccountCombobox({
  id,
  value,
  onChange,
  label,
  valueLabel,
  placeholder = '搜索姓名或业务 ID…',
  disabled = false,
  activeOnly = false,
  excludeBusinessIds = [],
  inputRef,
  onBlur,
  invalid = false,
  describedBy,
}: {
  id?: string | undefined;
  value: string;
  onChange: (businessId: string, account: GovernanceIdentity | null) => void;
  label: string;
  valueLabel?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  activeOnly?: boolean | undefined;
  excludeBusinessIds?: readonly string[] | undefined;
  inputRef?: ComponentProps<typeof ComboboxInput>['ref'];
  onBlur?: (() => void) | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const settled = useDebouncedValue(searchQuery.trim(), 300);
  const accounts = useGovernanceIdentities(settled, !disabled);
  const knownAccounts = useRef(new Map<string, GovernanceIdentity>());
  const knownLabels = useRef(new Map<string, string>());

  for (const account of accounts.data ?? []) {
    knownAccounts.current.set(account.businessId, account);
    knownLabels.current.set(account.businessId, formatAccountLabel(account));
  }
  if (value.length > 0 && valueLabel && !knownLabels.current.has(value)) {
    knownLabels.current.set(value, valueLabel);
  }

  const resolvedLabel =
    value.length > 0 ? (knownLabels.current.get(value) ?? valueLabel ?? value) : '';
  const [inputQuery, setInputQuery] = useState(resolvedLabel);

  useEffect(() => {
    if (!open) {
      setInputQuery(resolvedLabel);
    }
  }, [open, resolvedLabel]);

  const excluded = new Set(excludeBusinessIds);
  const items = (accounts.data ?? []).filter(
    (account) => !excluded.has(account.businessId) && (!activeOnly || account.accountActive),
  );

  const comboboxStatus = disabled
    ? 'idle'
    : accounts.isError
      ? 'error'
      : accounts.isPending || accounts.isFetching
        ? 'loading'
        : 'idle';

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Combobox
        value={value.length > 0 ? value : null}
        open={open}
        query={inputQuery}
        disabled={disabled}
        filter={false}
        status={comboboxStatus}
        itemToLabel={(itemId) =>
          knownLabels.current.get(itemId) ?? (itemId === value && valueLabel ? valueLabel : itemId)
        }
        onQueryChange={(next, details) => {
          setInputQuery(next);
          if (details.composing) return;
          if (details.reason === 'input-change' || details.reason === 'clear-press') {
            setSearchQuery(next);
          }
        }}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setSearchQuery('');
        }}
        onValueChange={(next) => {
          const nextId = next ?? '';
          const matched =
            items.find((account) => account.businessId === nextId) ??
            knownAccounts.current.get(nextId) ??
            null;
          if (matched) {
            knownAccounts.current.set(matched.businessId, matched);
            knownLabels.current.set(matched.businessId, formatAccountLabel(matched));
          }
          onChange(nextId, matched);
        }}
        onLoadMore={() => {
          if (accounts.hasNextPage && !accounts.isFetchingNextPage) {
            void accounts.fetchNextPage();
          }
        }}
      >
        <div ref={setAnchor} className="relative flex min-w-0 items-center">
          <ComboboxInput
            {...(id === undefined ? {} : { id })}
            {...(inputRef === undefined ? {} : { ref: inputRef })}
            {...(onBlur === undefined ? {} : { onBlur })}
            {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
            aria-label={label}
            aria-invalid={invalid}
            placeholder={placeholder}
            withTrigger
          />
          <ComboboxTrigger
            variant="ghost"
            aria-label={`展开${label}列表`}
            className="absolute right-1.5"
          />
        </div>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>
            {accounts.isPending
              ? '加载中…'
              : accounts.isError
                ? errorMessage(accounts.error)
                : '没有匹配的账户'}
          </ComboboxEmpty>
          <ComboboxList>
            {items.map((account) => (
              <ComboboxItem
                key={account.businessId}
                value={account.businessId}
                label={formatAccountLabel(account)}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-fg">
                    {account.name}
                  </span>
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {account.businessId}
                  </span>
                  {account.accountActive ? null : <StatusBadge>停用</StatusBadge>}
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {accounts.isError ? <FieldError>{errorMessage(accounts.error)}</FieldError> : null}
    </div>
  );
}
