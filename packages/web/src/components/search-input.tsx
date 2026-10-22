import { Search, X } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from './ui/input-group.js';

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
    <InputGroup className={className}>
      <InputGroupInput
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="[&::-webkit-search-cancel-button]:hidden"
      />
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      {value ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={() => onChange('')}>
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
