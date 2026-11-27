import type { SearchItem } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import {
  Page,
  PageBody,
  PageHeader,
  PageSection,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { SearchInput } from '../components/search-input.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { formatDateTime } from '../lib/format.js';
import { searchQuery } from '../lib/queries.js';
import { SEARCH_KIND_META, SEARCH_KIND_ORDER, searchItemHref } from '../lib/search-meta.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';

function ResultRow({ item }: { item: SearchItem }) {
  const meta = SEARCH_KIND_META[item.kind];
  return (
    <li>
      <Link
        to={searchItemHref(item)}
        className="flex items-center gap-3 border-b border-line py-3 text-sm text-fg transition-colors duration-150 ease-out-soft last:border-b-0 hover:bg-hover"
      >
        <meta.icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{item.title}</span>
          {item.subtitle === '' ? null : (
            <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>
          )}
        </span>
        {item.updatedAt === undefined ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDateTime(item.updatedAt)}
          </span>
        )}
      </Link>
    </li>
  );
}

export function SearchPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/search' });
  const q = search.q ?? '';
  const debounced = useDebouncedValue(q.trim(), 200);
  const results = useQuery(searchQuery(debounced, 20));
  const groups = SEARCH_KIND_ORDER.map((kind) => ({
    kind,
    label: SEARCH_KIND_META[kind].label,
    items: (results.data?.items ?? []).filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <Page>
      <PageTopbar>
        <PageHeader title="搜索" />
        <PageToolbar>
          <SearchInput
            inputId="global-search-input"
            label="搜索全部内容"
            placeholder="搜索专家、会话、知识、资源与成果…"
            value={q}
            onChange={(next) =>
              void navigate({
                to: '/search',
                search: { q: next || undefined },
                replace: true,
              })
            }
            className="w-full sm:w-72"
          />
        </PageToolbar>
      </PageTopbar>

      <PageBody>
        {q.trim() === '' ? (
          <EmptyState
            variant="idle"
            scale="page"
            icon={<Search aria-hidden="true" />}
            title="输入关键词开始搜索"
            description="可检索专家、会话、知识库、技能、连接器、插件与成果。"
            footer="随时按 ⌘K 呼出命令面板"
          />
        ) : results.isError ? (
          <ErrorState error={results.error} onRetry={() => void results.refetch()} />
        ) : results.isPending ? (
          <LoadingState rows={3} />
        ) : groups.length === 0 ? (
          <EmptyState
            variant="filter"
            scale="section"
            title={`未找到与「${q.trim()}」匹配的内容`}
            description="请检查拼写、尝试更短的关键词，或确认当前账号拥有对应资源的查看权限。"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigate({ to: '/search', search: { q: undefined }, replace: true });
                  document.getElementById('global-search-input')?.focus();
                }}
              >
                清除搜索
              </Button>
            }
          />
        ) : (
          groups.map((group, index) => (
            <PageSection key={group.kind} title={group.label} divided={index > 0} className="gap-2">
              <ul>
                {group.items.map((item) => (
                  <ResultRow key={`${item.kind}:${item.id}`} item={item} />
                ))}
              </ul>
            </PageSection>
          ))
        )}
      </PageBody>
    </Page>
  );
}
