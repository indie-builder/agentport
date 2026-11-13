import type { ProgressTodo } from '@agentport/shared';
import { Circle, CircleCheck, ListChecks, LoaderCircle } from 'lucide-react';
import { memo } from 'react';
import { cn } from '../../../lib/cn.js';

/** 本轮任务清单：只呈现最后一次确认的快照，停止/失败/成功都不改写步骤状态。 */
export const TodoProgress = memo(function TodoProgress({ todos }: { todos: ProgressTodo[] }) {
  const completed = todos.filter((todo) => todo.status === 'completed').length;
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
      <ul aria-label="任务清单" className="flex flex-col gap-1">
        {todos.map((todo, index) => {
          const status =
            todo.status === 'completed'
              ? '已完成'
              : todo.status === 'in_progress'
                ? '进行中'
                : '待处理';
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 清单没有稳定 id，位置即身份
              key={index}
              className="flex items-start gap-1.5 text-base"
            >
              {todo.status === 'completed' ? (
                <CircleCheck className="mt-1 size-4 shrink-0 text-success" aria-hidden="true" />
              ) : todo.status === 'in_progress' ? (
                <LoaderCircle
                  className="mt-1 size-4 shrink-0 animate-spin text-fg"
                  aria-hidden="true"
                />
              ) : (
                <Circle className="mt-1 size-4 shrink-0 text-subtle" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'min-w-0 [overflow-wrap:anywhere]',
                  todo.status === 'in_progress' ? 'text-fg' : 'text-muted-foreground',
                )}
              >
                <span className="sr-only">{status}：</span>
                {todo.status === 'in_progress' ? todo.activeForm : todo.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
