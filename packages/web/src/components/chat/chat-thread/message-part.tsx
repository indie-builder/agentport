import type { OpenUiAction, OpenUiToolResult } from '@agentport/shared';
import { FileText, Image } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { ChatItem } from '../../../lib/chat-state.js';
import { cn } from '../../../lib/cn.js';
import { formatBytes } from '../../../lib/format.js';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../../../openui/renderer.js';
import { CollapsibleText, LARGE_CONTENT_CHARS } from '../../code-block.js';
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '../../ui/attachment.js';
import { Bubble, BubbleContent } from '../../ui/bubble.js';
import { Button } from '../../ui/button.js';
import { Marker, MarkerContent, MarkerIcon } from '../../ui/marker.js';
import { AssistantText } from '../openui-message.js';
import { middleTruncate } from './shared.js';

function FoldingMessageBody({ text }: { text: string }) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setOverflowing(body.scrollHeight > 300);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const collapsed = overflowing && !expanded;
  const maskImage = collapsed
    ? 'linear-gradient(to bottom, black calc(100% - 3rem), transparent)'
    : undefined;

  return (
    <>
      <p
        ref={bodyRef}
        className={cn('whitespace-pre-wrap break-words', collapsed && 'max-h-75 overflow-hidden')}
        style={{ WebkitMaskImage: maskImage, maskImage }}
      >
        {text}
      </p>
      {overflowing ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-expanded={expanded}
          aria-label={expanded ? '收起消息' : '展开完整消息'}
          onClick={() => setExpanded((value) => !value)}
          className="self-start text-sm"
        >
          {expanded ? '收起' : '展开'}
        </Button>
      ) : null}
    </>
  );
}

export const MessagePart = memo(function MessagePart({
  item,
  openUi,
  streaming,
  onAction,
  openUiSnapshot,
}: {
  item: Exclude<ChatItem, { kind: 'tool' }>;
  openUi: boolean;
  streaming: boolean;
  openUiSnapshot?: OpenUiSnapshot;
  onAction?: ((action: OpenUiAction) => void) | undefined;
}) {
  const subAgentText = item.kind === 'text' && item.parentToolUseId !== undefined;
  const messageOpenUi = subAgentText
    ? false
    : item.kind === 'text' && item.uiFormat
      ? item.uiFormat === 'openui'
      : openUi;
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {item.text ? (
            <Bubble
              align={item.self === false ? 'start' : 'end'}
              variant="secondary"
              className="max-w-[85%]"
            >
              <BubbleContent className="px-4 py-3 text-base leading-[22px]">
                <FoldingMessageBody text={item.text} />
              </BubbleContent>
            </Bubble>
          ) : null}
          {item.attachments && item.attachments.length > 0 ? (
            <AttachmentGroup role="list" aria-label="附件">
              {item.attachments.map((attachment, index) => (
                <Attachment
                  key={attachment.id ?? `${attachment.filename}-${index}`}
                  role="listitem"
                  size="sm"
                  state="done"
                >
                  <AttachmentMedia
                    variant={attachment.mimeType.startsWith('image/') ? 'image' : 'icon'}
                  >
                    {attachment.mimeType.startsWith('image/') ? (
                      <Image aria-hidden="true" />
                    ) : (
                      <FileText aria-hidden="true" />
                    )}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle title={attachment.filename}>
                      {middleTruncate(attachment.filename)}
                    </AttachmentTitle>
                    <AttachmentDescription>{formatBytes(attachment.size)}</AttachmentDescription>
                  </AttachmentContent>
                  {attachment.downloadUrl ? (
                    <AttachmentTrigger
                      render={
                        <a
                          href={attachment.downloadUrl}
                          aria-label={`下载 ${attachment.filename}（${formatBytes(attachment.size)}）`}
                        />
                      }
                    />
                  ) : null}
                </Attachment>
              ))}
            </AttachmentGroup>
          ) : null}
        </div>
      );
    case 'text':
      return (
        <div className="min-w-0">
          {renderAssistantText(item.text, messageOpenUi, streaming, onAction, {
            ...(item.messageId !== undefined
              ? { messageId: item.messageId }
              : item.id === undefined
                ? {}
                : { messageId: item.id.split(':')[0] }),
            ...(item.uiProgram == null ? {} : { uiProgram: item.uiProgram }),
            ...(item.uiState == null ? {} : { uiState: item.uiState }),
            ...(openUiSnapshot ?? {}),
          })}
          {item.truncated ? (
            <p className="text-sm text-muted-foreground">
              该段内容超过单块上限，只显示了前一部分。
            </p>
          ) : null}
        </div>
      );
    case 'notice':
      return (
        <Marker
          variant="default"
          className={
            item.tone === 'ok'
              ? 'text-success'
              : item.tone === 'error'
                ? 'text-danger'
                : item.tone === 'warning'
                  ? 'text-warning'
                  : 'text-muted-foreground'
          }
        >
          <MarkerIcon className="flex items-center justify-center">
            <span
              className={cn(
                'size-1 rounded-full',
                item.tone === 'ok'
                  ? 'bg-success'
                  : item.tone === 'error'
                    ? 'bg-danger'
                    : item.tone === 'warning'
                      ? 'bg-warning'
                      : 'bg-subtle',
              )}
              aria-hidden="true"
            />
          </MarkerIcon>
          <MarkerContent>{item.text}</MarkerContent>
        </Marker>
      );
  }
});

export interface OpenUiSnapshot {
  conversationId?: string;
  messageId?: string;
  uiProgram?: string;
  uiState?: unknown;
  onToolCall?: (input: OpenUiToolCallInput) => Promise<OpenUiToolResult>;
  onSaveState?: (input: OpenUiStateSaveInput) => Promise<unknown>;
  onApprove?: (input: OpenUiApprovalInput) => Promise<unknown>;
}

function renderAssistantText(
  text: string,
  openUi: boolean,
  streaming: boolean,
  onAction: ((action: OpenUiAction) => void) | undefined,
  snapshot?: OpenUiSnapshot,
) {
  if (text.length > LARGE_CONTENT_CHARS) {
    return (
      <CollapsibleText text={text} className="whitespace-pre-wrap break-words text-base text-fg" />
    );
  }
  return (
    <AssistantText
      text={text}
      openUi={openUi}
      streaming={streaming}
      onAction={onAction}
      {...(snapshot?.messageId === undefined ? {} : { messageId: snapshot.messageId })}
      {...(snapshot?.conversationId === undefined
        ? {}
        : { conversationId: snapshot.conversationId })}
      {...(snapshot?.uiProgram === undefined ? {} : { uiProgram: snapshot.uiProgram })}
      {...(snapshot?.uiState === undefined ? {} : { uiState: snapshot.uiState })}
      {...(snapshot?.onToolCall === undefined ? {} : { onToolCall: snapshot.onToolCall })}
      {...(snapshot?.onSaveState === undefined ? {} : { onSaveState: snapshot.onSaveState })}
      {...(snapshot?.onApprove === undefined ? {} : { onApprove: snapshot.onApprove })}
    />
  );
}
