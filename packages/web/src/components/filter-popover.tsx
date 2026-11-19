import { ListFilter } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export function FilterPopover({
  label = '筛选',
  activeCount = 0,
  children,
}: {
  label?: string;
  activeCount?: number;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" aria-label={label}>
            <ListFilter data-icon="inline-start" aria-hidden="true" />
            {label}
            {activeCount > 0 ? (
              <span className="text-muted-foreground tabular-nums">{`· ${activeCount}`}</span>
            ) : null}
          </Button>
        }
      />
      <PopoverContent align="start">{children}</PopoverContent>
    </Popover>
  );
}
