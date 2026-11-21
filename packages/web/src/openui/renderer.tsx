import { isSafeOpenUrl, type OpenUiAction, type OpenUiToolResult } from '@agentport/shared';
import {
  type OpenUIError,
  type ParseResult,
  Renderer,
  useRendererQuery,
} from '@openuidev/react-lang';
import { CircleAlert, CircleCheck, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorState } from '../components/states.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { library as openUiLibrary } from './library.js';

export interface OpenUiToolCallInput {
  conversationId: string;
  messageId: string;
  blockKey: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface OpenUiStateSaveInput {
  conversationId: string;
  messageId: string;
  blockKey: string;
  state: Record<string, unknown>;
}

export interface OpenUiApprovalInput {
  conversationId: string;
  approvalId: string;
}

interface OpenUiBlockProps {
  program: string;
  streaming?: boolean;
  initialState?: Record<string, unknown>;
  onAction?: (action: OpenUiAction) => void;
  onInvalid?: (program: string) => void;
  messageId?: string;
  conversationId?: string;
  blockKey?: string;
  onToolCall?: (input: OpenUiToolCallInput) => Promise<OpenUiToolResult>;
  onSaveState?: (input: OpenUiStateSaveInput) => Promise<unknown>;
  onApprove?: (input: OpenUiApprovalInput) => Promise<unknown>;
}

interface Source {
  conversationId: string | undefined;
  messageId: string | undefined;
  blockKey: string | undefined;
}

interface PendingSave {
  state: Record<string, unknown>;
  source: Source;
}

/** 审批未完成时库会把同一次调用记成 Mutation 失败；这类文案不当作真实失败。 */
const APPROVAL_REQUIRED = '需要批准：';

function belongsTo(pending: Source, current: Source): boolean {
  return (
    (pending.conversationId === undefined || pending.conversationId === current.conversationId) &&
    (pending.blockKey === undefined || pending.blockKey === current.blockKey) &&
    (pending.messageId === undefined || pending.messageId === current.messageId)
  );
}

export function OpenUiBlock({
  program,
  streaming = false,
  initialState,
  onAction,
  onInvalid,
  messageId,
  conversationId,
  blockKey,
  onToolCall,
  onSaveState,
  onApprove,
}: OpenUiBlockProps) {
  const invalidRef = useRef(onInvalid);
  invalidRef.current = onInvalid;
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const toolCallRef = useRef(onToolCall);
  toolCallRef.current = onToolCall;
  const saveRef = useRef(onSaveState);
  saveRef.current = onSaveState;
  const approveRef = useRef(onApprove);
  approveRef.current = onApprove;

  const source = useRef<Source>({ conversationId, messageId, blockKey });
  source.current = { conversationId, messageId, blockKey };
  const [approvals, setApprovals] = useState<Array<{ approvalId: string; toolName: string }>>([]);
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());
  const [saveError, setSaveError] = useState<{
    error: unknown;
    state: Record<string, unknown>;
  } | null>(null);

  const pendingState = useRef<PendingSave | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const sendState = useCallback((state: Record<string, unknown>, target: Source): Promise<void> => {
    if (!target.conversationId || !target.messageId || target.blockKey === undefined)
      return Promise.resolve();
    const saving = (async () => {
      try {
        await saveRef.current?.({
          conversationId: target.conversationId as string,
          messageId: target.messageId as string,
          blockKey: target.blockKey as string,
          state,
        });
        if (mounted.current) setSaveError(null);
      } catch (error) {
        if (pendingState.current === null) pendingState.current = { state, source: target };
        if (mounted.current) setSaveError({ error, state });
      } finally {
        inFlight.current = null;
        if (pendingState.current !== null && pendingState.current.state !== state)
          void flushRef.current();
      }
    })();
    inFlight.current = saving;
    return saving;
  }, []);

