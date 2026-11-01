import { LayoutGrid, type LucideIcon, Table2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useId } from 'react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.js';

export type ListView = 'table' | 'cards';

const VIEWS: ReadonlyArray<{ value: ListView; label: string; icon: LucideIcon }> = [
  { value: 'table', label: '表格', icon: Table2 },
  { value: 'cards', label: '卡片', icon: LayoutGrid },
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
  const reduce = useReducedMotion();
  const thumbId = useId();
  return (
    <ToggleGroup
      aria-label={label}
      multiple={false}
      className="relative rounded-pill bg-sunken p-0.5 text-muted-foreground"
      value={[value]}
      onValueChange={(values) => {
        const next = options.find((option) => option.value === values[0]);
        if (next !== undefined) onChange(next.value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="relative isolate h-7 rounded-pill px-3 text-sm hover:bg-transparent hover:text-fg aria-pressed:bg-transparent aria-pressed:text-fg"
        >
          {value === option.value ? (
            <motion.span
              aria-hidden="true"
              layoutId={`segmented-thumb-${thumbId}`}
              transition={
                reduce
                  ? { duration: 0 }
                  : {
                      type: 'tween',
                      duration: 0.12,
                      ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
                    }
              }
              className="absolute inset-0 -z-10 rounded-pill bg-surface shadow-sm"
            />
          ) : null}
          {option.icon ? <option.icon aria-hidden="true" /> : null}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
