import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, GitCompare, Link2, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  KnowledgeWikiDiff,
  KnowledgeWikiPageDetail,
  KnowledgeWikiVersion,
} from '../lib/api.js';
import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import {
  knowledgeKeys,
  useCreateKnowledgeWikiPage,
  useDrainPages,
  useGenerateKnowledgeWikiPage,
  useKnowledgeJobs,
  useKnowledgeWikiDiff,
  useKnowledgeWikiLinks,
  useKnowledgeWikiPage,
  useKnowledgeWikiPages,
  useLoadOlderKnowledgeWikiVersions,
  usePublishKnowledgeWikiVersion,
  useRollbackKnowledgeWikiPage,
  useSaveKnowledgeWikiPage,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { CodeBlock } from './code-block.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DialogShell } from './dialog-shell.js';
import {
  DraftGuardDialogs,
  jobStatusLabel,
  pageStatusLabel,
  useDraftGuard,
} from './knowledge-shared.js';
import { Markdown } from './markdown.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './motion-collapsible.js';
import { PageNote, PageSection } from './page.js';
import { ReaderToolbar } from './reader-toolbar.js';
import { RequiredMark } from './required-mark.js';
import { EmptyState, ErrorState, InlineEmpty, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel } from './ui/field.js';
import { Input } from './ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';
import { Textarea } from './ui/textarea.js';

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
  // 坏父级或残留循环不吞页面：未挂到树上的仍以顶层行展示。
  for (const page of pages) {
    if (!seen.has(page.id)) rows.push({ page, depth: 0 });
  }
  return rows;
}

