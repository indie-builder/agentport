import { ChevronRight, Filter, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type {
  KnowledgeContentKind,
  KnowledgeSearchHit,
  KnowledgeSearchResponse,
} from '../../lib/api.js';
import { useKnowledgeFolders, useKnowledgeSearch, useKnowledgeTags } from '../../lib/queries.js';
import { PageNote } from '../page.js';
import { SearchInput } from '../search-input.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js';
import { Field, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { Switch } from '../ui/switch.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import {
  citationFromHit,
  citationPageLabel,
  type KnowledgeCitation,
  KnowledgeHitDialog,
  ScoreBreakdown,
} from './knowledge-citations.js';
import { contentKindLabel, locatorLabel, scoreKindLabel } from './knowledge-shared.js';

interface KnowledgeSearchState {
  q?: string | undefined;
  folders?: string[] | undefined;
  tags?: string[] | undefined;
  kinds?: KnowledgeContentKind[] | undefined;
  rerank?: boolean | undefined;
  minVectorScore?: number | undefined;
  diagnostics?: boolean | undefined;
  onlyRecommended?: boolean | undefined;
  faqPriority?: boolean | undefined;
  faqDirectAnswerThreshold?: number | undefined;
}

interface FaqRetrievalOptions {
  onlyRecommended?: boolean | undefined;
  faqPriority?: boolean | undefined;
  faqDirectAnswerThreshold?: number | undefined;
}

export function FaqRetrievalControls({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: FaqRetrievalOptions;
  onChange: (patch: FaqRetrievalOptions) => void;
}) {
  return (
    <>
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Switch
          checked={value.onlyRecommended ?? false}
          onCheckedChange={(checked) => onChange({ onlyRecommended: checked ? true : undefined })}
          aria-label="只返回推荐 FAQ"
        />
        只推荐 FAQ
      </span>
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Switch
          checked={value.faqPriority ?? false}
          onCheckedChange={(checked) => onChange({ faqPriority: checked ? true : undefined })}
          aria-label="FAQ 优先"
        />
        FAQ 优先
      </span>
      <Field className="w-32 gap-1">
        <FieldLabel htmlFor={`${idPrefix}-direct-threshold`} className="text-sm">
          直接答案门槛
        </FieldLabel>
        <Input
          id={`${idPrefix}-direct-threshold`}
          type="number"
          min={-1}
          max={1}
          step={0.05}
          value={value.faqDirectAnswerThreshold ?? 0.9}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') {
              onChange({ faqDirectAnswerThreshold: undefined });
              return;
            }
            const next = Number(raw);
            onChange({
              faqDirectAnswerThreshold:
                Number.isFinite(next) && next >= -1 && next <= 1 ? next : undefined,
            });
          }}
          className="h-8"
        />
      </Field>
    </>
  );
}

const ALL_KINDS: KnowledgeContentKind[] = ['document', 'faq', 'wiki'];

