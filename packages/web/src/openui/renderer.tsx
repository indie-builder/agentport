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

/** 工具调用必须带自己的来源：历史消息与多段界面不能靠「最后一条消息」猜。 */
export interface OpenUiToolCallInput {
  conversationId: string;
  messageId: string;
  /** 段号（字符串），同一条消息内唯一。 */
  blockKey: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface OpenUiStateSaveInput {
  conversationId: string;
  messageId: string;
  blockKey: string;
  /** 渲染器的原始状态快照，不透明，按段原样存取。 */
  state: Record<string, unknown>;
}

export interface OpenUiApprovalInput {
  conversationId: string;
  approvalId: string;
}

export interface OpenUiBlockProps {
  /** 围栏内的程序文本（不含围栏本身）。 */
  program: string;
  streaming?: boolean;
  /** 历史消息恢复的表单/绑定快照。 */
  initialState?: Record<string, unknown>;
  /** 动作的统一出口；`continue_conversation` 由上层发成新一轮对话。 */
  onAction?: (action: OpenUiAction) => void;
  /** 解析完成但没有可渲染根节点时回调，由调用方回退原文。 */
  onInvalid?: (program: string) => void;
  messageId?: string;
  conversationId?: string;
  /** 段号（字符串）；缺省时不执行工具、不写状态。 */
  blockKey?: string;
  onToolCall?: (input: OpenUiToolCallInput) => Promise<OpenUiToolResult>;
  onSaveState?: (input: OpenUiStateSaveInput) => Promise<unknown>;
  onApprove?: (input: OpenUiApprovalInput) => Promise<unknown>;
}

/** 段内来源快照：异步工具与卸载兜底都要读最新的值，不能依赖闭包里的旧 props。 */
interface Source {
  conversationId: string | undefined;
  messageId: string | undefined;
  blockKey: string | undefined;
}

/** 待写回的输入连同它产生时的来源；来源变了就不能把值写到另一条消息上。 */
interface PendingSave {
  state: Record<string, unknown>;
  source: Source;
}

/** 审批未完成时库会把同一次调用记成 Mutation 失败；这类文案不当作真实失败。 */
const APPROVAL_REQUIRED = '需要批准：';

/** 快照属于当前消息/段：记录时缺失的来源（id 还没到）不算换来源。 */
function belongsTo(pending: Source, current: Source): boolean {
  return (
    (pending.conversationId === undefined || pending.conversationId === current.conversationId) &&
    (pending.blockKey === undefined || pending.blockKey === current.blockKey) &&
    (pending.messageId === undefined || pending.messageId === current.messageId)
  );
}

/**
 * 生成式 UI 的渲染入口。`open_url` 在这里就做协议白名单校验：
 * 只有 http/https 才交给浏览器，其余的既不开窗也不向上传递。
 */
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

