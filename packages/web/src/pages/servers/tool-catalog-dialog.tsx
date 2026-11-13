import type { Server } from '@agentport/shared';
import { RefreshCw } from 'lucide-react';
import { JsonBlock } from '../../components/code-block.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { InlineEmpty } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field } from '../../components/ui/field.js';
import { formatDateTime, formatDuration, shortId } from '../../lib/format.js';
import type { LastTest } from './shared.js';

/** 只读最近试连返回的目录与脱敏错误摘要；打开时不发请求。 */
export function ToolCatalogDialog({
  server,
  lastTest,
  pending,
  testing,
  onRetest,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  lastTest: LastTest | null;
  pending: boolean;
  testing: boolean;
  onRetest: (trigger: HTMLElement) => void;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const result = lastTest?.result ?? null;
  const tools = result?.ok ? result.tools : [];
  // 本次页面的结果优先；刷新后回退到后端持久化的上次试连身份。
  const environment = result
    ? (result.runtimeEnvironment ?? null)
    : (server.lastTestRuntimeEnvironment ?? null);
  const testedAt = lastTest?.at ?? server.lastTestedAt ?? null;
  const ok = result ? result.ok : server.lastTestOk === true;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title={`工具与试连「${server.name}」`}
        {...(testedAt || result ? { description: '最近一次试连结果，只代表这一个环境版本。' } : {})}
        finalFocus={getReturnFocus}
        className="max-w-2xl sm:max-w-2xl"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            {environment ? (
              <span
                className="font-mono"
                title={`${environment.environmentName} · ${environment.versionId} · ${environment.imageId}`}
              >
                环境 {environment.environmentName} · {shortId(environment.versionId)}
              </span>
            ) : null}
            {result?.serverInfo ? (
              <span className="font-mono">
                {result.serverInfo.name} {result.serverInfo.version}
              </span>
            ) : null}
            {testedAt ? (
              <span className="font-mono tabular-nums">
                {formatDateTime(testedAt)}
                {result ? ` · ${formatDuration(result.durationMs)}` : ''}
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={pending}
              aria-busy={testing}
              onClick={(event) => onRetest(event.currentTarget)}
            >
              <RefreshCw data-icon="inline-start" />
              {testing ? '测试中…' : testedAt || result ? '重新测试' : '测试连接'}
            </Button>
          </div>

          {result && !result.ok ? (
            <Field className="gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">失败原因</span>
              {/* 原文展示，不截断也不解析：这条文本是定位连不上问题的唯一线索。 */}
              <p className="break-words rounded-item bg-danger-soft p-3 font-mono text-xs leading-relaxed text-danger">
                {result.error ?? '服务没有返回原因。'}
              </p>
            </Field>
          ) : null}

          {!result ? (
            <InlineEmpty>
              {testing
                ? '正在测试连接…'
                : !testedAt
                  ? '未测试连接。'
                  : ok
                    ? '重新测试后查看工具目录。'
                    : '重新测试后查看失败原因。'}
            </InlineEmpty>
          ) : null}

          {tools.length === 0 && result?.ok ? (
            <InlineEmpty>连接成功，但没有返回任何工具。</InlineEmpty>
          ) : null}

          {tools.length > 0 ? (
            <ul aria-label="工具目录" className="flex flex-col divide-y border-y">
              {tools.map((tool, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 上游工具没有稳定唯一键，同名工具也可能重复
                <li key={`${tool.name}-${index}`} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs text-fg">{tool.name}</span>
                    {tool.title && tool.title !== tool.name ? (
                      <span className="text-xs text-muted-foreground">{tool.title}</span>
                    ) : null}
                  </div>
                  {tool.description ? (
                    <p className="text-sm text-muted-foreground">{tool.description}</p>
                  ) : null}
                  {tool.inputSchema ? (
                    <JsonBlock value={tool.inputSchema} maxHeight="12rem" />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}