function toggleValue<T>(values: T[] | undefined, value: T, fallback: T[]): T[] {
  const current = values ?? fallback;
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function MultiFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const idPrefix = useId();
  const active = selected ?? [];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" aria-label={label}>
            <Filter data-icon="inline-start" aria-hidden="true" />
            {label}
            {active.length === 0 ? null : (
              <span className="ml-1 rounded-full bg-selected px-1.5 text-xs">{active.length}</span>
            )}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-64">
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">没有可选项</p>
        ) : (
          options.map((option, index) => {
            const checkboxId = `${idPrefix}-${index}`;
            return (
              <label
                key={option.value}
                htmlFor={checkboxId}
                className="flex cursor-pointer items-center gap-2 rounded-item px-1 py-1 text-sm text-fg transition-colors duration-150 ease-out-soft hover:bg-hover"
              >
                <Checkbox
                  id={checkboxId}
                  aria-label={option.label}
                  checked={active.includes(option.value)}
                  onCheckedChange={() => {
                    const next = toggleValue(selected, option.value, []);
                    onChange(next.length === 0 ? undefined : next);
                  }}
                />
                <span className="truncate">{option.label}</span>
              </label>
            );
          })
        )}
        {active.length > 0 ? (
          <Button
            variant="link"
            size="xs"
            className="self-start"
            onClick={() => onChange(undefined)}
          >
            清除
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function KindFilter({
  selected,
  onChange,
}: {
  selected: KnowledgeContentKind[] | undefined;
  onChange: (next: KnowledgeContentKind[] | undefined) => void;
}) {
  const idPrefix = useId();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" aria-label="按类型筛选">
            {selected === undefined
              ? '全部类型'
              : selected.map((kind) => contentKindLabel[kind]).join(' / ')}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-48">
        {ALL_KINDS.map((kind) => {
          const active = selected === undefined || selected.includes(kind);
          const checkboxId = `${idPrefix}-${kind}`;
          return (
            <label
              key={kind}
              htmlFor={checkboxId}
              className="flex cursor-pointer items-center gap-2 rounded-item px-1 py-1 text-xs text-fg transition-colors duration-150 ease-out-soft hover:bg-hover"
            >
              <Checkbox
                id={checkboxId}
                aria-label={contentKindLabel[kind]}
                checked={active}
                onCheckedChange={() => {
                  const current = selected ?? ALL_KINDS;
                  if (active && current.length === 1) return;
                  const next = current.includes(kind)
                    ? current.filter((item) => item !== kind)
                    : [...current, kind];
                  onChange(next.length === ALL_KINDS.length ? undefined : next);
                }}
              />
              <span>{contentKindLabel[kind]}</span>
            </label>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function hitKind(hit: KnowledgeSearchHit): KnowledgeContentKind {
  return hit.target?.kind ?? 'document';
}

function hitLocator(hit: KnowledgeSearchHit): string | null {
  return locatorLabel(hit.locator) ?? citationPageLabel(citationFromHit(hit));
}

function HitRow({
  hit,
  index,
  onOpen,
}: {
  hit: KnowledgeSearchHit;
  index: number;
  onOpen: () => void;
}) {
  const locator = hitLocator(hit);
  const location = [locator, hit.heading].filter(Boolean).join(' · ');
  const quoteExcerpt = hit.quote.length > 40 ? `${hit.quote.slice(0, 40)}…` : hit.quote;
  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="rounded-tag border border-line px-1.5 text-xs text-muted-foreground">
          {contentKindLabel[hitKind(hit)]}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-fg" title={hit.title}>
          {hit.title}
        </span>
        {hit.heading ? (
          <span className="truncate text-xs text-muted-foreground">{hit.heading}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {locator === null ? null : `${locator} · `}
          {scoreKindLabel(hit.scoreKind)} {hit.score.toFixed(4)}
        </span>
      </div>
      <p className="line-clamp-3 text-sm text-muted-foreground">{hit.quote}</p>
      {hit.faq ? (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-sm text-muted-foreground">
            {hit.faq.questionKind === 'similar' ? '相似问' : '标准问'}：{hit.faq.matchedQuestion}
          </span>
          <span className="text-xs text-muted-foreground">
            {hit.faq.answerStrategy === 'random'
              ? '随机答案 · 本次 1 条'
              : `全部答案 · ${hit.faq.answers.length} 条`}
            {hit.faq.isRecommended ? ' · 推荐' : ''}
          </span>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-fg">
            {hit.faq.answers.map((answer, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 答案按服务端顺序展示
              <li key={`answer-${index}`}>{answer}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {hit.parentContent ? (
        <Collapsible className="text-sm text-muted-foreground">
          <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 text-left">
            <ChevronRight
              className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
              aria-hidden="true"
            />
            父块上下文
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted hiddenUntilFound>
            <p className="mt-1">{hit.parentContent}</p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <ScoreBreakdown scores={hit.scores} scoreKind={hit.scoreKind} score={hit.score} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="link"
          size="xs"
          aria-label={`查看原文：${hit.title}${location ? `（${location}）` : ''}${quoteExcerpt ? `：${quoteExcerpt}` : ''}，命中 ${index + 1}`}
          onClick={onOpen}
        >
          查看原文
        </Button>
        {hit.sourceUrl ? (
          <a
            href={hit.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="w-fit text-xs text-muted-foreground underline underline-offset-2"
          >
            查看来源
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Diagnostics({ result }: { result: KnowledgeSearchResponse }) {
  const diagnostics = result.diagnostics;
  if (!diagnostics) return null;
  const rerankLabel =
    diagnostics.rerank === 'applied'
      ? '已应用'
      : diagnostics.rerank === 'unavailable'
        ? '不可用'
        : '关闭';
  return (
    <Collapsible className="rounded-item border border-line px-3 py-2">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 text-left text-xs text-muted-foreground">
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
          aria-hidden="true"
        />
        诊断 · {diagnostics.elapsedMs} ms · 返回 {diagnostics.returned} / 融合 {diagnostics.fused}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted hiddenUntilFound>
        <div className="mt-2 flex flex-col gap-2">
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
            <div className="flex gap-1">
              <dt>关键词路径</dt>
              <dd className="font-mono">{diagnostics.paths.keyword}</dd>
            </div>
            <div className="flex gap-1">
              <dt>向量路径</dt>
              <dd className="font-mono">{diagnostics.paths.vector}</dd>
            </div>
            <div className="flex gap-1">
              <dt>图片向量路径</dt>
              <dd className="font-mono">{diagnostics.paths.imageVector}</dd>
            </div>
            <div className="flex gap-1">
              <dt>重排</dt>
              <dd>{rerankLabel}</dd>
            </div>
          </dl>
          {diagnostics.candidates.length === 0 ? null : (
            <div className="max-h-64 overflow-y-auto">
              <Table aria-label="检索诊断候选" className="text-2xs">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="h-auto px-0 py-1 pr-2 text-2xs font-normal">
                      候选
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="h-auto px-0 py-1 pr-2 text-right text-2xs font-normal"
                    >
                      关键词
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="h-auto px-0 py-1 pr-2 text-right text-2xs font-normal"
                    >
                      向量
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="h-auto px-0 py-1 pr-2 text-right text-2xs font-normal"
                    >
                      RRF
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="h-auto px-0 py-1 text-right text-2xs font-normal"
                    >
                      重排
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diagnostics.candidates.map((candidate) => (
                    <TableRow key={candidate.chunkId} className="hover:bg-transparent">
                      <TableCell className="max-w-0 truncate px-0 py-1 pr-2 font-mono">
                        {candidate.chunkId}
                      </TableCell>
                      <TableCell className="px-0 py-1 pr-2 text-right font-mono tabular-nums">
                        {candidate.scores.keyword?.toFixed(3) ?? '—'}
                      </TableCell>
                      <TableCell className="px-0 py-1 pr-2 text-right font-mono tabular-nums">
                        {candidate.scores.vector?.toFixed(3) ?? '—'}
                      </TableCell>
                      <TableCell className="px-0 py-1 pr-2 text-right font-mono tabular-nums">
                        {candidate.scores.rrf.toFixed(4)}
                      </TableCell>
                      <TableCell className="px-0 py-1 text-right font-mono tabular-nums">
                        {candidate.scores.rerank?.toFixed(3) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function KnowledgeSearchResults({
  result,
  emptyTitle,
}: {
  result: KnowledgeSearchResponse;
  emptyTitle: string;
}) {
  const [cited, setCited] = useState<KnowledgeCitation | null>(null);
  const warnings = result.warnings ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {result.degraded ? (
        <PageNote
          title="向量检索不可用"
          description="当前结果只来自关键词匹配；请检查 embedding 模型配置。"
        />
      ) : null}
      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {warnings.map((warning) => (
            <li key={warning.code} className="text-sm text-warning">
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}
      {result.directAnswer ? (
        <div className="flex flex-col gap-1 rounded-item border border-line px-3 py-2">
          <span className="text-xs font-medium text-fg">
            直接答案
            <span className="ml-2 font-normal text-2xs text-muted-foreground">
              cosine {result.directAnswer.vectorScore.toFixed(3)}
            </span>
          </span>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed text-fg">
            {result.directAnswer.answers.map((answer, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 答案按服务端顺序展示
              <li key={`direct-${index}`}>{answer}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {result.hits.length === 0 ? (
        <EmptyState
          variant="filter"
          scale="section"
          title={emptyTitle}
          description="尝试减少关键词、调整筛选条件或检查文档是否已完成解析。"
        />
      ) : (
        <ul className="flex flex-col">
          {result.hits.map((hit, index) => (
            <HitRow
              key={hit.chunkId}
              hit={hit}
              index={index}
              onOpen={() => setCited(citationFromHit(hit))}
            />
          ))}
        </ul>
      )}
      <Diagnostics result={result} />
      {cited === null ? null : (
        <KnowledgeHitDialog citation={cited} onClose={() => setCited(null)} />
      )}
    </div>
  );
}

export function SearchTab({
  baseId,
  canExecute,
  state,
  onChange,
}: {
  baseId: string;
  canExecute: boolean;
  state: KnowledgeSearchState;
  onChange: (patch: Partial<KnowledgeSearchState>, replace?: boolean) => void;
}) {
  const [draft, setDraft] = useState(state.q ?? '');
  useEffect(() => setDraft(state.q ?? ''), [state.q]);
  const folders = useKnowledgeFolders(baseId);
  const tags = useKnowledgeTags(baseId);
  const result = useKnowledgeSearch(baseId, {
    q: state.q ?? '',
    ...(state.folders === undefined ? {} : { folders: state.folders }),
    ...(state.tags === undefined ? {} : { tags: state.tags }),
    ...(state.kinds === undefined ? {} : { kinds: state.kinds }),
    ...(state.rerank === undefined ? {} : { rerank: state.rerank }),
    ...(state.minVectorScore === undefined ? {} : { minVectorScore: state.minVectorScore }),
    ...(state.onlyRecommended === undefined ? {} : { onlyRecommended: state.onlyRecommended }),
    ...(state.faqPriority === undefined ? {} : { faqPriority: state.faqPriority }),
    ...(state.faqDirectAnswerThreshold === undefined
      ? {}
      : { faqDirectAnswerThreshold: state.faqDirectAnswerThreshold }),
    ...(state.diagnostics === undefined ? {} : { diagnostics: state.diagnostics }),
  });
  const terms = state.q ?? '';

  if (!canExecute) {
    return (
      <EmptyState
        variant="permission"
        scale="section"
        title="没有检索与处理权限"
        description="当前账号仅可查看内容，检索需要 knowledge.execute 权限。"
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim();
          if (next === terms) {
            if (next !== '') void result.refetch();
            return;
          }
          onChange({ q: next === '' ? undefined : next }, true);
        }}
      >
        <SearchInput
          label="检索知识库"
          placeholder="输入问题或关键词…"
          value={draft}
          onChange={setDraft}
          className="min-w-48 flex-1 sm:max-w-md"
          inputId="knowledge-search"
        />
        <Button type="submit" disabled={draft.trim() === ''}>
          <Search data-icon="inline-start" aria-hidden="true" /> 检索
        </Button>
      </form>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <MultiFilter
          label="目录"
          options={(folders.data ?? []).map((folder) => ({
            value: folder.id,
            label: folder.name,
          }))}
          selected={state.folders}
          onChange={(next) => onChange({ folders: next })}
        />
        <MultiFilter
          label="标签"
          options={(tags.data ?? []).map((tag) => ({ value: tag.name, label: tag.name }))}
          selected={state.tags}
          onChange={(next) => onChange({ tags: next })}
        />
        <KindFilter selected={state.kinds} onChange={(next) => onChange({ kinds: next })} />
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={state.rerank ?? true}
            onCheckedChange={(checked) => onChange({ rerank: checked ? undefined : false })}
            aria-label="启用重排"
          />
          重排
        </span>
        <Field className="w-32 gap-1">
          <FieldLabel htmlFor="knowledge-min-vector" className="text-sm">
            向量门槛
          </FieldLabel>
          <Input
            id="knowledge-min-vector"
            type="number"
            min={-1}
            max={1}
            step={0.05}
            value={state.minVectorScore ?? 0.3}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                onChange({ minVectorScore: undefined });
                return;
              }
              const next = Number(raw);
              onChange({
                minVectorScore: Number.isFinite(next) && next >= -1 && next <= 1 ? next : undefined,
              });
            }}
            className="h-8"
          />
        </Field>
        <FaqRetrievalControls
          idPrefix="knowledge-search"
          value={state}
          onChange={(patch) => onChange(patch)}
        />
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={state.diagnostics === true}
            onCheckedChange={(checked) => onChange({ diagnostics: checked ? true : undefined })}
            aria-label="显示诊断"
          />
          诊断
        </span>
      </div>

      {terms === '' ? (
        <EmptyState
          variant="idle"
          scale="section"
          icon={<Search aria-hidden="true" />}
          title="输入问题测试知识库召回"
          description="将按当前分块与向量配置返回匹配片段与得分。"
        />
      ) : null}
      {terms !== '' && result.isPending ? <LoadingState rows={3} /> : null}
      {terms !== '' && result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : null}
      {result.data ? (
        <KnowledgeSearchResults result={result.data} emptyTitle="没有匹配的分块" />
      ) : null}
    </div>
  );
}
