import { Toolbar, ToolbarButton } from '@ui-sdk/react/toolbar';
import { Download, MessageCircleQuestion, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { KnowledgeFaqBatchResult, KnowledgeFaqSummary } from '../../lib/api.js';
import { errorMessage } from '../../lib/api.js';
import { downloadBlob } from '../../lib/browser-files.js';
import { cn } from '../../lib/cn.js';
import {
  useBatchKnowledgeFaqs,
  useDeleteKnowledgeFaq,
  useDrainPages,
  useExportKnowledgeFaqs,
  useKnowledgeFaqs,
  useKnowledgeFolders,
  usePublishKnowledgeFaq,
  useSetKnowledgeFaqStatus,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { FilterSelect } from '../filter-select.js';
import { PageToolbar } from '../page.js';
import { SearchInput } from '../search-input.js';
import { type EmptyFilterChip, EmptyState, ErrorState, LoadingState } from '../states.js';
import { StatusBadge } from '../status-badge.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { FaqDialog } from './faq/faq-dialog.js';
import { FaqHistoryDialog } from './faq/faq-history-dialog.js';
import { FaqImportDialog } from './faq/faq-import-dialog.js';
import { FaqPublishDialog } from './faq/faq-publish-dialog.js';
import { FAQ_BATCH_LIMIT, faqStatus, faqStatusLabel, faqStatusTone } from './faq/faq-shared.js';
import { FaqTest } from './faq/faq-test.js';
import {
  documentStatusLabel,
  parseKnowledgeDocumentStatusFilter,
  treeFolders,
} from './knowledge-shared.js';

export function FaqTab({
  baseId,
  caps,
}: {
  baseId: string;
  caps: { content: boolean; publish: boolean; execute: boolean; import: boolean; export: boolean };
}) {
  const [query, setQuery] = useState('');
  const settledQuery = useDebouncedValue(query.trim(), 300);
  const [status, setStatus] = useState<'all' | KnowledgeFaqSummary['status']>('all');
  const applyStatus = (next: string): void => {
    const value = parseKnowledgeDocumentStatusFilter(next);
    if (value !== undefined) setStatus(value);
  };
  const [folder, setFolder] = useState('all');
  const [recommended, setRecommended] = useState('all');
  const folders = useKnowledgeFolders(baseId);
  const faqs = useKnowledgeFaqs(baseId, {
    ...(settledQuery === '' ? {} : { q: settledQuery }),
    ...(status === 'all' ? {} : { status }),
    ...(folder === 'all' ? {} : { folderId: folder }),
    ...(recommended === 'all' ? {} : { isRecommended: recommended === 'true' }),
  });
  useDrainPages(faqs);
  const items = faqs.data?.pages.flatMap((page) => page.items) ?? [];
  const publish = usePublishKnowledgeFaq(baseId);
  const setStatusMutation = useSetKnowledgeFaqStatus(baseId);
  const remove = useDeleteKnowledgeFaq(baseId);
  const exporter = useExportKnowledgeFaqs();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeFaqSummary | null>(null);
  const [publishing, setPublishing] = useState<KnowledgeFaqSummary | null>(null);
  const [historying, setHistorying] = useState<KnowledgeFaqSummary | null>(null);
  const [exportVersion, setExportVersion] = useState<'published' | 'draft'>('published');
  const batch = useBatchKnowledgeFaqs(baseId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const pending =
    publish.isPending || setStatusMutation.isPending || exporter.isPending || batch.isPending;

  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectedItems = items.filter((item) => selectedIds.has(item.id));
  useEffect(() => {
    setSelectedIds((current) => {
      const visible = new Set(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const reportBatch = (results: KnowledgeFaqBatchResult['results'], successText: string): void => {
    const failed = results.filter((item) => item.status === 'failed');
    if (failed.length === 0) {
      setSelectedIds(new Set());
      toastSuccess(successText);
      return;
    }
    toastError(`${failed.length} 条失败：${failed[0]?.message ?? failed[0]?.code ?? '未知原因'}`);
  };

  const runBatch = async (
    action: 'enable' | 'disable' | 'delete',
    successText: string,
  ): Promise<void> => {
    if (selectedItems.length === 0) return;
    const targets = selectedItems.map((item) => ({ documentId: item.id }));
    const results: KnowledgeFaqBatchResult['results'] = [];
    for (let index = 0; index < targets.length; index += FAQ_BATCH_LIMIT) {
      try {
        const result = await batch.mutateAsync({
          action,
          items: targets.slice(index, index + FAQ_BATCH_LIMIT),
        });
        results.push(...result.results);
      } catch (reason) {
        const failedSoFar = results.filter((item) => item.status === 'failed').length;
        toastError(
          results.length === 0
            ? reason
            : `批量操作中断：已返回 ${results.length} 条${failedSoFar > 0 ? `（失败 ${failedSoFar} 条）` : ''}，${errorMessage(reason)}`,
        );
        return;
      }
    }
    reportBatch(results, successText);
  };

  const download = (format: 'json' | 'csv'): void => {
    exporter.mutate(
      { baseId, format, version: exportVersion },
      {
        onSuccess: (blob) => {
          downloadBlob(blob, `faqs-${exportVersion}.${format}`);
        },
        onError: toastError,
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageToolbar>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            label="按 FAQ 状态筛选"
            value={status}
            onValueChange={applyStatus}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'ready', label: '可召回' },
              { value: 'pending', label: '未发布草稿' },
              { value: 'disabled', label: '已停用' },
            ]}
            className="w-36"
          />
          <FilterSelect
            label="按推荐筛选"
            value={recommended}
            onValueChange={setRecommended}
            options={[
              { value: 'all', label: '全部推荐状态' },
              { value: 'true', label: '推荐' },
              { value: 'false', label: '不推荐' },
            ]}
            className="w-36"
          />
          {folders.data && folders.data.length > 0 ? (
            <Select
              value={folder}
              onValueChange={(next) => {
                if (next !== null) setFolder(next);
              }}
              items={[
                { value: 'all', label: '全部目录' },
                ...treeFolders(folders.data).map((item) => ({
                  value: item.id,
                  label: `${'　'.repeat(item.depth)}${item.label}`,
                })),
              ]}
            >
              <SelectTrigger aria-label="按 FAQ 目录筛选" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部目录</SelectItem>
                  {treeFolders(folders.data).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {`${'　'.repeat(item.depth)}${item.label}`}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SearchInput
            label="搜索 FAQ"
            placeholder="搜索标准问…"
            value={query}
            onChange={setQuery}
            className="min-w-40 flex-1 sm:w-56 sm:flex-none"
          />
          {caps.import || caps.publish ? (
            <Button variant="outline" onClick={() => setImporting(true)}>
              <Upload data-icon="inline-start" aria-hidden="true" />
              {caps.import ? '导入' : '批次发布'}
            </Button>
          ) : null}
          {caps.export ? (
            <>
              <Select
                value={exportVersion}
                onValueChange={(next) => {
                  if (next === 'published' || next === 'draft') setExportVersion(next);
                }}
                items={[
                  { value: 'published', label: '已发布' },
                  { value: 'draft', label: '草稿' },
                ]}
              >
                <SelectTrigger aria-label="导出 FAQ 版本" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="published">已发布</SelectItem>
                    <SelectItem value="draft">草稿</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={exporter.isPending}
                aria-busy={exporter.isPending}
                onClick={() => download('json')}
              >
                <Download data-icon="inline-start" aria-hidden="true" /> JSON
              </Button>
              <Button
                variant="outline"
                disabled={exporter.isPending}
                aria-busy={exporter.isPending}
                onClick={() => download('csv')}
              >
                <Download data-icon="inline-start" aria-hidden="true" /> CSV
              </Button>
            </>
          ) : null}
          {caps.content ? (
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建 FAQ
            </Button>
          ) : null}
        </div>
      </PageToolbar>

      {caps.content && selectedItems.length > 0 ? (
        <Toolbar
          aria-label="FAQ 批量操作"
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-item bg-sunken px-3 py-2"
        >
          <span className="text-xs text-fg">已选 {selectedItems.length} 个</span>
          <ToolbarButton
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={batch.isPending}
            onClick={() => void runBatch('enable', 'FAQ 已批量启用')}
          >
            启用
          </ToolbarButton>
          <ToolbarButton
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={batch.isPending}
            onClick={() => void runBatch('disable', 'FAQ 已批量停用')}
          >
            停用
          </ToolbarButton>
          <ToolbarButton
            className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            disabled={batch.isPending}
            onClick={() => setBatchDeleting(true)}
          >
            删除
          </ToolbarButton>
          <ToolbarButton
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto')}
            onClick={() => setSelectedIds(new Set())}
          >
            取消选择
          </ToolbarButton>
        </Toolbar>
      ) : null}

      {faqs.isPending ? <LoadingState rows={4} /> : null}
      {faqs.isError ? <ErrorState error={faqs.error} onRetry={() => void faqs.refetch()} /> : null}
      {faqs.isSuccess && items.length === 0 ? (
        settledQuery === '' ? (
          <EmptyState
            variant="stage"
            scale="section"
            icon={<MessageCircleQuestion aria-hidden="true" />}
            title="整理高频问答 FAQ"
            description="新建或导入 FAQ，发布后可被专家精准召回。"
            action={
              caps.content ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus data-icon="inline-start" aria-hidden="true" /> 新建 FAQ
                </Button>
              ) : undefined
            }
            footer={caps.content ? undefined : '当前账户没有维护 FAQ 的权限。'}
          />
        ) : (
          <EmptyState
            variant="filter"
            scale="section"
            title="没有匹配的 FAQ"
            activeFilters={
              [
                {
                  key: 'q',
                  label: '关键词',
                  value: settledQuery,
                  onRemove: () => setQuery(''),
                },
              ] satisfies EmptyFilterChip[]
            }
            action={
              <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            }
          />
        )
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col">
          {items.map((item) => {
            const statusValue = faqStatus(item);
            return (
              <li key={item.id} className="flex flex-col gap-1 border-b py-3 last:border-b-0">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  {caps.content ? (
                    <Checkbox
                      className="self-center"
                      checked={selectedIds.has(item.id)}
                      onCheckedChange={() => toggleSelected(item.id)}
                      aria-label={`选择 ${item.faq?.question ?? item.title}`}
                    />
                  ) : null}
                  <span className="min-w-0 truncate text-sm font-medium text-fg">
                    {item.faq?.question ?? item.title}
                  </span>
                  <StatusBadge tone={faqStatusTone[statusValue]}>
                    {faqStatusLabel[statusValue]}
                  </StatusBadge>
                  {item.faq && item.faq.answers.length > 1 ? (
                    <span className="text-xs text-muted-foreground">
                      {item.faq.answers.length} 个答案
                    </span>
                  ) : null}
                  {item.faq ? (
                    <span className="text-xs text-muted-foreground">
                      {item.faq.answerStrategy === 'random' ? '随机一条' : '全部答案'}
                    </span>
                  ) : null}
                  {item.faq?.isRecommended ? <StatusBadge tone="outline">推荐</StatusBadge> : null}
                  {item.status === 'pending' ? null : (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {documentStatusLabel[item.status]}
                    </span>
                  )}
                </div>
                {item.faq?.answers[0] ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {item.faq.answers[0]}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {caps.content ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={item.faq === null}
                      onClick={() => setEditing(item.id)}
                    >
                      <Pencil data-icon="inline-start" aria-hidden="true" /> 编辑
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setHistorying(item)}>
                    历史
                  </Button>
                  {caps.publish ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setPublishing(item)}
                    >
                      发布草稿
                    </Button>
                  ) : null}
                  {caps.content ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          pending ||
                          (item.disabledReason !== null && item.disabledReason !== 'manual')
                        }
                        title={
                          item.disabledReason !== null && item.disabledReason !== 'manual'
                            ? '来源失效导致的停用需先恢复来源'
                            : undefined
                        }
                        onClick={() =>
                          setStatusMutation.mutate(
                            {
                              documentId: item.id,
                              enabled: item.status === 'disabled',
                            },
                            {
                              onSuccess: () =>
                                toastSuccess(
                                  item.status === 'disabled' ? 'FAQ 已启用' : 'FAQ 已停用',
                                ),
                              onError: toastError,
                            },
                          )
                        }
                      >
                        {item.status === 'disabled' ? '启用' : '停用'}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={pending}
                        onClick={() => setDeleting(item)}
                      >
                        <Trash2 data-icon="inline-start" aria-hidden="true" /> 删除
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {faqs.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={faqs.isFetchingNextPage}
          aria-busy={faqs.isFetchingNextPage}
          onClick={() => void faqs.fetchNextPage()}
        >
          {faqs.isFetchingNextPage ? '加载中…' : '加载更多 FAQ'}
        </Button>
      ) : null}

      {caps.execute ? <FaqTest baseId={baseId} /> : null}

      {creating ? (
        <FaqDialog
          baseId={baseId}
          folders={folders.data ?? []}
          initialFolderId={null}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <FaqDialog
          baseId={baseId}
          documentId={editing}
          folders={folders.data ?? []}
          initialFolderId={null}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {publishing ? (
        <FaqPublishDialog
          baseId={baseId}
          documentId={publishing.id}
          canExecute={caps.execute}
          onClose={() => setPublishing(null)}
        />
      ) : null}
      {historying ? (
        <FaqHistoryDialog
          baseId={baseId}
          canPublish={caps.publish}
          item={historying}
          onClose={() => setHistorying(null)}
        />
      ) : null}
      {importing ? (
        <FaqImportDialog
          baseId={baseId}
          canImport={caps.import}
          canPublish={caps.publish}
          canExecute={caps.execute}
          onClose={() => setImporting(false)}
        />
      ) : null}
      {batchDeleting ? (
        <ConfirmDialog
          open
          title="批量删除 FAQ"
          description={`将删除选中的 ${selectedItems.length} 条 FAQ 及其版本与索引。此操作不可撤销。`}
          confirmLabel="删除"
          confirmDisabled={batch.isPending}
          onClose={() => setBatchDeleting(false)}
          onConfirm={async () => {
            await runBatch('delete', 'FAQ 已批量删除');
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除 FAQ"
          description={`将删除「${deleting.faq?.question ?? deleting.title}」及其版本与索引。此操作不可撤销。`}
          confirmLabel="删除"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('FAQ 已删除');
          }}
        />
      ) : null}
    </div>
  );
}
