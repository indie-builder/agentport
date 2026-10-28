import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { CopyButton } from './copy-button.js';
import { Button } from './ui/button.js';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.js';

export type ReaderMode = 'read' | 'source';

const MODES: ReadonlyArray<{ value: ReaderMode; label: string }> = [
  { value: 'read', label: '阅读' },
  { value: 'source', label: '源码' },
];

/**
 * 文件阅读的统一工具条：左侧是当前文件的身份与元信息，右侧是查看方式、复制、下载与调用方已有的业务操作。
 * 它只接收展示内容和动作，不持有选择、请求版本或草稿状态。
 */
export function ReaderToolbar({
  identity,
  meta,
  mode,
  onModeChange,
  copy,
  download,
  actions,
}: {
  identity: ReactNode;
  meta?: ReactNode;
  mode?: ReaderMode;
  onModeChange?: (mode: ReaderMode) => void;
  copy?: { value: string; label: string };
  download?: { href: string; label: string; text?: string };
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="min-w-0 text-sm text-fg">{identity}</div>
        {meta === undefined ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {meta}
          </div>
        )}
      </div>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1">
        {mode === undefined || onModeChange === undefined ? null : (
          <ToggleGroup
            aria-label="查看方式"
            multiple={false}
            value={[mode]}
            onValueChange={(values) => {
              const next = MODES.find((item) => item.value === values[0]);
              if (next !== undefined) onModeChange(next.value);
            }}
            variant="outline"
            size="sm"
          >
            {MODES.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {copy === undefined ? null : <CopyButton value={copy.value} label={copy.label} />}
        {download === undefined ? null : (
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            aria-label={download.label}
            title={download.label}
            render={<a href={download.href} download />}
          >
            <Download />
            {download.text ?? null}
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}
