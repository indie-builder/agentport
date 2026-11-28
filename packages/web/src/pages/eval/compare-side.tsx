import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock } from '../../components/code-block.js';
import { StatusBadge } from '../../components/status-badge.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible.js';
import type { EvalResult } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';

export function CompareSide({
  title,
  result,
  showPass,
  defaultInputsOpen = false,
}: {
  title: string;
  result: EvalResult | null;
  showPass: boolean;
  defaultInputsOpen?: boolean;
}) {
  const [inputsOpen, setInputsOpen] = useState(defaultInputsOpen);

  return (
    <div className="min-w-0">
      <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-fg">{title}</span>
        {showPass && result ? (
          <StatusBadge tone={result.passed ? 'success' : 'danger'}>
            {result.passed ? '通过' : '未通过'}
          </StatusBadge>
        ) : null}
      </div>
      {result ? (
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <div className="text-xs text-muted-foreground">实际输出</div>
            <CodeBlock
              code={result.output || '（空）'}
              maxHeight="10rem"
              className="mt-1"
              copyLabel={`复制${title}输出`}
            />
          </div>
          {result.judgeReason ? (
            <div>
              <div className="text-xs text-muted-foreground">评判理由</div>
              <p
                className={cn(
                  'mt-0.5 whitespace-pre-wrap break-words text-xs',
                  result.passed ? 'text-muted-foreground' : 'text-danger',
                )}
              >
                {result.judgeReason}
              </p>
            </div>
          ) : null}
          <Collapsible open={inputsOpen} onOpenChange={setInputsOpen}>
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'transition-transform duration-150',
                  inputsOpen ? 'rotate-0' : '-rotate-90',
                )}
              />
              查看输入与期望
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1.5 flex flex-col gap-2 rounded-lg bg-sunken p-2.5 text-xs">
                <div>
                  <div className="text-muted-foreground">Prompt</div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">{result.prompt}</p>
                </div>
                <div>
                  <div className="text-muted-foreground">期望</div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">
                    {result.expectation || '（只要求有文本输出）'}
                  </p>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          这次运行没有记录结果，可能未执行或用例不在批次中。
        </p>
      )}
    </div>
  );
}
