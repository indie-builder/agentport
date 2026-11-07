import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { canAny, RESOURCE_MENU, RESOURCE_SECTIONS } from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { meQuery } from '../lib/queries.js';
import { FilterSelect } from './filter-select.js';
import { Page, PageBody, PageHeader, PageToolbar, PageTopbar } from './page.js';
import { SearchInput } from './search-input.js';

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
  children,
}: {
  section: keyof typeof RESOURCE_SECTIONS;
  query: string;
  onQueryChange: (value: string) => void;
  /** 省略时不展示数量（例如搜索词太短，结果数没有意义）。 */
  count?: number | undefined;
  status: 'pending' | 'error' | 'success';
  filters?: ReactNode;
  leadingFilters?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
} & (
  | { sort: 'newest' | 'name'; onSortChange: (value: 'newest' | 'name') => void }
  | { sort?: never; onSortChange?: never }
)) {
  const current = RESOURCE_SECTIONS[section];
  const label = current.label;
  const me = useQuery(meQuery);
  const visibleSections = RESOURCE_MENU.filter((item) => canAny(me.data, item.permissionIds));
  return (
    <Page>
      <PageTopbar>
        <PageHeader title={label} className="sr-only" />
        <div className="flex min-h-12 flex-wrap items-center gap-4">
          <nav aria-label="资源类型">
            <ul className="inline-flex min-h-8 w-fit max-w-full flex-wrap items-center justify-start gap-x-4 gap-y-2 text-muted-foreground">
              {visibleSections.map(({ to, label: title, icon: Icon }) => (
                <li key={to} className="flex-none">
                  <Link
                    to={to}
                    aria-current={to === current.to ? 'page' : undefined}
                    className={cn(
                      "relative inline-flex h-8 flex-none items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,border-color,box-shadow] duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                      'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary after:opacity-0 after:transition-opacity',
                      to === current.to
                        ? 'text-primary after:opacity-100'
                        : 'hover:text-foreground',
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
          {onSortChange ? (
            <FilterSelect
              label="资源排序"
              value={sort}
              onValueChange={(next) => {
                if (next === 'newest' || next === 'name') onSortChange(next);
              }}
              options={sortOptions}
              className="w-32"
            />
          ) : null}
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
      </PageTopbar>
      <PageBody>{children}</PageBody>
    </Page>
  );
}
