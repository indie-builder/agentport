import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Database, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { PageNote } from '../../components/page.js';
import { ResourcePage } from '../../components/resource-page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Badge } from '../../components/ui/badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { can } from '../../lib/access.js';
import type { DataDomain } from '../../lib/api.js';
import { formatRelative, shortId } from '../../lib/format.js';
import { meQuery, useDataDomains, useDeleteDataDomain, useDrainPages } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { DataDomainFormDialog } from './data-domain-form-dialog.js';

export function DataDomainsPage() {
  const domains = useDataDomains();
  useDrainPages(domains);
  const navigate = useNavigate({ from: '/data-domains/' });
  const location = useLocation();
  const search = useSearch({ from: '/_shell/data-domains/' });
  const me = useQuery(meQuery);
  const remove = useDeleteDataDomain();
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<DataDomain | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const canCreate = can(me.data, 'data_domains.create');
  const canDelete = can(me.data, 'data_domains.delete');
  const query = search.q ?? '';
  const fullyLoaded = domains.data !== undefined && !domains.hasNextPage;

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (domains.data ?? [])
      .filter(
        (domain) =>
          domain.name.toLocaleLowerCase().includes(needle) ||
          domain.slug.toLocaleLowerCase().includes(needle) ||
          domain.datasource.toLocaleLowerCase().includes(needle),
      )
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [domains.data, query]);

  const setQuery = (next: string): void => {
    void navigate({
      to: '/data-domains',
      search: (current) => ({ ...current, q: next || undefined }),
      replace: true,
    });
  };

  return (
    <ResourcePage
      section="dataDomains"
      query={query}
      onQueryChange={setQuery}
      count={fullyLoaded ? domains.data?.length : undefined}
      status={domains.isPending ? 'pending' : domains.isError ? 'error' : 'success'}
      actions={
        canCreate && !(domains.data && domains.data.length === 0) ? (
          <Button ref={createTriggerRef} onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> 新建数据域
          </Button>
        ) : null
      }
    >
      {domains.isPending ? <LoadingState rows={4} /> : null}
      {domains.isError && !domains.isFetchNextPageError ? (
        <ErrorState error={domains.error} onRetry={() => void domains.refetch()} />
      ) : null}
      {domains.isFetchNextPageError ? (
        <ErrorState
          error={domains.error}
          title="列表没有加载完"
          onRetry={() => void domains.fetchNextPage()}
        />
      ) : null}

      {fullyLoaded && domains.data && domains.data.length === 0 ? (
        <PageNote
          icon={<Database className="size-4" aria-hidden="true" />}
          title="未添加数据域"
          description={canCreate ? undefined : '当前账户没有创建数据域的权限。'}
          action={
            canCreate ? (
              <Button ref={createTriggerRef} onClick={() => setCreating(true)}>
                新建数据域
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {fullyLoaded && domains.data && domains.data.length > 0 && shown.length === 0 ? (
        <PageNote
          title="没有匹配的数据域"
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery('')}>
              清除筛选
            </Button>
          }
        />
      ) : null}

      {shown.length > 0 ? (
        <Table aria-label="数据域列表">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[28%]">名称</TableHead>
              <TableHead className="w-[16%]">标识</TableHead>
              <TableHead className="w-[16%]">数据源</TableHead>
              <TableHead className="w-[16%]">线上版本</TableHead>
              <TableHead className="w-[14%]">更新时间</TableHead>
              <TableHead className="w-[10%] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((domain) => (
              <TableRow key={domain.id}>
                <TableCell className="min-w-0">
                  <span className="block truncate font-medium text-fg" title={domain.name}>
                    {domain.name}
                  </span>
                </TableCell>
                <TableCell>
                  <code className="font-mono text-xs text-muted-foreground" title={domain.slug}>
                    {domain.slug}
                  </code>
                </TableCell>
                <TableCell className="text-muted-foreground">{domain.datasource}</TableCell>
                <TableCell>
                  {domain.onlineVersionId ? (
                    <Badge variant="secondary">在线 {shortId(domain.onlineVersionId)}</Badge>
                  ) : (
                    <span className="text-muted-foreground">未发布</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRelative(domain.updatedAt)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Link
                      to="/data-domains/$dataDomainId"
                      params={{ dataDomainId: domain.id }}
                      search={{ backTo: location.href }}
                      aria-label={`进入数据域 ${domain.name}`}
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      进入详情
                    </Link>
                    {canDelete ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={(event) => {
                          deleteTriggerRef.current = event.currentTarget;
                          setDeleting(domain);
                        }}
                      >
                        <Trash2 data-icon="inline-start" /> 删除
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {creating ? (
        <DataDomainFormDialog
          domain={null}
          canTest
          getReturnFocus={() =>
            createTriggerRef.current?.isConnected ? createTriggerRef.current : null
          }
          onClose={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除数据域"
          description={`删除「${deleting.name}」及其全部构建版本记录，此操作不可撤销。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('已删除数据域');
          }}
          finalFocus={() =>
            deleteTriggerRef.current?.isConnected ? deleteTriggerRef.current : null
          }
        />
      ) : null}
    </ResourcePage>
  );
}
