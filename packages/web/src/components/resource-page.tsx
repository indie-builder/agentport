import { Link } from '@tanstack/react-router';
import { Bot, Cable, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { FilterSelect } from './filter-select.js';
import { Page, PageHeader, PageToolbar } from './page.js';
import { SearchInput } from './search-input.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.js';

const sections = [
  { id: 'agents', to: '/agents', label: '专家', icon: Bot },
  { id: 'skills', to: '/skills', label: '技能', icon: Sparkles },
  { id: 'servers', to: '/servers', label: '连接器', icon: Cable },
] as const;

const sortOptions = [
  { value: 'newest', label: '最新创建' },
  { value: 'name', label: '名称排序' },
];

export function ResourcePage({
  section,
  query,
  onQueryChange,
  sort,
  onSortChange,
  count,
  status,
  filters,
  actions,
  hideSort = false,
  children,
}: {
  section: 'agents' | 'skills' | 'servers';
  query: string;
  onQueryChange: (value: string) => void;
  sort: 'newest' | 'name';
  onSortChange: (value: 'newest' | 'name') => void;
  count: number;
  status: 'pending' | 'error' | 'success';
  filters?: ReactNode;
  actions?: ReactNode;
  hideSort?: boolean;
  children: ReactNode;
}) {
  const label = { agents: '专家', skills: '技能', servers: '连接器' }[section];
  return (
    <Page>
      <PageHeader title={label} className="sr-only" />
      <Tabs value={section} className="flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pt-3">
          <TabsList variant="line" aria-label="资源类型" className="gap-4">
            {sections.map(({ id, to, label: title, icon: Icon }) => (
              <TabsTrigger key={id} value={id} nativeButton={false} render={<Link to={to} />}>
                <Icon data-icon="inline-start" />
                {title}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <SearchInput
              label={`搜索${label}`}
              placeholder={`搜索${label}…`}
              value={query}
              onChange={onQueryChange}
              className="min-w-40 flex-1 sm:w-56 sm:flex-none"
            />
            {actions}
          </div>
        </div>
        <PageToolbar>
          {filters}
          <span role="status" className="text-xs text-muted-foreground">
            {status === 'pending'
              ? '加载中…'
              : status === 'error'
                ? '数量不可用'
                : `共 ${count} 个${label}`}
          </span>
          {hideSort ? null : (
            <FilterSelect
              label="资源排序"
              value={sort}
              onValueChange={(next) => {
                if (next === 'newest' || next === 'name') onSortChange(next);
              }}
              options={sortOptions}
              className="ml-auto w-32"
            />
          )}
        </PageToolbar>{' '}
        <TabsContent value={section}>{children}</TabsContent>
      </Tabs>
    </Page>
  );
}
