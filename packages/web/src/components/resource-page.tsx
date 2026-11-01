import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Cable, LibraryBig, Puzzle, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { canAny } from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { meQuery } from '../lib/queries.js';
import { FilterSelect } from './filter-select.js';
import { Page, PageHeader, PageToolbar } from './page.js';
import { SearchInput } from './search-input.js';

const sections = [
  { id: 'skills', to: '/skills', label: '技能', icon: Sparkles, permission: 'skills.read' },
  { id: 'servers', to: '/servers', label: '连接器', icon: Cable, permission: 'servers.read' },
  { id: 'plugins', to: '/plugins', label: '插件', icon: Puzzle, permission: 'plugins.read' },
  {
    id: 'knowledge',
    to: '/knowledge',
    label: '知识库',
    icon: LibraryBig,
    permission: 'knowledge.read',
  },
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
  leadingFilters,
  actions,
  hideSort = false,
  children,
}: {
  section: 'skills' | 'servers' | 'plugins' | 'knowledge';
  query: string;
  onQueryChange: (value: string) => void;
  sort: 'newest' | 'name';
  onSortChange: (value: 'newest' | 'name') => void;
  /** 省略时不展示数量（例如搜索词太短，结果数没有意义）。 */
  count?: number | undefined;
  status: 'pending' | 'error' | 'success';
  filters?: ReactNode;
  leadingFilters?: ReactNode;
  actions?: ReactNode;
  hideSort?: boolean;
  children: ReactNode;
}) {
  const label = {
    skills: '技能',
    servers: '连接器',
    plugins: '插件',
    knowledge: '知识库',
  }[section];
  const me = useQuery(meQuery);
  const visibleSections = sections.filter((item) => canAny(me.data, [item.permission]));
  return (
    <Page>
      <PageHeader title={label} className="sr-only" />
      <div className="flex min-h-14 flex-wrap items-center gap-4">
        <nav aria-label="资源类型">
          <ul className="inline-flex min-h-8 w-fit max-w-full flex-wrap items-center justify-start gap-x-4 gap-y-2 text-muted-foreground">
            {visibleSections.map(({ id, to, label: title, icon: Icon }) => (
              <li key={id} className="flex-none">
                <Link
                  to={to}
                  aria-current={id === section ? 'page' : undefined}
                  className={cn(
                    "relative inline-flex h-8 flex-none items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,border-color,box-shadow] duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                    'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary after:opacity-0 after:transition-opacity',
                    id === section ? 'text-primary after:opacity-100' : 'hover:text-foreground',
                  )}
                >
                  <Icon data-icon="inline-start" />
                  {title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {actions ? (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      <PageToolbar>
        {leadingFilters ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">{leadingFilters}</div>
        ) : null}
        <SearchInput
          label={`搜索${label}`}
          placeholder={`搜索${label}…`}
          value={query}
          onChange={onQueryChange}
          className="w-56 min-w-0"
        />
        {filters ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">{filters}</div>
        ) : null}
        {hideSort ? null : (
          <FilterSelect
            label="资源排序"
            value={sort}
            onValueChange={(next) => {
              if (next === 'newest' || next === 'name') onSortChange(next);
            }}
            options={sortOptions}
            className="w-32"
          />
        )}
        {status === 'success' && count === undefined ? null : (
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            {status === 'pending'
              ? '加载中…'
              : status === 'error'
                ? '数量不可用'
                : `共 ${count} 个${label}`}
          </span>
        )}
      </PageToolbar>
      {children}
    </Page>
  );
}