  /* ---------- 状态快照：按块 400ms 防抖，动作前/卸载/页面隐藏必须落盘 ---------- */
  const pendingState = useRef<PendingSave | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 同一块同时只有一个写回在飞：后到的快照排队，避免旧值覆盖新值。 */
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  // sendState 结束时可能还要再 flush 一次；用 ref 打破两者的循环依赖。
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
        // 失败要可见；但失败的那份一旦有更新的待写值，就不能覆盖它。
        if (pendingState.current === null) pendingState.current = { state, source: target };
        if (mounted.current) setSaveError({ error, state });
      } finally {
        inFlight.current = null;
        // 排队期间又变了：继续发最新值。
        if (pendingState.current !== null && pendingState.current.state !== state)
          void flushRef.current();
      }
    })();
    inFlight.current = saving;
    return saving;
  }, []);

  /** 立刻发起写回（不等防抖），调用顺序因此排在动作之前。 */
  const flush = useCallback((): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = pendingState.current;
    if (pending === null) return inFlight.current ?? Promise.resolve();
    const current = source.current;
    // 值属于另一条消息/另一个段：不跨来源写回。
    if (!belongsTo(pending.source, current)) {
      pendingState.current = null;
      return inFlight.current ?? Promise.resolve();
    }
    const target: Source = {
      conversationId: pending.source.conversationId ?? current.conversationId,
      messageId: pending.source.messageId ?? current.messageId,
      blockKey: pending.source.blockKey ?? current.blockKey,
    };
    // 消息 id 还没到：留着值，等本轮结束（id 就绪）再写，不丢。
    if (!target.conversationId || !target.messageId || target.blockKey === undefined)
      return inFlight.current ?? Promise.resolve();
    if (!saveRef.current) {
      pendingState.current = null;
      return inFlight.current ?? Promise.resolve();
    }
    if (inFlight.current !== null) {
      // 前一个还在飞：先留着，等它结束后再发。
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

  // 实时消息先有输入、后落库拿到 id：id 就绪时把暂存值补写出去。
  useEffect(() => {
    if (conversationId && messageId && blockKey !== undefined) void flush();
  }, [conversationId, messageId, blockKey, flush]);

  const handleState = (state: Record<string, unknown>) => {
    pendingState.current = { state, source: { ...source.current } };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 400);
  };

  /* ---------- Query / Mutation：官方 function map，数据原样交给库 ---------- */
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
        // 服务端可能过期后复用同一个 approvalId 重新要求批准：收到 202 就撤销本地已批准标记。
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
        // 官方 QueryError 只展示错误文本；审批入口与重试放在它旁边。
        throw new Error(`需要批准：${toolName}`);
      }
      throw new Error(result.error);
    },
    [],
  );

  // 没有持久化来源时不提供 provider：界面照常渲染，但不会发出注定失败的工具请求；
  // 消息 id 到达后 provider 从 null 变为可用，查询管理器会重新执行 Query。
  // 程序自己决定调用哪个工具、浏览器又没有工具目录，所以用 MCP 形状；
  // structuredContent 让库直接拿到 result.data，不再手工拼 text JSON。
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

  // 解析失败只报一次：每次 render 都回调会让上层重复渲染回退文本。
  const reported = useRef<string | null>(null);
  if (reported.current !== null && reported.current !== program) reported.current = null;

  const handleParseResult = (result: ParseResult | null) => {
    if (!settled || !invalidRef.current) return;
    if (result != null && result.root != null) return;
    if (reported.current === program) return;
    reported.current = program;
    invalidRef.current(program);
  };

  /**
   * 根节点存在也可能有组件被解析器丢弃（unknown child）。
   * 这里只把终态诊断展示出来：Query 失败有自己的槽，审批占位不是真实失败。
   */
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
    // 动作会开新一轮：先把最新表单值发出去（HTTP 已发起），不阻塞点击。
    // 保存失败仍由本段下方的可见错误兜住，不让用户以为「点一下什么都没发生」。
    void flush();
    actionRef.current?.({
      type: 'continue_conversation',
      // 完整参数（含 params.context）必须原样交给模型，不能压成空对象。
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
            // 失败后用户又改了值：重试发最新的那份，不把旧快照写回去。
            pendingState.current ??= { state: saveError.state, source: { ...source.current } };
            void flush();
          }}
        />
      ) : null}
    </div>
  );
}

/** Query 失败槽：只放 source=query 的错误与原生 Retry。 */
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

/**
 * 审批入口：Query 与纯 Mutation 共用。批准只解除下一次调用的门禁，
 * 不自动重放（Mutation 可能已经部分执行）；Query 用原生 Retry，Mutation 由用户再点原动作。
 */
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

/**
 * 终态诊断：根节点还在，但部分组件被解析器/运行时丢弃时也要让人看见，
 * 不能只靠「能渲染」就当成正常。新的有效程序会让 onError 回调空数组，诊断随之清空。
 */
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
