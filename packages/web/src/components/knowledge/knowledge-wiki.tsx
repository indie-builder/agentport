import { useQueryClient } from '@tanstack/react-query';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { BookOpen, FileText, GitCompare, History, Link2, Network, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import type {
  KnowledgeWikiDiff,
  KnowledgeWikiPageDetail,
  KnowledgeWikiVersion,
} from '../../lib/api.js';
import { errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import {
  knowledgeKeys,
  useCreateKnowledgeWikiPage,
  useDrainPages,
  useGenerateKnowledgeWikiPage,
  useKnowledgeJobs,
  useKnowledgeWikiDiff,
  useKnowledgeWikiGraph,
  useKnowledgeWikiLinks,
  useKnowledgeWikiPage,
  useKnowledgeWikiPages,
  useLoadOlderKnowledgeWikiVersions,
  usePublishKnowledgeWikiVersion,
  useRollbackKnowledgeWikiPage,
  useSaveKnowledgeWikiPage,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { CodeBlock } from '../code-block.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { DialogShell } from '../dialog-shell.js';
import { Markdown } from '../markdown.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../motion-collapsible.js';
import { PageNote, PageSection } from '../page.js';
import { ReaderToolbar } from '../reader-toolbar.js';
import { RequiredMark } from '../required-mark.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { StatusBadge } from '../status-badge.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../ui/number-input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { Textarea } from '../ui/textarea.js';
import {
  DraftGuardDialogs,
  jobStatusLabel,
  pageStatusLabel,
  useDraftGuard,
} from './knowledge-shared.js';
import { KnowledgeWikiGraph } from './knowledge-wiki-graph.js';

type WikiPageSummary = Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>;

function wikiTreePages(pages: WikiPageSummary[]): Array<{ page: WikiPageSummary; depth: number }> {
  const byParent = new Map<string | null, WikiPageSummary[]>();
  for (const page of pages) {
    const parentId = page.parentId ?? null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(page);
    byParent.set(parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title),
    );
  }
  const rows: Array<{ page: WikiPageSummary; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const page of byParent.get(parentId) ?? []) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      rows.push({ page, depth });
      walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const page of pages) {
    if (!seen.has(page.id)) rows.push({ page, depth: 0 });
  }
  return rows;
}

export function WikiTab({
  baseId,
  caps,
  pageId,
  onSelect,
}: {
  baseId: string;
  caps: { content: boolean; execute: boolean; publish: boolean };
  pageId: string | undefined;
  onSelect: (pageId: string) => void;
}) {
  const pages = useKnowledgeWikiPages(baseId);
  useDrainPages(pages);
  const [creating, setCreating] = useState(false);
  const [createdPage, setCreatedPage] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [focusPageId, setFocusPageId] = useState<string | null>(null);
  const pageListRef = useRef<HTMLUListElement>(null);
  const graph = useKnowledgeWikiGraph(baseId, graphOpen);
  useEffect(() => {
    if (creating || createdPage === null) return;
    setGraphOpen(false);
    onSelect(createdPage);
    setCreatedPage(null);
  }, [createdPage, creating, onSelect]);
  const pageItems = pages.data ?? [];
  useEffect(() => {
    if (focusPageId === null || pageItems.length === 0) return;
    const item = pageListRef.current?.querySelector<HTMLButtonElement>(
      `[data-page-id="${focusPageId}"]`,
    );
    if (!item) return;
    item.focus();
    setFocusPageId(null);
  }, [focusPageId, pageItems.length]);

  return (
    <div className="grid min-w-0 gap-5 md:grid-cols-[220px_minmax(0,1fr)] md:items-start">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-fg">页面</h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={graphOpen}
              onClick={() => setGraphOpen((open) => !open)}
            >
              {graphOpen ? (
                <BookOpen data-icon="inline-start" aria-hidden="true" />
              ) : (
                <Network data-icon="inline-start" aria-hidden="true" />
              )}
              {graphOpen ? '页面' : '图谱'}
            </Button>
            {caps.content ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="新建 Wiki 页面"
                onClick={() => setCreating(true)}
              >
                <Plus />
              </Button>
            ) : null}
          </div>
        </div>
        {pages.isPending ? <LoadingState rows={3} /> : null}
        {pages.isError ? (
          <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
        ) : null}
        {pages.isFetchNextPageError ? (
          <Button variant="outline" size="sm" onClick={() => void pages.fetchNextPage()}>
            重试加载其余页面
          </Button>
        ) : null}
        {pages.data && pageItems.length === 0 ? (
          <EmptyState
            variant="idle"
            scale="inline"
            icon={<BookOpen aria-hidden="true" />}
            title="还没有 Wiki 页面"
          />
        ) : null}
        {pageItems.length > 0 ? (
          <ul ref={pageListRef} className="flex flex-col">
            {wikiTreePages(pageItems).map(({ page, depth }) => (
              <li key={page.id}>
                <ButtonPrimitive
                  data-page-id={page.id}
                  aria-current={page.id === pageId ? 'true' : undefined}
                  onClick={() => {
                    setGraphOpen(false);
                    onSelect(page.id);
                  }}
                  style={{ paddingLeft: `${8 + depth * 12}px` }}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-item py-1.5 pr-2 text-left text-sm transition-colors duration-150 ease-out-soft',
                    page.id === pageId
                      ? 'bg-selected font-medium text-selected-foreground'
                      : 'text-muted-foreground hover:bg-hover hover:text-fg',
                  )}
                >
                  <span className="truncate">{page.title}</span>
                  <span className="truncate text-xs">{pageStatusLabel[page.status]}</span>
                </ButtonPrimitive>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {graphOpen ? (
          graph.isPending ? (
            <LoadingState rows={4} />
          ) : graph.isError ? (
            <ErrorState
              title="图谱没有加载出来"
              error={graph.error}
              onRetry={() => void graph.refetch()}
            />
          ) : graph.data ? (
            <KnowledgeWikiGraph
              graph={graph.data}
              onSelectPage={(id) => {
                setGraphOpen(false);
                onSelect(id);
                setFocusPageId(id);
              }}
              onCreatePage={caps.content ? () => setCreating(true) : undefined}
            />
          ) : null
        ) : pageId ? (
          <WikiPageEditor
            key={pageId}
            baseId={baseId}
            caps={caps}
            pageId={pageId}
            pages={pageItems}
            onSelect={onSelect}
          />
        ) : (
          <EmptyState
            variant="idle"
            scale="panel"
            icon={<BookOpen aria-hidden="true" />}
            title={pageItems.length === 0 ? '创建第一篇 Wiki 页面' : '选择左侧页面开始编辑'}
            action={
              caps.content ? (
                <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                  新建页面
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
      {creating ? (
        <CreateWikiPageDialog
          baseId={baseId}
          pages={pageItems}
          initialParentId={null}
          onClose={() => setCreating(false)}
          onCreated={(page) => {
            setCreating(false);
            setCreatedPage(page.id);
          }}
        />
      ) : null}
    </div>
  );
}

function WikiPageEditor({
  baseId,
  caps,
  pageId,
  pages,
  onSelect,
}: {
  baseId: string;
  caps: { content: boolean; execute: boolean; publish: boolean };
  pageId: string;
  pages: WikiPageSummary[];
  onSelect: (pageId: string) => void;
}) {
  const detail = useKnowledgeWikiPage(pageId);
  const generate = useGenerateKnowledgeWikiPage();
  const publish = usePublishKnowledgeWikiVersion(baseId);
  const rollback = useRollbackKnowledgeWikiPage(baseId);
  const loadOlder = useLoadOlderKnowledgeWikiVersions();
  const jobs = useKnowledgeJobs(baseId);
  const client = useQueryClient();
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<'read' | 'source'>('read');
  const [generateJobId, setGenerateJobId] = useState<string | null>(null);
  const settledJobRef = useRef<string | null>(null);
  const [publishTarget, setPublishTarget] = useState<KnowledgeWikiVersion | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<KnowledgeWikiVersion | null>(null);
  const [previewing, setPreviewing] = useState<KnowledgeWikiVersion | null>(null);
  const previewDialog = useDialogClose(() => setPreviewing(null), previewing !== null);
  const [editing, setEditing] = useState<{
    versionId: string | null;
    markdown: string;
  } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [diffPair, setDiffPair] = useState<{ from: string; to: string } | null>(null);
  const [olderVersions, setOlderVersions] = useState<KnowledgeWikiVersion[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const pending = generate.isPending || publish.isPending || rollback.isPending;
  const page = detail.data;
  const versions = [...(page?.versions ?? []), ...olderVersions];
  const currentVersion = versions.find((version) => version.id === page?.currentVersionId);
  const hasCurrent = page?.currentVersionId !== null && page?.currentVersionId !== undefined;
  const displayVersion = currentVersion ?? (hasCurrent ? undefined : versions[0]);
  const nextCursor = olderCursor === undefined ? page?.nextCursor : olderCursor;
  const currentOutsidePage =
    hasCurrent && currentVersion === undefined && nextCursor !== null && nextCursor !== undefined;
  const generateJob = generateJobId
    ? jobs.data?.find((job) => job.id === generateJobId)
    : undefined;

  useEffect(() => {
    if (!generateJob || !generateJobId || settledJobRef.current === generateJobId) return;
    if (
      generateJob.status !== 'succeeded' &&
      generateJob.status !== 'failed' &&
      generateJob.status !== 'cancelled'
    ) {
      return;
    }
    settledJobRef.current = generateJobId;
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPage(pageId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiLinks(pageId) });
  }, [baseId, client, generateJob, generateJobId, pageId]);

  useEffect(() => {
    if (!currentOutsidePage || nextCursor === null || nextCursor === undefined) return;
    if (loadOlder.isPending || loadOlder.isError) return;
    loadOlder.mutate(
      { pageId, cursor: nextCursor },
      {
        onSuccess: (result) => {
          setOlderVersions((previous) => [...previous, ...result.items]);
          setOlderCursor(result.nextCursor);
        },
        onError: toastError,
      },
    );
  }, [currentOutsidePage, loadOlder, nextCursor, pageId]);

  if (detail.isPending) return <LoadingState rows={4} />;
  if (!page) {
    if (detail.isError) {
      return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
    }
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {detail.isError ? (
        <ErrorState
          title="Wiki 页面没有刷新成功"
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      ) : null}
      <ReaderToolbar
        identity={
          <span className="block truncate" title={page.title}>
            {page.title}
          </span>
        }
        meta={
          <>
            <StatusBadge
              tone={
                page.status === 'published'
                  ? 'success'
                  : page.status === 'failed'
                    ? 'danger'
                    : 'outline'
              }
            >
              {pageStatusLabel[page.status]}
            </StatusBadge>
            {hasCurrent ? null : <StatusBadge tone="warn">草稿预览</StatusBadge>}
            {hasCurrent && versions[0] && versions[0].id !== page.currentVersionId ? (
              <StatusBadge tone="outline">有版本未设为当前</StatusBadge>
            ) : null}
            <span>{formatRelative(page.updatedAt)}</span>
          </>
        }
        {...(displayVersion ? { mode, onModeChange: setMode } : {})}
        {...(displayVersion
          ? { copy: { value: displayVersion.markdown, label: `复制 ${page.title}` } }
          : {})}
        actions={
          <>
            {caps.publish ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setOrganizing(true)}
              >
                组织
              </Button>
            ) : null}
            {caps.publish ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  setEditing(
                    versions[0]
                      ? { versionId: versions[0].id, markdown: versions[0].markdown }
                      : { versionId: null, markdown: '' },
                  )
                }
              >
                编辑正文
              </Button>
            ) : null}
            {caps.execute ? (
              <Button
                size="sm"
                disabled={pending}
                aria-busy={generate.isPending}
                onClick={() =>
                  generate.mutate(
                    { pageId, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) },
                    {
                      onSuccess: (result) => {
                        setGenerateJobId(result.jobId);
                        void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
                        toastSuccess('已提交生成任务');
                      },
                      onError: toastError,
                    },
                  )
                }
              >
                {hasCurrent ? '重新生成' : '生成草稿'}
              </Button>
            ) : null}
          </>
        }
      />
      {generateJob ? (
        <PageNote
          title={`生成任务 ${jobStatusLabel[generateJob.status]}`}
          description={generateJob.step ?? `进度 ${generateJob.progress}%`}
        />
      ) : null}
      <Field className="gap-1.5">
        <FieldLabel htmlFor="wiki-instruction">生成指令</FieldLabel>
        <Input
          id="wiki-instruction"
          value={instruction}
          disabled={pending}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="可选，说明这次生成要补充什么"
        />
      </Field>
      {displayVersion ? (
        mode === 'read' ? (
          <Markdown text={displayVersion.markdown} />
        ) : (
          <CodeBlock code={displayVersion.markdown} lineNumbers maxHeight="60vh" copyable={false} />
        )
      ) : currentOutsidePage ? (
        <LoadingState rows={3} />
      ) : hasCurrent ? (
        <ErrorText>当前发布版本已不可读。</ErrorText>
      ) : (
        <EmptyState
          variant="idle"
          scale="inline"
          icon={<FileText aria-hidden="true" />}
          title="还没有正文"
        />
      )}
      <WikiLinks pageId={pageId} pages={pages} onSelect={onSelect} />
      <PageSection title="版本" divided>
        {versions.length === 0 && !hasCurrent ? (
          <EmptyState
            variant="idle"
            scale="inline"
            icon={<History aria-hidden="true" />}
            title="还没有版本"
          />
        ) : null}
        <ul className="flex flex-col">
          {versions.map((version, index) => {
            const older = versions[index + 1];
            const isCurrent = version.id === page.currentVersionId;
            return (
              <li
                key={version.id}
                className="flex flex-wrap items-center gap-2 border-b py-2 text-xs last:border-b-0"
              >
                <span className="font-mono text-fg">v{version.version}</span>
                <span className="text-muted-foreground">
                  {version.generatedBy === 'sdk' ? version.model : '人工编辑'}
                </span>
                <span className="text-muted-foreground">{formatDateTime(version.createdAt)}</span>
                <span className="text-2xs text-muted-foreground">
                  {version.sourceChunkIds.length} 个来源
                </span>
                {isCurrent ? (
                  <StatusBadge tone="success">当前发布</StatusBadge>
                ) : (
                  <StatusBadge tone="outline">未设为当前版本</StatusBadge>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setPreviewing(version)}>
                    预览
                  </Button>
                  {isCurrent ? null : (
                    <>
                      {older ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDiffPair({ from: older.id, to: version.id })}
                        >
                          <GitCompare data-icon="inline-start" aria-hidden="true" /> 对比上一版
                        </Button>
                      ) : null}
                      {caps.publish ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setPublishTarget(version)}
                          >
                            发布此版本
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setRollbackTarget(version)}
                          >
                            回退到此版本
                          </Button>
                        </>
                      ) : null}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {nextCursor ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={loadOlder.isPending}
            aria-busy={loadOlder.isPending}
            onClick={() =>
              loadOlder.mutate(
                { pageId, cursor: nextCursor },
                {
                  onSuccess: (result) => {
                    setOlderVersions((previous) => [...previous, ...result.items]);
                    setOlderCursor(result.nextCursor);
                  },
                  onError: toastError,
                },
              )
            }
          >
            {loadOlder.isPending ? '加载中…' : '加载更早版本'}
          </Button>
        ) : null}
      </PageSection>
      <ConfirmDialog
        open={publishTarget !== null}
        title="发布 Wiki 版本"
        description={
          publishTarget
            ? `将 v${publishTarget.version} 设为当前发布版本；当前版本与历史版本都保留。`
            : ''
        }
        confirmLabel="发布"
        confirmDisabled={pending}
        tone="default"
        onClose={() => setPublishTarget(null)}
        onConfirm={async () => {
          if (!publishTarget) return;
          await publish.mutateAsync({ pageId, versionId: publishTarget.id });
          void client.invalidateQueries({ queryKey: knowledgeKeys.wikiLinks(pageId) });
          toastSuccess('已发布');
        }}
      />
      <ConfirmDialog
        open={rollbackTarget !== null}
        title="回退 Wiki 版本"
        description={
          rollbackTarget
            ? `将把 v${rollbackTarget.version} 的内容复制成新的当前版本；历史版本保留。来源失效时不会回退。`
            : ''
        }
        confirmLabel="回退"
        confirmDisabled={pending}
        onClose={() => setRollbackTarget(null)}
        onConfirm={async () => {
          if (!rollbackTarget) return;
          await rollback.mutateAsync({ pageId, versionId: rollbackTarget.id });
          void client.invalidateQueries({ queryKey: knowledgeKeys.wikiLinks(pageId) });
          toastSuccess('已回退');
        }}
      />
      {previewing ? (
        <Dialog
          open={previewDialog.open}
          onOpenChange={(next) => (next ? undefined : previewDialog.close())}
          onOpenChangeComplete={previewDialog.onOpenChangeComplete}
        >
          <DialogShell title={`预览 v${previewing.version}`} className="max-w-215 sm:max-w-215">
            <Markdown text={previewing.markdown} />
          </DialogShell>
        </Dialog>
      ) : null}
      {editing ? (
        <WikiMarkdownDialog
          baseId={baseId}
          pageId={pageId}
          expectedVersion={editing.versionId}
          markdown={editing.markdown}
          onClose={() => setEditing(null)}
          onReload={async () => {
            await detail.refetch({ throwOnError: true });
          }}
        />
      ) : null}
      {organizing ? (
        <WikiOrganizeDialog
          baseId={baseId}
          page={page}
          pages={pages}
          onClose={() => setOrganizing(false)}
        />
      ) : null}
      {diffPair ? (
        <WikiDiffDialog
          pageId={pageId}
          fromVersionId={diffPair.from}
          toVersionId={diffPair.to}
          onClose={() => setDiffPair(null)}
        />
      ) : null}
    </div>
  );
}

function WikiLinks({
  pageId,
  pages,
  onSelect,
}: {
  pageId: string;
  pages: WikiPageSummary[];
  onSelect: (pageId: string) => void;
}) {
  const links = useKnowledgeWikiLinks(pageId);
  const titleOf = (id: string): string => pages.find((page) => page.id === id)?.title ?? id;
  if (links.isPending) return null;
  if (links.isError) {
    return (
      <ErrorState
        title="链接没有加载出来"
        error={links.error}
        onRetry={() => void links.refetch()}
      />
    );
  }
  if (!links.data) return null;
  if (links.data.outgoing.length === 0 && links.data.incoming.length === 0) return null;
  return (
    <Collapsible className="rounded-item border border-line px-3 py-2">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 text-sm text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden="true" /> 链接
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">出链</span>
          {links.data.outgoing.length === 0 ? (
            <span className="text-sm text-muted-foreground">无</span>
          ) : (
            links.data.outgoing.map((link) =>
              link.targetPageId === null ? (
                <span
                  key={`missing:${link.anchor ?? ''}`}
                  className="text-sm text-muted-foreground"
                >
                  目标页不存在{link.anchor ? `#${link.anchor}` : ''}
                </span>
              ) : (
                <Button
                  key={`${link.targetPageId}:${link.anchor ?? ''}`}
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  onClick={() => onSelect(link.targetPageId ?? '')}
                >
                  {titleOf(link.targetPageId)}
                  {link.anchor ? (
                    <span className="text-muted-foreground">#{link.anchor}</span>
                  ) : null}
                </Button>
              ),
            )
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">入链</span>
          {links.data.incoming.length === 0 ? (
            <span className="text-sm text-muted-foreground">无</span>
          ) : (
            links.data.incoming.map((link) => (
              <Button
                key={`${link.sourcePageId}:${link.anchor ?? ''}`}
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => onSelect(link.sourcePageId)}
              >
                {titleOf(link.sourcePageId)}
                {link.anchor ? <span className="text-muted-foreground">#{link.anchor}</span> : null}
              </Button>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function WikiPositionField({
  id,
  value,
  disabled,
  invalid,
  inputRef,
  onChange,
  onBlur,
}: {
  id: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  inputRef: (instance: HTMLInputElement | null) => void;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const trimmed = value.trim();
  const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
  return (
    <Field className="gap-1.5" data-invalid={invalid}>
      <FieldLabel htmlFor={id}>排序</FieldLabel>
      <NumberInput
        value={Number.isFinite(parsed) ? parsed : null}
        step={1}
        disabled={disabled}
        onValueChange={(next, details) => {
          if (details.reason === 'input-commit') {
            details.cancel();
            return;
          }
          onChange(next === null ? '' : String(next));
        }}
      >
        <NumberInputGroup>
          <NumberInputDecrement />
          <NumberInputControl ref={inputRef} id={id} inputMode="numeric" onBlur={onBlur} />
          <NumberInputIncrement />
        </NumberInputGroup>
      </NumberInput>
      <FieldError id={`${id}-error`}>{invalid ? '需为非负整数' : null}</FieldError>
    </Field>
  );
}

const wikiOrganizeFormSchema = z.object({
  parentId: z.string(),
  position: z.string(),
});
type WikiOrganizeFormValues = z.infer<typeof wikiOrganizeFormSchema>;

function WikiOrganizeDialog({
  baseId,
  page,
  pages,
  onClose: onClosed,
}: {
  baseId: string;
  page: KnowledgeWikiPageDetail;
  pages: WikiPageSummary[];
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const save = useSaveKnowledgeWikiPage(baseId);
  const { control, handleSubmit, watch, formState } = useZodForm(wikiOrganizeFormSchema, {
    defaultValues: { parentId: page.parentId ?? 'null', position: String(page.position ?? 0) },
  });
  const { isDirty } = formState;
  const positionValue = watch('position');
  const [expectedVersion] = useState(() => page.versions[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const pending = save.isPending;
  const parsedPosition = Number(positionValue);
  const invalidPosition = !Number.isInteger(parsedPosition) || parsedPosition < 0;
  const dirty = isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const descendants = new Set<string>();
  const collect = (id: string): void => {
    descendants.add(id);
    for (const child of pages) if ((child.parentId ?? null) === id) collect(child.id);
  };
  collect(page.id);
  const options = [
    { value: 'null', label: '顶层' },
    ...wikiTreePages(pages.filter((item) => !descendants.has(item.id))).map(
      ({ page: item, depth }) => ({
        value: item.id,
        label: `${'　'.repeat(depth)}${item.title}`,
      }),
    ),
  ];
  const submit = handleSubmit((values: WikiOrganizeFormValues) => {
    setError(null);
    const parsed = Number(values.position);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    save.mutate(
      {
        pageId: page.id,
        patch: {
          parentId: values.parentId === 'null' ? null : values.parentId,
          position: parsed,
          expectedVersion,
        },
      },
      {
        onSuccess: () => {
          toastSuccess('Wiki 目录已更新');
          guard.finish();
        },
        onError: (reason) => setError(errorMessage(reason)),
      },
    );
  });
  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell title="组织 Wiki 页面" closeDisabled={pending}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="wiki-parent">上级页面</FieldLabel>
              <Controller
                name="parentId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    disabled={pending}
                    onValueChange={(next) => {
                      if (next !== null) field.onChange(next);
                    }}
                    items={options}
                  >
                    <SelectTrigger id="wiki-parent" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Controller
              name="position"
              control={control}
              render={({ field }) => (
                <WikiPositionField
                  id="wiki-position"
                  value={field.value}
                  disabled={pending}
                  invalid={invalidPosition}
                  inputRef={field.ref}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </FieldGroup>
          <FieldError>{error}</FieldError>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || invalidPosition} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="目录设置会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function WikiDiffDialog({
  pageId,
  fromVersionId,
  toVersionId,
  onClose: onClosed,
}: {
  pageId: string;
  fromVersionId: string;
  toVersionId: string;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const diff = useKnowledgeWikiDiff(pageId, fromVersionId, toVersionId);
  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <DialogShell title="版本贡献差异" className="max-w-215 sm:max-w-215">
        {diff.isPending ? <LoadingState rows={3} /> : null}
        {diff.isError ? <ErrorText>差异没有加载出来。</ErrorText> : null}
        {diff.data ? <DiffBody diff={diff.data} /> : null}
      </DialogShell>
    </Dialog>
  );
}

function DiffBody({ diff }: { diff: KnowledgeWikiDiff }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-success">新增行</span>
          {diff.addedLines.length === 0 ? (
            <span className="text-xs text-muted-foreground">无</span>
          ) : (
            <ul className="flex flex-col gap-0.5 font-mono text-2xs">
              {diff.addedLines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 差异行按原顺序展示
                <li key={`added-${index}`} className="whitespace-pre-wrap break-words text-success">
                  + {line}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-danger">删除行</span>
          {diff.removedLines.length === 0 ? (
            <span className="text-xs text-muted-foreground">无</span>
          ) : (
            <ul className="flex flex-col gap-0.5 font-mono text-2xs">
              {diff.removedLines.map((line) => (
                <li key={`removed-${line}`} className="whitespace-pre-wrap break-words text-danger">
                  − {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-2xs">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-fg">新增来源</span>
          <span className="text-muted-foreground">
            {diff.addedSourceChunkIds.length === 0 ? '无' : diff.addedSourceChunkIds.join(', ')}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-medium text-fg">移除来源</span>
          <span className="text-muted-foreground">
            {diff.removedSourceChunkIds.length === 0 ? '无' : diff.removedSourceChunkIds.join(', ')}
          </span>
        </div>
      </div>
    </div>
  );
}

function ErrorText({ children }: { children: string }) {
  return (
    <p role="alert" className="text-xs text-danger">
      {children}
    </p>
  );
}

function WikiMarkdownDialog({
  baseId,
  pageId,
  expectedVersion,
  markdown,
  onClose: onClosed,
  onReload,
}: {
  baseId: string;
  pageId: string;
  expectedVersion: string | null;
  markdown: string;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const save = useSaveKnowledgeWikiPage(baseId);
  const client = useQueryClient();
  const [value, setValue] = useState(markdown);
  const [error, setError] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const pending = save.isPending || reloading;
  const guard = useDraftGuard(value !== markdown, pending, onClose);

  return (
    <>
      <Dialog
        open={dialog.open}
        onOpenChangeComplete={dialog.onOpenChangeComplete}
        onOpenChange={guardedOpenChange(pending, guard.close)}
      >
        <DialogShell title="编辑 Wiki 正文" closeDisabled={pending}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              save.mutate(
                { pageId, patch: { markdown: value, expectedVersion } },
                {
                  onSuccess: () => {
                    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiLinks(pageId) });
                    toastSuccess('Wiki 草稿已保存，发布后才会上线');
                    guard.finish();
                  },
                  onError: (reason) => {
                    setError(errorMessage(reason));
                  },
                },
              );
            }}
          >
            <Field className="gap-1.5" data-invalid={error !== null}>
              <FieldLabel htmlFor="knowledge-wiki-markdown">Markdown</FieldLabel>
              <Textarea
                id="knowledge-wiki-markdown"
                value={value}
                rows={14}
                disabled={pending}
                aria-invalid={error !== null}
                aria-describedby={error !== null ? 'knowledge-wiki-markdown-error' : undefined}
                onChange={(event) => setValue(event.target.value)}
                className="font-mono"
              />
              <FieldError id="knowledge-wiki-markdown-error">{error}</FieldError>
            </Field>
            <div className="flex justify-end gap-2">
              {error ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setConfirmReload(true);
                    setReloadError(null);
                  }}
                >
                  重新加载
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
              <Button
                type="submit"
                disabled={pending || value.trim() === '' || value === markdown}
                aria-busy={pending}
              >
                {pending ? '保存中…' : '保存草稿'}
              </Button>
            </div>
          </form>
          <DraftGuardDialogs guard={guard} draft="Wiki 正文草稿会丢失。" pending={pending} />
        </DialogShell>
      </Dialog>
      <ConfirmDialog
        open={confirmReload}
        title="重新加载 Wiki 正文"
        description="当前草稿会被放弃，编辑器改为显示最新已发布版本。"
        confirmLabel="重新加载"
        confirmDisabled={pending}
        onClose={() => {
          setConfirmReload(false);
          setReloadError(null);
        }}
        onConfirm={async () => {
          setReloadError(null);
          setReloading(true);
          try {
            await onReload();
            dialog.finish(() => {
              guard.finish();
              onClosed();
            });
          } finally {
            setReloading(false);
          }
        }}
        onError={(error) => setReloadError(errorMessage(error))}
      >
        {reloadError ? <FieldError>{reloadError}</FieldError> : null}
      </ConfirmDialog>
    </>
  );
}

const wikiPageFormSchema = z.object({
  title: z.string(),
  slug: z.string(),
  parentId: z.string(),
  position: z.string(),
});
type WikiPageFormValues = z.infer<typeof wikiPageFormSchema>;

function CreateWikiPageDialog({
  baseId,
  pages,
  initialParentId,
  onClose: onClosed,
  onCreated,
}: {
  baseId: string;
  pages: WikiPageSummary[];
  initialParentId: string | null;
  onClose: () => void;
  onCreated: (page: { id: string }) => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateKnowledgeWikiPage(baseId);
  const { register, control, handleSubmit, watch, formState } = useZodForm(wikiPageFormSchema, {
    defaultValues: { title: '', slug: '', parentId: initialParentId ?? 'null', position: '0' },
  });
  const { isDirty } = formState;
  const titleValue = watch('title');
  const slugValue = watch('slug');
  const positionValue = watch('position');
  const slugValid = /^[a-z0-9][a-z0-9-_]*$/.test(slugValue);
  const pending = create.isPending;
  const parsedPosition = Number(positionValue);
  const invalidPosition = !Number.isInteger(parsedPosition) || parsedPosition < 0;
  const dirty = isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const parentOptions = [
    { value: 'null', label: '顶层' },
    ...wikiTreePages(pages).map(({ page, depth }) => ({
      value: page.id,
      label: `${'　'.repeat(depth)}${page.title}`,
    })),
  ];
  const submit = handleSubmit((values: WikiPageFormValues) => {
    const parsed = Number(values.position);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    create.mutate(
      {
        slug: values.slug,
        title: values.title.trim(),
        parentId: values.parentId === 'null' ? null : values.parentId,
        position: parsed,
      },
      {
        onSuccess: (page) => {
          toastSuccess('Wiki 页面已创建');
          guard.finish();
          dialog.finish(() => onCreated(page));
        },
        onError: toastError,
      },
    );
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell title="新建 Wiki 页面" closeDisabled={pending}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <FieldGroup>
            <Field className="gap-1.5" data-invalid={slugValue !== '' && !slugValid}>
              <FieldLabel htmlFor="wiki-title">
                标题 <RequiredMark />
              </FieldLabel>
              <Input id="wiki-title" {...register('title')} disabled={pending} />
            </Field>
            <Field className="gap-1.5" data-invalid={slugValue !== '' && !slugValid}>
              <FieldLabel htmlFor="wiki-slug">
                Slug <RequiredMark />
              </FieldLabel>
              <Input
                id="wiki-slug"
                {...register('slug')}
                disabled={pending}
                aria-invalid={slugValue !== '' && !slugValid}
                aria-describedby={slugValue !== '' && !slugValid ? 'wiki-slug-error' : undefined}
                className="font-mono"
              />
              {slugValue !== '' && !slugValid ? (
                <FieldError id="wiki-slug-error">仅允许小写字母、数字、- 和 _</FieldError>
              ) : null}
            </Field>
          </FieldGroup>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="wiki-create-parent">上级页面</FieldLabel>
              <Controller
                name="parentId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    disabled={pending}
                    onValueChange={(next) => {
                      if (next !== null) field.onChange(next);
                    }}
                    items={parentOptions}
                  >
                    <SelectTrigger id="wiki-create-parent" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {parentOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Controller
              name="position"
              control={control}
              render={({ field }) => (
                <WikiPositionField
                  id="wiki-create-position"
                  value={field.value}
                  disabled={pending}
                  invalid={invalidPosition}
                  inputRef={field.ref}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={pending || titleValue.trim() === '' || !slugValid || invalidPosition}
              aria-busy={pending}
            >
              {pending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="Wiki 页面草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
