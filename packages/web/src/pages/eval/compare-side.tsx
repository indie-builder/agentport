import { CodeBlock } from '../../components/code-block.js';
import { StatusBadge } from '../../components/status-badge.js';
import type { EvalResult } from '../../lib/api.js';

export function CompareSide({
  title,
  result,
  showPass,
}: {
  title: string;
  result: EvalResult | null;
  showPass: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
        {title}
        {showPass && result ? (
          <StatusBadge tone={result.passed ? 'success' : 'danger'}>
            {result.passed ? '通过' : '未通过'}
          </StatusBadge>
        ) : null}
      </div>
      {result ? (
        <>
          <div className="mt-2 text-xs text-muted-foreground">Prompt</div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
            {result.prompt}
          </p>
          <div className="mt-2 text-xs text-muted-foreground">期望</div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
            {result.expectation || '（只要求有文本输出）'}
          </p>
          <div className="mt-2 text-xs text-muted-foreground">输出</div>
          <CodeBlock
            code={result.output || '（空）'}
            maxHeight="10rem"
            className="mt-1"
            copyLabel={`复制${title}输出`}
          />
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          这次运行没有记录结果，可能未执行或用例不在批次中。
        </p>
      )}
    </div>
  );
}
