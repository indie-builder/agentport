import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';

type FilterOption = { value: string; label: string };

/** 工具栏筛选下拉：固定 Select 复合结构，调用方只给值、选项、标签和宽度。 */
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
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      items={options}
    >
      <SelectTrigger aria-label={label} className={className}>
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