  const flush = useCallback((): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = pendingState.current;
    if (pending === null) return inFlight.current ?? Promise.resolve();
    const current = source.current;
    if (!belongsTo(pending.source, current)) {
      pendingState.current = null;
      return inFlight.current ?? Promise.resolve();
    }
    const target: Source = {
      conversationId: pending.source.conversationId ?? current.conversationId,
      messageId: pending.source.messageId ?? current.messageId,
      blockKey: pending.source.blockKey ?? current.blockKey,
    };
    if (!target.conversationId || !target.messageId || target.blockKey === undefined)
      return inFlight.current ?? Promise.resolve();
    if (!saveRef.current) {
      pendingState.current = null;
      return inFlight.current ?? Promise.resolve();
    }
    if (inFlight.current !== null) {
      pendingState.current = { state: pending.state, source: target };
      return inFlight.current;
    }
    pendingState.current = null;
    return sendState(pending.state, target);
  }, [sendState]);
  flushRef.current = flush;

  useEffect(() => {
    mounted.current = true;
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onHidden);
      void flush();
    };
  }, [flush]);

  useEffect(() => {
    if (conversationId && messageId && blockKey !== undefined) void flush();
  }, [conversationId, messageId, blockKey, flush]);

  const handleState = (state: Record<string, unknown>) => {
    pendingState.current = { state, source: { ...source.current } };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 400);
  };

  const runTool = useCallback(
    async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      const { conversationId: conversation, messageId: message, blockKey: key } = source.current;
      const handler = toolCallRef.current;
      if (!conversation || !message || key === undefined || !handler) {
        throw new Error('这一轮界面还没保存，暂时无法查询数据；请等本轮结束后重试');
      }
      const result = await handler({
        conversationId: conversation,
        messageId: message,
        blockKey: key,
        toolName,
        args,
      });
      if (result.status === 'ok') return result.data;
      if (result.status === 'approval_required') {
        setApproved((previous) => {
          if (!previous.has(result.approvalId)) return previous;
          const next = new Set(previous);
          next.delete(result.approvalId);
          return next;
        });
        setApprovals((previous) =>
          previous.some((item) => item.approvalId === result.approvalId)
            ? previous
            : [...previous, { approvalId: result.approvalId, toolName }],
        );
        throw new Error(`需要批准：${toolName}`);
      }
      throw new Error(result.error);
    },
    [],
  );

  const toolProvider = useMemo(() => {
    if (!onToolCall || !conversationId || !messageId || blockKey === undefined) return null;
    return {
      callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => ({
        content: [],
        structuredContent: await runTool(params.name, params.arguments ?? {}),
      }),
    };
  }, [onToolCall, conversationId, messageId, blockKey, runTool]);

  const settled = !streaming;
  const [diagnostics, setDiagnostics] = useState<OpenUIError[]>([]);

  const reported = useRef<string | null>(null);
  if (reported.current !== null && reported.current !== program) reported.current = null;

  const handleParseResult = (result: ParseResult | null) => {
    if (!settled || !invalidRef.current) return;
    if (result != null && result.root != null) return;
    if (reported.current === program) return;
    reported.current = program;
    invalidRef.current(program);
  };

  const handleError = (errors: OpenUIError[]) => {
    setDiagnostics(
      errors.filter(
        (error) =>
          error.source !== 'query' &&
          !(error.source === 'mutation' && error.message.includes(APPROVAL_REQUIRED)),
      ),
    );
  };

  const handleAction = (event: {
    type: string;
    params: Record<string, unknown>;
    humanFriendlyMessage: string;
    formState?: Record<string, unknown>;
    formName?: string;
  }) => {
    const params = (event.params ?? {}) as Record<string, unknown>;
    if (event.type === 'open_url') {
      const url = params.url;
      if (typeof url === 'string' && isSafeOpenUrl(url)) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    if (event.type !== 'continue_conversation') return;
    if (!event.humanFriendlyMessage) return;
    void flush();
    actionRef.current?.({
      type: 'continue_conversation',
      params,
      message: event.humanFriendlyMessage,
      ...(params.context === undefined ? {} : { context: params.context }),
      ...(event.formState === undefined ? {} : { formState: event.formState }),
      ...(event.formName === undefined ? {} : { formName: event.formName }),
      ...(messageId === undefined ? {} : { messageId }),
      ...(blockKey === undefined ? {} : { blockKey }),
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Renderer.Root
        response={program}
        library={openUiLibrary}
        isStreaming={streaming}
        {...(initialState ? { initialState } : {})}
        {...(toolProvider ? { toolProvider } : {})}
        onStateUpdate={handleState}
        onParseResult={handleParseResult}
        onError={handleError}
        onAction={handleAction}
      >
        <Renderer.Content />
        <Renderer.QueryLoading>
          <p className="text-xs text-muted-foreground" role="status">
            正在查询数据…
          </p>
        </Renderer.QueryLoading>
        <Renderer.QueryError>
          <QueryFailure />
        </Renderer.QueryError>
        {/* QueryError 只覆盖 source=query；Mutation 审批必须放在槽外，否则看不到入口。 */}
        {approvals.length > 0 ? (
          <ApprovalEntry
            approvals={approvals}
            approved={approved}
            {...(conversationId === undefined ? {} : { conversationId })}
            onApprove={async (approvalId) => {
              if (!approveRef.current) return;
              await approveRef.current({ conversationId: conversationId ?? '', approvalId });
              setApproved((previous) => new Set(previous).add(approvalId));
            }}
          />
        ) : null}
        {diagnostics.length > 0 ? <Diagnostics errors={diagnostics} /> : null}
      </Renderer.Root>
      {saveError ? (
        <ErrorState
          error={saveError.error}
          title="界面状态没有保存"
          onRetry={() => {
            pendingState.current ??= { state: saveError.state, source: { ...source.current } };
            void flush();
          }}
        />
      ) : null}
    </div>
  );
}

function QueryFailure() {
  const { errors, isLoading } = useRendererQuery();
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-card border border-line bg-chip px-3 py-2 text-xs text-fg"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {errors.map((error) => (
          <p key={`${error.statementId ?? ''}-${error.code}-${error.message}`}>{error.message}</p>
        ))}
      </div>
      <Renderer.Retry
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}
        disabled={isLoading}
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        重试
      </Renderer.Retry>
    </div>
  );
}

