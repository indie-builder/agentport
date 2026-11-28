import { useOptimisticValue } from '../lib/use-optimistic-value.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';

type FilterOption = { value: string; label: string };

export function FilterSelect({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly FilterOption[];
  label: string;
  className?: string;
}) {
  const [optimisticValue, commitValue] = useOptimisticValue(value);

  return (
    <Select
      value={optimisticValue}
      onValueChange={(next) => {
        if (next !== null) commitValue(next, () => onValueChange(next));
      }}
      items={[...options]}
    >
      <SelectTrigger aria-label={label} className={className ?? ''}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
