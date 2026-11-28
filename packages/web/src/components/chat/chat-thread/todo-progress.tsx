import type { ProgressTodo } from '@agentport/shared';
import { Circle, CircleCheck, ListChecks, LoaderCircle } from 'lucide-react';
import { memo } from 'react';
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
      <Timeline aria-label="任务清单" density="compact">
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
              density="flush"
              size="base"
              className="grid-cols-[auto_minmax(0,1fr)] items-start"
            >
              <TimelineMarker variant="bare" className="mt-1 size-4">
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
                size="base"
                weight="normal"
                tone={todo.status === 'in_progress' ? 'default' : 'muted'}
                className="min-w-0 [overflow-wrap:anywhere]"
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