function ApprovalEntry({
  approvals,
  approved,
  conversationId,
  onApprove,
}: {
  approvals: Array<{ approvalId: string; toolName: string }>;
  approved: ReadonlySet<string>;
  conversationId?: string;
  onApprove: (approvalId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {approvals.map(({ approvalId, toolName }) => {
        const done = approved.has(approvalId);
        return (
          <div
            key={approvalId}
            className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-chip px-3 py-2 text-xs text-fg"
          >
            {done ? (
              <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
              工具 <code className="font-mono">{toolName}</code>{' '}
              {done
                ? '已批准；本次调用不会自动重放，请重试查询或重新点击原操作。'
                : '需要批准后才能调用。批准后请重试查询或重新点击原操作；本次调用不会自动重放。'}{' '}
              <span className="text-muted-foreground">
                批准在本会话内有效，8 小时后需重新批准。
              </span>
            </div>
            {done ? null : (
              <Button
                size="sm"
                disabled={busy !== null || !conversationId}
                aria-busy={busy === approvalId}
                onClick={() => {
                  setBusy(approvalId);
                  setFailure(null);
                  void onApprove(approvalId)
                    .catch((error: unknown) => setFailure(errorMessage(error)))
                    .finally(() => setBusy(null));
                }}
              >
                {busy === approvalId ? '批准中…' : '批准工具调用'}
              </Button>
            )}
          </div>
        );
      })}
      {failure ? (
        <p role="alert" className="text-xs text-danger">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function Diagnostics({ errors }: { errors: OpenUIError[] }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-card border border-line bg-danger-soft px-3 py-2 text-xs text-fg"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p className="font-medium">这段界面有内容没有显示出来</p>
        {errors.map((error) => (
          <p key={`${error.source}-${error.statementId ?? ''}-${error.code}-${error.message}`}>
            {error.message}
          </p>
        ))}
      </div>
    </div>
  );
}
