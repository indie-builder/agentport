import { isRecord } from '@agentport/core/record';
import type { OpenUiAction, OpenUiToolResult } from '@agentport/shared';
import { openUiStateEnvelopeSchema, segmentOpenUi } from '@agentport/shared';
import { lazy, Suspense, useMemo, useState } from 'react';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../../openui/renderer.js';
import { Markdown } from '../markdown.js';
import { Skeleton } from '../ui/skeleton.js';

const OpenUiBlock = lazy(async () => {
  const module = await import('../../openui/renderer.js');
  return { default: module.OpenUiBlock };
});

export interface AssistantTextProps {
  text: string;
  openUi: boolean;
  streaming: boolean;
  uiProgram?: string | null;
  uiState?: unknown;
  onAction?: ((action: OpenUiAction) => void) | undefined;
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
            {...(onAction ? { onAction } : {})}
            {...(isRecord(segmentState) ? { initialState: segmentState } : {})}
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

const HAS_ROOT = /^\s*root\s*=/m;

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
  onAction?: ((action: OpenUiAction) => void) | undefined;
  initialState?: Record<string, unknown>;
  messageId?: string;
  conversationId?: string;
  blockKey: string;
  onToolCall?: (input: OpenUiToolCallInput) => Promise<OpenUiToolResult>;
  onSaveState?: (input: OpenUiStateSaveInput) => Promise<unknown>;
  onApprove?: (input: OpenUiApprovalInput) => Promise<unknown>;
}) {
  const [invalid, setInvalid] = useState<string | null>(null);

  if (invalid === program) {
    return <Markdown text={`\`\`\`openui-lang\n${program}\n\`\`\``} />;
  }

  if (streaming && !HAS_ROOT.test(program)) {
    return (
      <div role="status" aria-busy="true" className="text-sm text-muted-foreground">
        正在更新界面…
      </div>
    );
  }

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
        {...(onAction ? { onAction } : {})}
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
