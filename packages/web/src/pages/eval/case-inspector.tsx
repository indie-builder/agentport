import { Pencil, Trash2 } from 'lucide-react';
import { StatusBadge } from '../../components/status-badge.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import type { EvalCase } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';

export function CaseInspector({
  testCase,
  canManage,
  onEdit,
  onDelete,
}: {
  testCase: EvalCase | null;
  canManage: boolean;
  onEdit: (testCase: EvalCase, trigger: HTMLElement) => void;
  onDelete: (testCase: EvalCase, trigger: HTMLElement) => void;
}) {
  if (!testCase) {
    return (
      <aside className="min-w-0 rounded-xl border bg-surface p-4 text-sm text-muted-foreground xl:sticky xl:top-0">
        选择左侧用例查看详情
      </aside>
    );
  }

  const expectationLabel = testCase.judgeMode === 'llm' ? '评判标准' : '期望包含';

  return (
    <aside className="min-w-0 rounded-xl border bg-surface p-4 xl:sticky xl:top-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="min-w-0 break-words text-base font-medium text-fg">{testCase.name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="default">
              {testCase.judgeMode === 'llm' ? 'LLM 评判' : '包含匹配'}
            </StatusBadge>
            <span className="text-xs text-muted-foreground">
              创建于 {formatDateTime(testCase.createdAt)}
            </span>
          </div>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              aria-label={`编辑 ${testCase.name}`}
              onClick={(event) => onEdit(testCase, event.currentTarget)}
            >
              <Pencil data-icon="inline-start" aria-hidden="true" />
              编辑
            </Button>
            <Button
              variant="destructive"
              size="sm"
              aria-label={`删除 ${testCase.name}`}
              onClick={(event) => onDelete(testCase, event.currentTarget)}
            >
              <Trash2 data-icon="inline-start" aria-hidden="true" />
              删除
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-col gap-4 border-t pt-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Prompt</div>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-sunken p-3 text-fg">
            {testCase.prompt}
          </p>
        </div>

        <div>
          <div className="text-xs text-muted-foreground">{expectationLabel}</div>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-sunken p-3 text-fg">
            {testCase.expectation ||
              (testCase.judgeMode === 'llm'
                ? '评判标准为空：仅要求有实质文本输出'
                : '期望为空：只要求有文本输出')}
          </p>
        </div>

        {testCase.expectedTools && testCase.expectedTools.length > 0 ? (
          <div>
            <div className="text-xs text-muted-foreground">预期调用工具</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {testCase.expectedTools.map((tool) => (
                <Badge key={tool} variant="secondary" className="font-mono">
                  {tool}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {testCase.forbiddenTools && testCase.forbiddenTools.length > 0 ? (
          <div>
            <div className="text-xs text-muted-foreground">禁止调用工具</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {testCase.forbiddenTools.map((tool) => (
                <Badge key={tool} variant="destructive" className="font-mono">
                  {tool}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
