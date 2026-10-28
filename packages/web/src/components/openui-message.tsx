import type { OpenUiAction, OpenUiToolResult } from '@agentport/shared';
import { openUiStateEnvelopeSchema, segmentOpenUi } from '@agentport/shared';
import { lazy, Suspense, useMemo, useState } from 'react';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../openui/renderer.js';
import { Markdown } from './markdown.js';
import { Skeleton } from './ui/skeleton.js';

/**
 * 渲染器与 84 个组件只有生成式 UI 智能体才用得上。
 * 单独成 chunk，避免把图表、日历等一并塞进聊天首屏。
 */
const OpenUiBlock = lazy(async () => {
  const module = await import('../openui/renderer.js');
  return { default: module.OpenUiBlock };
});

export interface AssistantTextProps {
  /** 流式期间的原始文本；稳定后若给了 `uiProgram` 则以它为准。 */
  text: string;
  openUi: boolean;
  streaming: boolean;
  /**
   * 落库后的完整混合文本（Markdown + 完整 openui 围栏），由服务端合并 editMode 补丁后写回。
   * 稳定态优先用它：补丁本身只能说明改了什么，不能当成完整界面渲染。
   */
  uiProgram?: string | null;
  /** 该消息 UI 段的表单/绑定快照：`{ version: 1, blocks: { [blockKey]: state } }`。 */
  uiState?: unknown;
  /** 动作出口；完整动作（含 params.context 与表单值）交给页面发送。 */
  onAction: (action: OpenUiAction) => void;
  /** 落库后的消息 id；流刚结束时为空，由上层在收到持久化 id 后补齐。 */
  messageId?: string;
  conversationId?: string;
  onToolCall?: (input: OpenUiToolCallInput) => Promise<OpenUiToolResult>;
  onSaveState?: (input: OpenUiStateSaveInput) => Promise<unknown>;
  onApprove?: (input: OpenUiApprovalInput) => Promise<unknown>;
}

/**
 * 助手消息渲染。按围栏把文本切成 Markdown 与 OpenUI 两段：
 * 安装版解析器会把任意语言的围栏都当程序，所以不能整段丢给 Renderer。
 */
export function AssistantText({
  text,
  openUi,
  streaming,
  uiProgram,
  uiState,
  onAction,
  messageId,
  conversationId,
  onToolCall,
  onSaveState,
  onApprove,
}: AssistantTextProps) {
  // 稳定态优先用服务端合并后的完整文本；流式期间没有它，只能看原文。
  const source = !streaming && uiProgram ? uiProgram : text;
  const segments = useMemo(
    () =>
      openUi ? segmentOpenUi(source, streaming) : [{ kind: 'markdown' as const, text: source }],
    [openUi, source, streaming],
  );
  const stateBlocks = useMemo(() => {
    const parsed = openUiStateEnvelopeSchema.safeParse(uiState);
    return parsed.success ? parsed.data.blocks : {};
  }, [uiState]);

  // 纯 Markdown（含普通问答与非 openui 智能体）保持原样，零额外开销。
  if (segments.length === 1 && segments[0]?.kind === 'markdown') {
    return <Markdown text={segments[0].text} streaming={streaming} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {segments.map((segment, index) => {
        if (segment.kind === 'markdown') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段按出现顺序生成
            <Markdown key={`md-${index}`} text={segment.text} streaming={streaming} />
          );
        }
        // 段号只数 UI 段：同一条消息内稳定，且分支复制快照后含义不变。
        const blockKey = segment.blockKey;
        if (blockKey === undefined) return null;
        const segmentState = stateBlocks[blockKey];
        return (
          <OpenUiSegment
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段按出现顺序生成
            key={`oui-${index}`}
            blockKey={blockKey}
            program={segment.text}
            streaming={streaming}
            onAction={onAction}
            {...(isStateRecord(segmentState) ? { initialState: segmentState } : {})}
            {...(messageId === undefined ? {} : { messageId })}
            {...(conversationId === undefined ? {} : { conversationId })}
            {...(onToolCall ? { onToolCall } : {})}
            {...(onSaveState ? { onSaveState } : {})}
            {...(onApprove ? { onApprove } : {})}
          />
        );
      })}
    </div>
  );
}

/** 程序里已经有显式根语句；否则流式片段还只是补丁前缀。 */
const HAS_ROOT = /^\s*root\s*=/m;

/** 快照是不可信 jsonb：只有普通对象才交给渲染器，脏数据当作没有快照。 */
function isStateRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 单段程序。解析不出根节点时回退成原文代码块：
 * 让人至少读到模型写了什么，而不是一块空白。
 */
function OpenUiSegment({
  program,
  streaming,
  onAction,
  initialState,
  messageId,
  conversationId,
  blockKey,
  onToolCall,
  onSaveState,
  onApprove,
}: {
  program: string;
  streaming: boolean;
  onAction: (action: OpenUiAction) => void;
  initialState?: Record<string, unknown>;
  messageId?: string;
  conversationId?: string;
  blockKey: string;
  onToolCall?: (input: OpenUiToolCallInput) => Promise<OpenUiToolResult>;
  onSaveState?: (input: OpenUiStateSaveInput) => Promise<unknown>;
  onApprove?: (input: OpenUiApprovalInput) => Promise<unknown>;
}) {
  // 记录「哪个 program 解析失败」，而不是一个永久开关：有效程序到达时自动恢复。
  // 同时用 program 文本作标记，旧渲染器迟到的 onInvalid 不会污染新快照。
  const [invalid, setInvalid] = useState<string | null>(null);

  if (invalid === program) {
    return <Markdown text={`\`\`\`openui-lang\n${program}\n\`\`\``} />;
  }

  // editMode 的流式回复常常只有补丁语句。补丁不能当成完整界面渲染，
  // 也不能与上一轮半合并：这里明确显示「正在更新」，等落库的完整程序到达再换。
  if (streaming && !HAS_ROOT.test(program)) {
    return (
      <div role="status" aria-busy="true" className="text-sm text-muted-foreground">
        正在更新界面…
      </div>
    );
  }

  // 渲染器 chunk 按需加载：占位取正文行高，不把程序源码闪一下。
  return (
    <Suspense
      fallback={
        <Skeleton role="status" aria-busy="true" aria-label="加载中" className="h-6.5 w-full" />
      }
    >
      <OpenUiBlock
        program={program}
        streaming={streaming}
        blockKey={blockKey}
        onInvalid={(failed) => setInvalid(failed)}
        onAction={onAction}
        {...(messageId === undefined ? {} : { messageId })}
        {...(conversationId === undefined ? {} : { conversationId })}
        {...(onToolCall ? { onToolCall } : {})}
        {...(onSaveState ? { onSaveState } : {})}
        {...(onApprove ? { onApprove } : {})}
        {...(initialState ? { initialState } : {})}
      />
    </Suspense>
  );
}
