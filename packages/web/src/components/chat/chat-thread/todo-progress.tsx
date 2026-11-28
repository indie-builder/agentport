import type { ProgressTodo } from '@agentport/shared';
import { Circle, CircleCheck, ListChecks, LoaderCircle } from 'lucide-react';
import { memo } from 'react';
import { cn } from '../../../lib/cn.js';
import { Timeline, TimelineItem, TimelineMarker, TimelineTitle } from '../../ui/timeline.js';

export const TodoProgress = memo(function TodoProgress({ todos }: { todos: ProgressTodo[] }) {
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const seen = new Map<string, number>();
  const entries = todos.map((todo) => {
    const base = `${todo.status}:${todo.content}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { todo, key: count === 1 ? base : `${base}-${count}` };
  });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono text-xs tabular-nums text-fg" aria-hidden="true">
          {completed}/{todos.length}
        </span>
        <span className="sr-only">
          已完成 {completed} 项，共 {todos.length} 项
        </span>
      </div>
      <Timeline aria-label="任务清单" className="gap-1">
        {entries.map(({ todo, key }) => {
          const status =
            todo.status === 'completed'
              ? '已完成'
              : todo.status === 'in_progress'
                ? '进行中'
                : '待处理';
          const timelineStatus =
            todo.status === 'completed'
              ? 'complete'
              : todo.status === 'in_progress'
                ? 'current'
                : 'upcoming';
          return (
            <TimelineItem
              key={key}
              status={timelineStatus}
              className="grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 pb-0 text-base"
            >
              <TimelineMarker className="mt-1 size-4 not-empty:bg-transparent not-empty:data-complete:bg-transparent not-empty:data-current:bg-transparent">
                {todo.status === 'completed' ? (
                  <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
                ) : todo.status === 'in_progress' ? (
                  <LoaderCircle
                    className="size-4 shrink-0 animate-spin text-fg"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle className="size-4 shrink-0 text-subtle" aria-hidden="true" />
                )}
              </TimelineMarker>
              <TimelineTitle
                className={cn(
                  'min-w-0 text-base font-normal [overflow-wrap:anywhere]',
                  todo.status === 'in_progress' ? 'text-fg' : 'text-muted-foreground',
                )}
              >
                <span className="sr-only">{status}：</span>
                {todo.status === 'in_progress' ? todo.activeForm : todo.content}
              </TimelineTitle>
            </TimelineItem>
          );
        })}
      </Timeline>
    </div>
  );
});
