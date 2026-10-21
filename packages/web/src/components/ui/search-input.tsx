import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { Button } from './button.js';
import { Input } from './input.js';

/**
 * 项目自定义层：带图标与清除按钮的搜索框。
 * 独立于底座文件，底座重装不受影响。
 */
export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
      <Input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-icon pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="清除搜索"
          className="absolute right-1.5 top-1/2 z-10 size-auto -translate-y-1/2 rounded p-1 text-subtle hover:bg-transparent hover:text-fg"
          onClick={() => onChange('')}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
