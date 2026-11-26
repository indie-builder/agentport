import { Download, EllipsisVertical, Plus, Shuffle, Upload } from 'lucide-react';
import { type RefObject, useState } from 'react';
import { PageToolbar } from '../../components/page.js';
import { SearchInput } from '../../components/search-input.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { ApiError, type EvalCase } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { onFilePick } from '../../lib/file-pick.js';
import { CaseInspector } from './case-inspector.js';

type CaseFilter = 'all' | 'llm' | 'contains' | 'tools';

const filterOptions: readonly { value: CaseFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'llm', label: 'LLM 评判' },
  { value: 'contains', label: '包含匹配' },
  { value: 'tools', label: '含工具约束' },
];

export function EvalCasesTab({
  casesPending,
  casesError,
  casesErrorValue,
  casesIsFetchNextPageError,
  casesEmpty,
  casesHasNextPage,
  casesFetchingNextPage,
  onRetryCases,
  onFetchNextCases,
  caseItems,
  selectedCaseId,
  onSelectCase,
  canManageEval,
  canReadEval,
  canReadRuns,
  createButtonRef,
  importInputRef,
  importPending,
  exporting,
  onImportFile,
  onExportJson,
  onOpenCreateCase,
  onOpenSampleRuns,
  onEditCase,
  onDeleteCase,
}: {
  casesPending: boolean;
  casesError: boolean;
  casesErrorValue: unknown;
  casesIsFetchNextPageError: boolean;
  casesEmpty: boolean;
  casesHasNextPage: boolean;
  casesFetchingNextPage: boolean;
  onRetryCases: () => void;
  onFetchNextCases: () => void;
  caseItems: EvalCase[];
  selectedCaseId: string | null;
  onSelectCase: (caseId: string) => void;
  canManageEval: boolean;
  canReadEval: boolean;
  canReadRuns: boolean;
  createButtonRef: RefObject<HTMLButtonElement | null>;
  importInputRef: RefObject<HTMLInputElement | null>;
  importPending: boolean;
  exporting: boolean;
  onImportFile: (file: File) => void;
  onExportJson: () => void;
  onOpenCreateCase: (trigger: HTMLElement) => void;
  onOpenSampleRuns: (trigger: HTMLElement) => void;
  onEditCase: (testCase: EvalCase, trigger: HTMLElement) => void;
  onDeleteCase: (testCase: EvalCase, trigger: HTMLElement) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CaseFilter>('all');

  const normalizedQuery = query.trim().toLowerCase();
  const activeFilters: EmptyFilterChip[] = [
    ...(query.trim()
      ? [{ key: 'query', label: '搜索', value: query.trim(), onRemove: () => setQuery('') }]
      : []),
    ...(filter !== 'all'
      ? [
          {
            key: 'filter',
            label: '类型',
            value: filterOptions.find((option) => option.value === filter)?.label ?? filter,
            onRemove: () => setFilter('all'),
          },
        ]
      : []),
  ];
  const filteredCases = caseItems.filter((item) => {
    if (filter === 'llm' && item.judgeMode !== 'llm') return false;
    if (filter === 'contains' && item.judgeMode !== 'contains') return false;
    if (
      filter === 'tools' &&
      !(item.expectedTools && item.expectedTools.length > 0) &&
      !(item.forbiddenTools && item.forbiddenTools.length > 0)
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    return (
      item.name.toLowerCase().includes(normalizedQuery) ||
      item.prompt.toLowerCase().includes(normalizedQuery)
    );
  });

  const activeCase =
    filteredCases.find((item) => item.id === selectedCaseId) ?? filteredCases[0] ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageToolbar>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={onFilePick((files) => {
            const file = files[0];
            if (file) onImportFile(file);
          })}
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          label="搜索用例"
          placeholder="搜索用例名称或 Prompt…"
          className="w-full sm:w-56"
        />
        <fieldset
          aria-label="筛选用例类型"
          className="inline-flex items-center rounded-pill border-0 bg-sunken p-0.5"
        >
          {filterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
              className={cn(
                'rounded-pill px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                filter === option.value
                  ? 'bg-surface text-fg shadow-sm'
                  : 'text-muted-foreground hover:text-fg',
              )}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canManageEval && !casesEmpty ? (
            <Button
              variant="outline"
              size="sm"
              ref={createButtonRef}
              onClick={(event) => onOpenCreateCase(event.currentTarget)}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              新建用例
            </Button>
          ) : null}
          {canManageEval && canReadRuns ? (
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => onOpenSampleRuns(event.currentTarget)}
            >
              <Shuffle data-icon="inline-start" aria-hidden="true" />
              从运行抽样
            </Button>
          ) : null}
          {canManageEval || canReadEval ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="用例更多操作"
                    disabled={importPending || exporting}
                    aria-busy={importPending || exporting}
                  >
                    <EllipsisVertical aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" sideOffset={4} className="w-40">
                <DropdownMenuGroup>
                  {canManageEval ? (
                    <DropdownMenuItem
                      disabled={importPending}
                      onSelect={() => importInputRef.current?.click()}
                    >
                      <Upload aria-hidden="true" />
                      {importPending ? '导入中…' : '导入 JSON'}
                    </DropdownMenuItem>
                  ) : null}
                  {canReadEval ? (
                    <DropdownMenuItem
                      disabled={exporting || caseItems.length === 0}
                      title={casesEmpty ? '至少新建一条用例后可导出' : undefined}
                      onSelect={onExportJson}
                    >
                      <Download aria-hidden="true" />
                      {exporting ? '导出中…' : '导出 JSON'}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </PageToolbar>

      {casesPending ? <LoadingState rows={3} /> : null}
      {casesError && !casesIsFetchNextPageError ? (
        <ErrorState error={casesErrorValue} onRetry={onRetryCases} />
      ) : null}
      {casesEmpty ? (
        <EmptyState
          variant="stage"
          scale="section"
          specimen="eval"
          title="添加第一条评估用例"
          description="用固定输入与预期标准持续回归验证专家表现。"
          action={
            canManageEval ? (
              <Button
                variant="outline"
                size="sm"
                ref={createButtonRef}
                onClick={(event) => onOpenCreateCase(event.currentTarget)}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                新建用例
              </Button>
            ) : undefined
          }
          footer={canManageEval ? undefined : '当前账户没有维护该专家用例的权限。'}
        />
      ) : null}

      {caseItems.length > 0 && filteredCases.length === 0 ? (
        <EmptyState
          variant="filter"
          scale="section"
          title="没有匹配的用例"
          description="尝试调整搜索词或筛选条件。"
          activeFilters={activeFilters}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery('');
                setFilter('all');
              }}
            >
              重置筛选
            </Button>
          }
        />
      ) : null}

      {filteredCases.length > 0 ? (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-w-0 flex-col gap-3">
            <ul className="divide-y overflow-hidden rounded-xl border bg-surface">
              {filteredCases.map((testCase) => {
                const isSelected = activeCase?.id === testCase.id;
                const expectedCount = testCase.expectedTools?.length ?? 0;
                const forbiddenCount = testCase.forbiddenTools?.length ?? 0;
                return (
                  <li key={testCase.id}>
                    <button
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => onSelectCase(testCase.id)}
                      className={cn(
                        'flex w-full flex-col gap-1.5 px-3.5 py-3 text-left transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected ? 'bg-selected text-selected-foreground' : 'hover:bg-hover',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm font-medium text-fg [overflow-wrap:anywhere]">
                          {testCase.name}
                        </span>
                        <StatusBadge tone="default">
                          {testCase.judgeMode === 'llm' ? 'LLM 评判' : '包含匹配'}
                        </StatusBadge>
                        {expectedCount > 0 ? (
                          <Badge variant="secondary">预期 {expectedCount} 工具</Badge>
                        ) : null}
                        {forbiddenCount > 0 ? (
                          <Badge variant="destructive">禁止 {forbiddenCount} 工具</Badge>
                        ) : null}
                      </div>
                      <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                        {testCase.prompt}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>

            {casesIsFetchNextPageError ? (
              <ErrorState
                error={casesErrorValue}
                onRetry={() =>
                  casesErrorValue instanceof ApiError &&
                  casesErrorValue.code === 'INVALID_INPUT' &&
                  casesErrorValue.path === '/cursor'
                    ? onRetryCases()
                    : onFetchNextCases()
                }
                title="下一页加载失败，保留已加载的用例"
              />
            ) : casesHasNextPage ? (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={casesFetchingNextPage}
                  aria-busy={casesFetchingNextPage}
                  onClick={onFetchNextCases}
                >
                  {casesFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
              </div>
            ) : null}
          </div>

          <CaseInspector
            testCase={activeCase}
            canManage={canManageEval}
            onEdit={onEditCase}
            onDelete={onDeleteCase}
          />
        </div>
      ) : null}
    </div>
  );
}