export function WikiTab({
  baseId,
  pageId,
  onSelect,
}: {
  baseId: string;
  pageId: string | undefined;
  onSelect: (pageId: string) => void;
}) {
  const pages = useKnowledgeWikiPages(baseId);
  useDrainPages(pages);
  const [creating, setCreating] = useState(false);
  // 等弹层卸载、blocker 注销后再选中新页面，避免导航被创建弹层的旧 dirty/pending 拦下。
  const [createdPage, setCreatedPage] = useState<string | null>(null);
  useEffect(() => {
    if (creating || createdPage === null) return;
    onSelect(createdPage);
    setCreatedPage(null);
  }, [createdPage, creating, onSelect]);
  const pageItems = pages.data ?? [];

  return (
    <div className="grid min-w-0 gap-5 md:grid-cols-[220px_minmax(0,1fr)] md:items-start">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-fg">页面</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="新建 Wiki 页面"
            onClick={() => setCreating(true)}
          >
            <Plus />
          </Button>
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
        {pages.data && pageItems.length === 0 ? <InlineEmpty>还没有 Wiki 页面</InlineEmpty> : null}
        {pageItems.length > 0 ? (
          <ul className="flex flex-col">
            {wikiTreePages(pageItems).map(({ page, depth }) => (
              <li key={page.id}>
                <button
                  type="button"
                  aria-current={page.id === pageId ? 'true' : undefined}
                  onClick={() => onSelect(page.id)}
                  style={{ paddingLeft: `${8 + depth * 12}px` }}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-item py-1.5 pr-2 text-left text-sm transition-colors',
                    page.id === pageId
                      ? 'bg-selected font-medium text-selected-foreground'
                      : 'text-muted-foreground hover:bg-hover hover:text-fg',
                  )}
                >
                  <span className="truncate">{page.title}</span>
                  <span className="truncate text-2xs">{pageStatusLabel[page.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {pageId ? (
          <WikiPageEditor
            key={pageId}
            baseId={baseId}
            pageId={pageId}
            pages={pageItems}
            onSelect={onSelect}
          />
        ) : (
          <EmptyState
            icon={<BookOpen className="size-5" />}
            title="选择一个页面开始编辑"
            action={
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                新建页面
              </Button>
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
  pageId,
  pages,
  onSelect,
}: {
  baseId: string;
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
  // 有 currentVersionId 时只显示该版本；当前版本落在更早分页时先读取，绝不把 versions[0] 当成当前。
  const displayVersion = currentVersion ?? (hasCurrent ? undefined : versions[0]);
  // 首屏游标只在还没请求过更早版本时用；之后由 olderVersions 自己的游标接管。
  const nextCursor = olderCursor === undefined ? page?.nextCursor : olderCursor;
  const currentOutsidePage =
    hasCurrent && currentVersion === undefined && nextCursor !== null && nextCursor !== undefined;
  // 只跟本次提交返回的任务，其他页面的生成任务不会显示在这里。
  const generateJob = generateJobId
    ? jobs.data?.find((job) => job.id === generateJobId)
    : undefined;

  // 任务跨过终态时失效当前页面与列表，只做一次；轮询本身不触发失效。
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

  // 当前发布版本被新版本挤出第一页时自动往下取，直到读到它或版本列表结束。
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
  // 已有页面数据时，刷新失败不能整块替换编辑器，否则会丢掉正在编辑的草稿。
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
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setOrganizing(true)}
            >
              组织
            </Button>
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
                      // Pick up the new job once so its polling starts; terminal handling comes from the job status.
                      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
                      toastSuccess('已提交生成任务');
                    },
                    onError: toastError,
                  },
                )
              }
            >
              重新生成
            </Button>
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
        <InlineEmpty>还没有正文</InlineEmpty>
      )}
      <WikiLinks pageId={pageId} pages={pages} onSelect={onSelect} />
      <PageSection title="版本" divided>
        {versions.length === 0 && !hasCurrent ? <InlineEmpty>还没有版本</InlineEmpty> : null}
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
        <Dialog open onOpenChange={(next) => (next ? undefined : setPreviewing(null))}>
          <DialogShell
            title={`预览 v${previewing.version}`}
            className="max-w-[860px] sm:max-w-[860px]"
          >
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
            await detail.refetch();
            setEditing(null);
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
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 text-xs text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden="true" /> 链接
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">出链</span>
          {links.data.outgoing.length === 0 ? (
            <span className="text-2xs text-muted-foreground">无</span>
          ) : (
            links.data.outgoing.map((link) =>
              link.targetPageId === null ? (
                <span
                  key={`missing:${link.anchor ?? ''}`}
                  className="text-2xs text-muted-foreground"
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
          <span className="text-2xs text-muted-foreground">入链</span>
          {links.data.incoming.length === 0 ? (
            <span className="text-2xs text-muted-foreground">无</span>
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

function WikiOrganizeDialog({
  baseId,
  page,
  pages,
  onClose,
}: {
  baseId: string;
  page: KnowledgeWikiPageDetail;
  pages: WikiPageSummary[];
  onClose: () => void;
}) {
  const save = useSaveKnowledgeWikiPage(baseId);
  const [parentId, setParentId] = useState(page.parentId ?? 'null');
  const [position, setPosition] = useState(String(page.position ?? 0));
  // 组织保存比对最新真实版本；currentVersionId 可能停在已发布旧版，不能当并发基线。
  const [expectedVersion] = useState(() => page.versions[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const pending = save.isPending;
  const dirty = parentId !== (page.parentId ?? 'null') || position !== String(page.position ?? 0);
  const guard = useDraftGuard(dirty, pending, onClose);
  // 不能把页面挂到自己或后代下；后端也会拒绝，这里先减少明显无效选项。
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
  const parsedPosition = Number(position);
  const invalidPosition = !Number.isInteger(parsedPosition) || parsedPosition < 0;
  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title="组织 Wiki 页面" closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (invalidPosition) return;
            save.mutate(
              {
                pageId: page.id,
                patch: {
                  parentId: parentId === 'null' ? null : parentId,
                  position: parsedPosition,
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
          }}
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="wiki-parent">上级页面</FieldLabel>
              <Select
                value={parentId}
                disabled={pending}
                onValueChange={(next) => {
                  if (next !== null) setParentId(next);
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
            </Field>
            <Field className="gap-1.5" data-invalid={invalidPosition}>
              <FieldLabel htmlFor="wiki-position">排序</FieldLabel>
              <Input
                id="wiki-position"
                type="number"
                min={0}
                step={1}
                value={position}
                disabled={pending}
                aria-invalid={invalidPosition}
                onChange={(event) => setPosition(event.target.value)}
              />
              <FieldError>{invalidPosition ? '需为非负整数' : null}</FieldError>
            </Field>
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
  onClose,
}: {
  pageId: string;
  fromVersionId: string;
  toVersionId: string;
  onClose: () => void;
}) {
  const diff = useKnowledgeWikiDiff(pageId, fromVersionId, toVersionId);
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell title="版本贡献差异" className="max-w-[860px] sm:max-w-[860px]">
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

/** 人工改动只写草稿版本；发布在版本列表里显式确认，不隐式改线上。 */
function WikiMarkdownDialog({
  baseId,
  pageId,
  expectedVersion,
  markdown,
  onClose,
  onReload,
}: {
  baseId: string;
  pageId: string;
  /** 打开编辑器时锁定的最新版本；null 表示新页面还没有版本，保存时创建首稿。 */
  expectedVersion: string | null;
  markdown: string;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const save = useSaveKnowledgeWikiPage(baseId);
  const client = useQueryClient();
  const [value, setValue] = useState(markdown);
  const [error, setError] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const pending = save.isPending;
  const guard = useDraftGuard(value !== markdown, pending, onClose);

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (pending) {
            details.cancel();
            return;
          }
          if (!next) guard.close();
        }}
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
                    // 保留草稿；别人已发布新版本时由用户确认后再重新加载。
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
                onChange={(event) => setValue(event.target.value)}
                className="font-mono"
              />
              <FieldError>{error}</FieldError>
            </Field>
            <div className="flex justify-end gap-2">
              {error ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setConfirmReload(true)}
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
        onClose={() => setConfirmReload(false)}
        onConfirm={async () => {
          await onReload();
          setConfirmReload(false);
        }}
      />
    </>
  );
}

function CreateWikiPageDialog({
  baseId,
  pages,
  initialParentId,
  onClose,
  onCreated,
}: {
  baseId: string;
  pages: WikiPageSummary[];
  initialParentId: string | null;
  onClose: () => void;
  onCreated: (page: { id: string }) => void;
}) {
  const create = useCreateKnowledgeWikiPage(baseId);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState(initialParentId ?? 'null');
  const [position, setPosition] = useState('0');
  const slugValid = /^[a-z0-9][a-z0-9-_]*$/.test(slug);
  const pending = create.isPending;
  const parsedPosition = Number(position);
  const invalidPosition = !Number.isInteger(parsedPosition) || parsedPosition < 0;
  const guard = useDraftGuard(
    slug !== '' || title !== '' || parentId !== 'null' || position !== '0',
    pending,
    onClose,
  );
  const parentOptions = [
    { value: 'null', label: '顶层' },
    ...wikiTreePages(pages).map(({ page, depth }) => ({
      value: page.id,
      label: `${'　'.repeat(depth)}${page.title}`,
    })),
  ];

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title="新建 Wiki 页面" closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalidPosition) return;
            create.mutate(
              {
                slug,
                title: title.trim(),
                parentId: parentId === 'null' ? null : parentId,
                position: parsedPosition,
              },
              {
                onSuccess: (page) => {
                  toastSuccess('Wiki 页面已创建');
                  guard.finish();
                  onCreated(page);
                },
                onError: toastError,
              },
            );
          }}
        >
          <FieldGroup>
            <Field className="gap-1.5" data-invalid={slug !== '' && !slugValid}>
              <FieldLabel htmlFor="wiki-title">
                标题 <RequiredMark />
              </FieldLabel>
              <Input
                id="wiki-title"
                value={title}
                disabled={pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field className="gap-1.5" data-invalid={slug !== '' && !slugValid}>
              <FieldLabel htmlFor="wiki-slug">
                Slug <RequiredMark />
              </FieldLabel>
              <Input
                id="wiki-slug"
                value={slug}
                disabled={pending}
                aria-invalid={slug !== '' && !slugValid}
                aria-describedby={slug !== '' && !slugValid ? 'wiki-slug-error' : undefined}
                onChange={(event) => setSlug(event.target.value)}
                className="font-mono"
              />
              {slug !== '' && !slugValid ? (
                <FieldError id="wiki-slug-error">仅允许小写字母、数字、- 和 _</FieldError>
              ) : null}
            </Field>
          </FieldGroup>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="wiki-create-parent">上级页面</FieldLabel>
              <Select
                value={parentId}
                disabled={pending}
                onValueChange={(next) => {
                  if (next !== null) setParentId(next);
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
            </Field>
            <Field className="gap-1.5" data-invalid={invalidPosition}>
              <FieldLabel htmlFor="wiki-create-position">排序</FieldLabel>
              <Input
                id="wiki-create-position"
                type="number"
                min={0}
                step={1}
                value={position}
                disabled={pending}
                aria-invalid={invalidPosition}
                onChange={(event) => setPosition(event.target.value)}
              />
              <FieldError>{invalidPosition ? '需为非负整数' : null}</FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={pending || title.trim() === '' || !slugValid || invalidPosition}
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
