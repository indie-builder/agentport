import type { AgentSummary } from '@agentport/shared';
import { ATTACHMENT_LIMITS, attachmentMimeForFilename } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { ArrowUp, CircleStop, FileText, Image, LoaderCircle, Paperclip, X } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useRef, useState } from 'react';
import { can } from '../../../lib/access.js';
import { isActivePhase, useChatStore } from '../../../lib/chat-store.js';
import { cn } from '../../../lib/cn.js';
import { formatBytes } from '../../../lib/format.js';
import { meQuery } from '../../../lib/queries.js';
import type { useChatStream } from '../../../lib/use-chat-stream.js';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '../../ui/attachment.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '../../ui/input-group.js';
import { middleTruncate } from './shared.js';

const ATTACHMENT_ACCEPT = [
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
]
  .filter((extension) => attachmentMimeForFilename(`file.${extension}`) !== null)
  .map((extension) => `.${extension}`)
  .join(',');

/** 单文件上限按规范类型取，类型本身由 shared 扩展名映射决定。 */
function attachmentLimitFor(filename: string): number | null {
  const mime = attachmentMimeForFilename(filename);
  if (mime === null) return null;
  if (mime === 'application/pdf') return ATTACHMENT_LIMITS.pdfBytes;
  return mime.startsWith('image/') ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.textBytes;
}

