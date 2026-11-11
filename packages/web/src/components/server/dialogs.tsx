import { SECRET_MASK, type Server, type ServerTestResult } from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime, formatDuration, shortId } from '../../lib/format.js';
import {
  useAgents,
  useDeleteServer,
  useRotateServerToken,
  useServerToken,
  useTools,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { CodeBlock, JsonBlock } from '../code-block.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { DialogShell } from '../dialog-shell.js';
import { RequiredMark } from '../required-mark.js';
import { InlineEmpty } from '../states.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Field, FieldDescription, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';

export interface LastTest {
  at: string;
  result: ServerTestResult;
}

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

          {result?.ok && result.error ? (
            <Field className="gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">部分上游失败</span>
              <p className="break-words rounded-item bg-warning-soft p-3 font-mono text-xs leading-relaxed text-warning">
                {result.error}
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

export function DeleteServerDialog({
  server,
  label = 'server',
  onClose,
  getReturnFocus,
}: {
  server: Server;
  label?: string;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const remove = useDeleteServer();
  const agents = useAgents();
  const tools = useTools(server.kind === 'generated' ? server.id : null);
  const [typed, setTyped] = useState('');

  const bound = (agents.data ?? []).filter((agent) => (agent.serverIds ?? []).includes(server.id));
  const toolCount = tools.data?.length ?? 0;
  const loading = agents.isPending || (server.kind === 'generated' && tools.isPending);
  const unknown = agents.isError || (server.kind === 'generated' && tools.isError);
  const risky = bound.length > 0 || toolCount > 0;
  const confirmed = !risky || typed.trim() === server.name;

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      finalFocus={getReturnFocus}
      title={
        label === 'server' ? `删除 server「${server.name}」` : `删除${label}「${server.name}」`
      }
      description="删除后无法恢复；绑定它的智能体会立即失去这个工具来源。"
      confirmLabel="删除"
      confirmDisabled={loading || unknown || !confirmed}
      onConfirm={async () => {
        await remove.mutateAsync(server.id);
        toastSuccess(`${label === 'server' ? 'Server' : label} 已删除`);
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-item bg-danger-soft p-3">
          <p className="text-xs text-danger">影响范围</p>
          {loading ? (
            <p className="mt-1 text-sm text-muted-foreground">正在读取绑定关系…</p>
          ) : unknown ? (
            <p className="mt-1 text-sm text-danger">
              读取不到完整的绑定关系，暂时无法安全删除。请刷新后重试，或先到智能体页确认。
            </p>
          ) : (
            <>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-fg">
                <li>
                  工具 <span className="font-mono tabular-nums">{toolCount}</span> 个
                  {toolCount > 0 ? '，会一并删除' : ''}
                </li>
                <li>
                  智能体 <span className="font-mono tabular-nums">{bound.length}</span> 个
                  {bound.length > 0 ? '，会失去这些工具' : ''}
                </li>
              </ul>
              {bound.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 border-t border-line pt-2 text-sm text-fg">
                  {bound.map((agent) => (
                    <li key={agent.id}>· {agent.name}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>

        {bound.length > 0 ? (
          <Link
            to="/agents"
            className="inline-block self-start text-xs font-medium text-fg underline decoration-line-strong underline-offset-2"
          >
            先去解绑
          </Link>
        ) : null}

        {risky && !loading && !unknown ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor="delete-server-confirm">
              输入 <span className="font-mono">{server.name}</span> 以确认
              <RequiredMark />
            </FieldLabel>
            <Input
              id="delete-server-confirm"
              value={typed}
              autoComplete="off"
              aria-required
              aria-describedby="delete-server-confirm-hint"
              onChange={(event) => setTyped(event.target.value)}
            />
            <FieldDescription id="delete-server-confirm-hint">
              名称必须完全一致；误删后绑定的智能体不会自动恢复。
            </FieldDescription>
          </Field>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

export function ConnectionDialog({
  server,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const token = useServerToken(server.id);
  const rotate = useRotateServerToken(server.id);
  // 轮换后只在这里保留明文；关闭对话框即丢弃。
  const [revealed, setRevealed] = useState<{ token: string; endpoint: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const data = revealed ?? token.data;
  const retry = (): void => {
    void token.refetch();
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return;
        // 轮换进行中关闭会丢掉新 token；请求完成前不允许关闭。
        if (rotate.isPending) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogShell
        title={`连接「${server.name}」`}
        description="外部 Host 用这个端点与 Bearer token 访问；token 只在这里轮换时才显示明文。"
        finalFocus={getReturnFocus}
        closeDisabled={rotate.isPending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Endpoint</span>
            {token.isError && !revealed ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Endpoint 读取失败。
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> 重试
                </Button>
              </p>
            ) : (
              <CodeBlock code={data?.endpoint ?? '加载中…'} copyLabel="复制 Endpoint" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Token</span>
            {data ? (
              // 未轮换时接口只回掩码：那不是可用的 token，不能让用户复制。
              data.token === SECRET_MASK || !revealed ? (
                <p className="text-sm text-muted-foreground">
                  {SECRET_MASK} 已配置。点「轮换 Token」生成新的明文，旧的立即失效。
                </p>
              ) : (
                <CodeBlock code={data.token} copyLabel="复制 Token" />
              )
            ) : token.isError ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Token 读取失败。
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> 重试
                </Button>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">加载中…</p>
            )}
            {revealed ? (
              <p role="status" className="text-sm text-warning">
                只显示这一次，请立即保存；旧 token 已失效。
              </p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={rotate.isPending}
              aria-busy={rotate.isPending}
              onClick={() => setConfirming(true)}
            >
              <KeyRound className="size-3.5" /> {rotate.isPending ? '轮换中' : '轮换'}
            </Button>
          </div>
        </div>
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="轮换 token？"
          description="旧 token 立即失效，正在使用的外部 Host 会中断。旧值不会再显示，只能把新 token 配置到每个 Host。"
          confirmLabel="轮换 token"
          onConfirm={async () => {
            const result = await rotate.mutateAsync(undefined);
            setRevealed(result);
          }}
        />
      </DialogShell>
    </Dialog>
  );
}
