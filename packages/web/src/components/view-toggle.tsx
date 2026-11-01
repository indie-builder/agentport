import { LayoutGrid, type LucideIcon, Table2 } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.js';

export type ListView = 'table' | 'cards';

const VIEWS: ReadonlyArray<{ value: ListView; label: string; icon: LucideIcon }> = [
  { value: 'table', label: '表格', icon: Table2 },
  { value: 'cards', label: '卡片', icon: LayoutGrid },
];

/** 列表在表格与卡片之间切换；选中状与紧凑尺寸沿用 ToggleGroup 既有语义。 */
export function ViewToggle({
  value,
  onChange,
}: {
  value: ListView;
  onChange: (value: ListView) => void;
}) {
  return (
    <ToggleGroup
      aria-label="切换视图"
      multiple={false}
      value={[value]}
      onValueChange={(values) => {
        const next = VIEWS.find((view) => view.value === values[0]);
        if (next !== undefined) onChange(next.value);
      }}
    >
      {VIEWS.map((view) => (
        <ToggleGroupItem key={view.value} value={view.value}>
          <view.icon />
          {view.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
