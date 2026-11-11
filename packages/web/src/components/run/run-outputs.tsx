import type { OutputFile, OutputStatus } from '@agentport/shared';
import { FileText } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { outputSelectionMode } from '../../lib/output-preview.js';
import type { OutputSelection } from '../chat/conversation-outputs.js';
import { Button } from '../ui/button.js';

/** 只有成功版本可作为正常交付；其余状态原样显示，不冒充成功。 */
const STATUS_LABEL: Record<OutputStatus, string | null> = {
  succeeded: null,
  failed: '失败',
  cancelled: '已停止',
  timeout: '超时',
};

/** 一轮运行发布过的成果入口；没有文件时整块不渲染。 */
export function RunOutputs({
  files,
  onSelect,
}: {
  files: OutputFile[];
  onSelect: (selection: OutputSelection) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul
      aria-label="本轮成果"
      className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1 p-0"
    >
      {files.map((file) => {
        const status = STATUS_LABEL[file.status];
        return (
          <li key={`${file.runId}:${file.path}`} className="min-w-0 max-w-full">
            <Button
              variant="ghost"
              size="sm"
              title={file.path}
              onClick={() =>
                onSelect({
                  runId: file.runId,
                  path: file.path,
                  mode: outputSelectionMode(file.mediaType),
                })
              }
              className="h-7 max-w-full min-w-0 justify-start gap-1.5 px-1.5 text-sm font-normal text-muted-foreground hover:bg-hover hover:text-fg"
            >
              <FileText className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{file.path}</span>
              {status ? (
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    file.status === 'failed' ? 'text-danger' : 'text-muted-foreground',
                  )}
                >
                  {status}
                </span>
              ) : null}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
