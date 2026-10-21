import { Check, ChevronDown } from 'lucide-react';
import * as SelectPrimitive from 'radix-ui/select';
import { cn } from '../../lib/cn.js';

/**
 * shadcn/ui Select 的外壳。
 *
 * 保留原生 <select> 的调用签名会失去一致的视觉与键盘行为（原生下拉在
 * 不同平台渲染完全不同）。这里换成 Radix，并把 API 收敛成声明式选项。
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  'aria-label'?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = '请选择',
  className,
  disabled,
  id,
  'aria-label': ariaLabel,
}: SelectProps) {
  // Radix 把 '' 当作「未选中」；「全部状态」这类空值选项需要一个真实值。
  const EMPTY = '__empty__';
  const toRadix = (v: string): string => (v === '' ? EMPTY : v);
  const fromRadix = (v: string): string => (v === EMPTY ? '' : v);
  return (
    <SelectPrimitive.Root
      value={toRadix(value)}
      onValueChange={(next) => onValueChange(fromRadix(next))}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-icon border border-line bg-surface px-2.5 text-sm text-fg transition-colors hover:border-line-strong focus-visible:border-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/30 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-subtle',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-3.5 shrink-0 text-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-icon border border-line bg-surface shadow-overlay"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={toRadix(option.value)}
                disabled={option.disabled ?? false}
                className="relative flex cursor-pointer select-none items-center rounded-icon py-1.5 pl-7 pr-2 text-base text-fg outline-none data-[disabled]:pointer-events-none data-[disabled]:text-subtle data-[highlighted]:bg-sunken"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5 text-fg" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
