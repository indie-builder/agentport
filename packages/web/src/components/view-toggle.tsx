import { LayoutGrid, type LucideIcon, Table2 } from 'lucide-react';
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from './ui/segmented-control.js';

export type ListView = 'table' | 'cards';

const VIEWS: ReadonlyArray<{ value: ListView; label: string; icon: LucideIcon }> = [
  { value: 'cards', label: '卡片', icon: LayoutGrid },
  { value: 'table', label: '表格', icon: Table2 },
];

export function SegmentedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: LucideIcon }[];
  onChange: (value: T) => void;
}) {
  return (
    <SegmentedControl<T>
      aria-label={label}
      value={value}
      onValueChange={(next, details) => {
        details.cancel();
        if (next !== null && next !== value) onChange(next);
      }}
    >
      <SegmentedControlIndicator />
      {options.map((option) => (
        <SegmentedControlItem key={option.value} value={option.value}>
          {option.icon ? <option.icon aria-hidden="true" /> : null}
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

export function ViewToggle({
  value,
  onChange,
}: {
  value: ListView;
  onChange: (value: ListView) => void;
}) {
  return <SegmentedToggle label="切换视图" value={value} options={VIEWS} onChange={onChange} />;
}