/** 输入与底部操作共用 InputGroup 的一层焦点边框。 */
export function Composer({
  agent,
  send,
  textareaRef,
  lastRunId,
  welcome,
  historyReady = true,
  cancelling = false,
  onCancel,
  value,
  onValueChange,
  onKeyDown,
  enabled,
  locked: lockedProp,
  canAttach = true,
  canSend: canSendProp,
  sendDenied = '当前账户没有新建会话的权限，不能发送消息。',
  placeholder = '描述你想完成的事…',
}: {
  agent: AgentSummary | null;
  send: ReturnType<typeof useChatStream>['send'];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  lastRunId: string | null;
  welcome: boolean;
  historyReady?: boolean;
  cancelling?: boolean;
  onCancel?: () => void;
  /** 受控输入：频道页用本地状态，缺省仍读写聊天草稿。 */
  value?: string;
  onValueChange?: (value: string, caret: number | null) => void;
  /** 返回 true 表示已消费按键（如 @ 补全），不再触发发送。 */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 不依赖聊天专家也能输入；频道没有单一 agent。 */
  enabled?: boolean;
  /** 覆盖聊天运行锁：频道允许多条 run 并行时继续发送。 */
  locked?: boolean;
  canAttach?: boolean;
  /** 覆盖平台发送权限：频道按成员角色判定。 */
  canSend?: boolean;
  /** 不能发送时的原因，频道用于区分只读与已关闭。 */
  sendDenied?: string;
  placeholder?: string;
}) {
  // 只订阅输入内容：打字不会重渲染消息列表所在的 ChatColumn。
  const me = useQuery(meQuery);
  const location = useLocation();
  const canSend = canSendProp ?? can(me.data, 'conversations.create');
  const canCancelRun = can(me.data, 'runs.cancel');
  const storeInput = useChatStore((state) => state.input);
  const setInput = useChatStore((state) => state.setInput);
  const phase = useChatStore((state) => state.phase);
  const outputRef = useChatStore((state) => state.outputRef);
  const setOutputRef = useChatStore((state) => state.setOutputRef);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const setPendingAttachments = useChatStore((state) => state.setPendingAttachments);
  const input = value ?? storeInput;
  const enabledValue = enabled ?? agent !== null;
  const runId = isActivePhase(phase) ? phase.runId : null;
  const locked = lockedProp ?? phase.kind !== 'idle';
  const attachments = canAttach ? pendingAttachments : [];
  const hasContent = Boolean(input.trim()) || attachments.length > 0;
  const attachmentsLocked = !enabledValue || !historyReady || locked;
  const change = (next: string, caret: number | null): void => {
    if (onValueChange) onValueChange(next, caret);
    else setInput(next);
  };

  // Enter 与发送按钮共用同一条发送路径；输入框在欢迎与会话之间保持同一个节点。
  const submit = (): void => {
    if (!historyReady || locked || !canSend) return;
    void send();
  };
  return (
    <form
      className={cn('mx-auto w-full max-w-220 shrink-0 px-6 pb-6', welcome ? 'pt-0' : 'pt-3')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="w-full">
        <InputGroup className="h-auto rounded-[var(--radius-composer)] bg-surface shadow-composer hover:shadow-composer-hover has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:shadow-composer-focus">
          {outputRef ? (
            <div className="flex min-w-0 items-center gap-2 px-4 pt-3">
              <Badge variant="outline" className="min-w-0 max-w-full">
                <Paperclip aria-hidden="true" />
                <span className="truncate">{outputRef.path}</span>
              </Badge>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="取消引用"
                title="取消引用"
                onClick={() => setOutputRef(null)}
                className="text-muted-foreground"
              >
                <X />
              </Button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <AttachmentGroup role="list" aria-label="待发送资料" className="w-full px-4 pt-3">
              {attachments.map((file, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同名文件可重复选择，位置即身份
                <Attachment key={`${file.name}-${index}`} role="listitem" size="sm" state="idle">
                  <AttachmentMedia variant={file.type.startsWith('image/') ? 'image' : 'icon'}>
                    {file.type.startsWith('image/') ? (
                      <Image aria-hidden="true" />
                    ) : (
                      <FileText aria-hidden="true" />
                    )}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle title={file.name}>{middleTruncate(file.name)}</AttachmentTitle>
                    <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`移除 ${file.name}`}
                      title="移除资料"
                      disabled={locked}
                      onClick={() =>
                        setPendingAttachments(
                          pendingAttachments.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
            </AttachmentGroup>
          ) : null}
          <InputGroupTextarea
            ref={textareaRef}
            aria-label="消息"
            aria-describedby={canSend ? undefined : 'composer-send-denied'}
            rows={2}
            placeholder={placeholder}
            title={locked ? '本轮结束后才能发送；现在可以先把下一条写好' : undefined}
            disabled={!enabledValue || !historyReady}
            value={input}
            className={cn(
              'max-h-40 min-w-0 px-4 pb-2 pt-4 text-base md:text-base',
              welcome ? 'min-h-20' : 'min-h-14',
            )}
            onChange={(event) => change(event.target.value, event.target.selectionStart)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (onKeyDown?.(event)) {
                event.preventDefault();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <InputGroupAddon align="block-end" className="justify-between gap-3 px-4 pb-3 pt-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
              {canAttach ? <AttachmentPicker disabled={attachmentsLocked} /> : null}
              <span>Enter 发送 · Shift+Enter 换行</span>
              {lastRunId ? (
                <Link
                  to="/runs/$runId"
                  params={{ runId: lastRunId }}
                  search={{ backTo: location.href }}
                  className="inline-flex items-center text-link underline underline-offset-2 hover:text-link/80"
                >
                  查看本次运行
                </Link>
              ) : null}
            </div>
            {runId && onCancel ? (
              // 运行中发送位换成停止：动作在用户正在打字的地方，不用到消息流里找。
              canCancelRun ? (
                <InputGroupButton
                  variant="outline"
                  size="icon-sm"
                  onClick={onCancel}
                  disabled={cancelling}
                  aria-busy={cancelling}
                  aria-label="停止运行"
                  title="停止本轮运行"
                  className="ml-auto"
                >
                  {cancelling ? <LoaderCircle className="animate-spin" /> : <CircleStop />}
                </InputGroupButton>
              ) : null
            ) : (
              <InputGroupButton
                type="submit"
                variant="solid"
                size="icon-sm"
                disabled={!enabledValue || locked || !hasContent || !historyReady || !canSend}
                aria-label="发送消息"
                aria-describedby={canSend ? undefined : 'composer-send-denied'}
                title={
                  !canSend ? '当前账户没有新建会话的权限' : locked ? '本轮结束后可发送' : undefined
                }
                className="ml-auto"
              >
                <ArrowUp />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        {!canSend ? (
          <p id="composer-send-denied" className="mt-2 px-1 text-sm text-muted-foreground">
            {sendDenied}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * 资料选择：本地错误与文件框只在真正渲染时用 React 状态。
 * Composer 保持可直接调用（键盘单测），因此不在这里以外新增 hook。
 */
function AttachmentPicker({ disabled }: { disabled: boolean }) {
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const setPendingAttachments = useChatStore((state) => state.setPendingAttachments);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    const selected = [...files];
    if (pendingAttachments.length + selected.length > ATTACHMENT_LIMITS.count) {
      setError(`最多添加 ${ATTACHMENT_LIMITS.count} 个资料`);
      return;
    }
    let total = pendingAttachments.reduce((sum, file) => sum + file.size, 0);
    for (const file of selected) {
      const limit = attachmentLimitFor(file.name);
      if (limit === null) {
        setError(`不支持「${file.name}」的文件类型`);
        return;
      }
      if (file.size > limit) {
        setError(`「${file.name}」超过 ${formatBytes(limit)}`);
        return;
      }
      total += file.size;
    }
    if (total > ATTACHMENT_LIMITS.totalBytes) {
      setError(`资料合计不能超过 ${formatBytes(ATTACHMENT_LIMITS.totalBytes)}`);
      return;
    }
    setPendingAttachments([...pendingAttachments, ...selected]);
    setError(null);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-label="选择资料文件"
        disabled={disabled}
        onChange={(event) => {
          pick(event.target.files);
          event.target.value = '';
        }}
      />
      <InputGroupButton
        size="icon-sm"
        aria-label="添加资料"
        title="添加资料（文本、图片、PDF）"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="shrink-0"
      >
        <Paperclip />
      </InputGroupButton>
      {error ? (
        <span role="alert" className="min-w-0 text-danger [overflow-wrap:anywhere]">
          {error}
        </span>
      ) : null}
    </>
  );
}
