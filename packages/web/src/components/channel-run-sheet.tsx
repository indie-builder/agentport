import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Download, FileText } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  formatBytes,
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../lib/format.js';
import { outputPreviewKind } from '../lib/output-preview.js';
import {
  channelRunOutputsQueryKey,
  useChannelRunDetail,
  useChannelRunOutputBlob,
  useChannelRunOutputContent,
  useChannelRunOutputs,
  useChannelRunQuestions,
  useRespondToChannelQuestion,
} from '../lib/queries.js';
import { BlobImage } from './blob-image.js';
import { BlobPdf } from './blob-pdf.js';
import { CodeBlock } from './code-block.js';
import { CopyButton } from './copy-button.js';
import { Markdown } from './markdown.js';
import { PageNote } from './page.js';
import { RunQuestionCard } from './run-question.js';
import { RunStatusBadge } from './run-status-badge.js';
import { StepInspector, stepName } from './run-steps.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion.js';
import { Button, buttonVariants } from './ui/button.js';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './ui/sheet.js';

export function ChannelRunSheet({
  channelId,
  runId,
  canAnswer,
  onClose,
}: {
  channelId: string;
  runId: string | null;
  canAnswer: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={runId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {runId === null ? null : (
        <ChannelRunSheetContent
          key={runId}
          channelId={channelId}
          runId={runId}
          canAnswer={canAnswer}
        />
      )}
    </Sheet>
  );
}

function ChannelRunSheetContent({
  channelId,
  runId,
  canAnswer,
}: {
  channelId: string;
  runId: string;
  canAnswer: boolean;
}) {
  const detail = useChannelRunDetail(channelId, runId);
  const status = detail.data?.run.status;
  const active = status === 'queued' || status === 'running';
  const questions = useChannelRunQuestions(channelId, runId, active);
  const outputs = useChannelRunOutputs(channelId, runId);
  const respond = useRespondToChannelQuestion(channelId);
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const canRespond = active && canAnswer;
  const previousActive = useRef(active);

  useEffect(() => {
    if (previousActive.current && !active) {
      void client.invalidateQueries({
        queryKey: channelRunOutputsQueryKey(channelId, runId),
      });
    }
    previousActive.current = active;
  }, [active, channelId, runId, client]);

  const run = detail.data?.run;
  const steps = detail.data?.steps ?? [];
  const files = outputs.data?.items ?? [];
  const selectedFile = selected === null ? undefined : files.find((file) => file.path === selected);
  const kind = selectedFile === undefined ? null : outputPreviewKind(selectedFile.mediaType);
  const contentPath = kind === 'markdown' || kind === 'text' ? (selectedFile?.path ?? null) : null;
  const blobPath = kind === 'image' || kind === 'pdf' ? (selectedFile?.path ?? null) : null;
  const content = useChannelRunOutputContent(channelId, runId, contentPath);
  const blob = useChannelRunOutputBlob(
    channelId,
    runId,
    blobPath,
    kind === 'image' || kind === 'pdf',
  );

  return (
    <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl!">
      <div className="min-w-0 border-b px-5 py-3.5 pr-12">
        <SheetTitle>运行详情</SheetTitle>
        <SheetDescription className="mt-1 flex flex-wrap items-center gap-2">
          <span className="font-mono">运行 {shortId(runId)}</span>
          {run ? <RunStatusBadge status={run.status} /> : null}
        </SheetDescription>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {detail.isPending ? (
          <LoadingState rows={6} />
        ) : detail.data === undefined ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="flex min-w-0 flex-col gap-5">
            {detail.isError ? (
              <PageNote
                tone="danger"
                title="刷新失败，内容仍是上次结果"
                action={
                  <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}

            <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2 text-xs">
              <Metric
                label="运行耗时"
                value={formatDuration(run?.latencyMs)}
                danger={run?.status === 'timeout'}
              />
              <Metric label="轮次" value={run?.turns ?? '—'} />
              <Metric label="成本" value={formatCost(run?.costUsd)} />
              <Metric
                label="Tokens 输入 / 输出"
                value={`${formatTokens(run?.inputTokens)} / ${formatTokens(run?.outputTokens)}`}
              />
            </div>

            {(run?.status === 'failed' || run?.status === 'timeout') && run.error ? (
              <div
                role="alert"
                className="flex items-start gap-3 border-y border-line bg-danger-soft px-4 py-3"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg">
                    运行{runStatusLabel[run.status]}
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-5 text-muted-foreground">
                    {run.error}
                  </pre>
                </div>
                <CopyButton value={run.error} label="复制错误" />
              </div>
            ) : null}

            {questions.isError ? (
              <ErrorState
                title="提问状态没有加载出来"
                error={questions.error}
                onRetry={() => void questions.refetch()}
              />
            ) : null}

            {(questions.data?.items.length ?? 0) > 0 ? (
              <section className="flex min-w-0 flex-col gap-3" aria-label="提问">
                <h2 className="text-sm font-medium text-fg">提问</h2>
                {(questions.data?.items ?? []).map((question) => (
                  <RunQuestionCard
                    key={question.requestId}
                    question={question}
                    live={canRespond}
                    respond={respond}
                    readOnlyNote="由运行发起者或频道管理员回答。"
                  />
                ))}
              </section>
            ) : null}

            <section className="flex min-w-0 flex-col gap-2" aria-label="过程">
              <h2 className="text-sm font-medium text-fg">过程</h2>
              {steps.length === 0 ? (
                <EmptyState title="还没有事件" />
              ) : (
                <Accordion>
                  {steps.map((step, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 步骤没有稳定 id，位置即身份
                    <AccordionItem key={`${index}-${step.at}`} value={String(index)}>
                      <AccordionTrigger className="min-w-0 gap-2">
                        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="w-5 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                            {stepName(step)}
                          </span>
                          <span
                            className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground"
                            title={`事件时间：${formatDateTime(step.at)}`}
                          >
                            {formatDateTime(step.at)}
                          </span>
                        </span>
                      </AccordionTrigger>
                      <AccordionContent>
                        <StepInspector step={step} index={index} live={canRespond} />
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
            </section>

            <section className="flex min-w-0 flex-col gap-3" aria-label="成果">
              <h2 className="text-sm font-medium text-fg">成果</h2>
              {outputs.isError && outputs.data !== undefined ? (
                <PageNote
                  tone="danger"
                  title="刷新失败，内容仍是上次结果"
                  action={
                    <Button variant="outline" size="sm" onClick={() => void outputs.refetch()}>
                      重试
                    </Button>
                  }
                />
              ) : null}
              {outputs.isPending ? (
                <LoadingState rows={2} />
              ) : outputs.data === undefined ? (
                <ErrorState
                  title="成果没有加载出来"
                  error={outputs.error}
                  onRetry={() => void outputs.refetch()}
                />
              ) : files.length === 0 ? (
                <EmptyState title="本轮没有成果文件" />
              ) : (
                <>
                  <ul className="flex min-w-0 flex-col">
                    {files.map((file) => (
                      <li
                        key={file.path}
                        className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line py-2 last:border-b-0"
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 min-w-0 flex-1 justify-start gap-1.5 px-1.5 font-normal"
                          title={file.path}
                          aria-current={selected === file.path ? 'true' : undefined}
                          onClick={() => setSelected(file.path)}
                        >
                          <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{file.path}</span>
                        </Button>
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                          {formatBytes(file.size)}
                        </span>
                        <a
                          href={api.channelRunOutputDownloadUrl(channelId, runId, file.path)}
                          download={file.path.split('/').at(-1) ?? file.path}
                          aria-label={`下载 ${file.path}`}
                          className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        >
                          <Download data-icon="inline-start" aria-hidden="true" />
                          下载
                        </a>
                      </li>
                    ))}
                  </ul>
                  {outputs.data?.nextBefore ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="self-start text-muted-foreground"
                      disabled={outputs.isFetchingNextPage}
                      onClick={() => void outputs.fetchNextPage()}
                    >
                      {outputs.isFetchingNextPage ? '正在加载…' : '加载更多成果'}
                    </Button>
                  ) : null}
                  {selectedFile === undefined ? null : (
                    <div className="min-w-0">
                      {kind === 'binary' ? (
                        <p className="rounded-card border border-dashed border-line-strong/70 px-3 py-4 text-sm text-muted-foreground">
                          该文件不能直接预览，请下载原件。
                        </p>
                      ) : kind === 'image' || kind === 'pdf' ? (
                        blob.isError ? (
                          <ErrorState
                            error={blob.error}
                            title="这个文件无法在面板内预览"
                            onRetry={() => void blob.refetch()}
                          />
                        ) : blob.isPending ? (
                          <LoadingState rows={3} />
                        ) : blob.data ? (
                          kind === 'image' ? (
                            <BlobImage
                              blob={blob.data}
                              alt={selectedFile.path}
                              className="max-h-[50vh] w-full rounded-card border border-line object-contain"
                            />
                          ) : (
                            <BlobPdf
                              blob={blob.data}
                              title={selectedFile.path}
                              className="h-[50vh] w-full rounded-card border border-line"
                            />
                          )
                        ) : null
                      ) : content.isPending ? (
                        <LoadingState rows={3} />
                      ) : content.isError ? (
                        <ErrorState
                          error={content.error}
                          title="这个文件无法在面板内预览"
                          onRetry={() => void content.refetch()}
                        />
                      ) : content.data ? (
                        kind === 'markdown' ? (
                          <Markdown text={content.data.content} staticContent />
                        ) : (
                          <CodeBlock
                            code={content.data.content}
                            maxHeight="50vh"
                            copyable={false}
                            json={
                              selectedFile.mediaType === 'application/json' ||
                              /\.json$/i.test(selectedFile.path)
                            }
                          />
                        )
                      ) : null}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </SheetContent>
  );
}

function Metric({ label, value, danger }: { label: string; value: ReactNode; danger?: boolean }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-1.5">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span
        className={danger ? 'font-mono tabular-nums text-danger' : 'font-mono tabular-nums text-fg'}
      >
        {value}
      </span>
    </span>
  );
}
