import { Search, X } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from './ui/input-group.js';

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  label,
  className,
  inputId,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
  inputId?: string;
  maxLength?: number;
}) {
  return (
    <InputGroup className={className}>
      <InputGroupInput
        id={inputId}
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className="[&::-webkit-search-cancel-button]:hidden"
      />
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      {value ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={`清除：${label}`}
            onClick={() => onChange('')}
          >
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
