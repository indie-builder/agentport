import {
  MARKDOWN_FILE_MAX_BYTES,
  type MarketSkill,
  type MarketView,
  type Skill,
  type SkillFile,
  type SkillInput,
  type SkillWithAgentCount,
  skillFileInputSchema,
  skillInputSchema,
} from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  Check,
  Download,
  EllipsisVertical,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { BusinessIllustration } from '../components/business-illustration.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import { FilterSelect } from '../components/filter-select.js';
import { PageNote } from '../components/page.js';
import { RecordRows } from '../components/record-rows.js';
import { RequiredMark } from '../components/required-mark.js';
import { ResourcePage } from '../components/resource-page.js';
import { SourceEditor } from '../components/source-editor.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Textarea } from '../components/ui/textarea.js';
import { type ListView, SegmentedToggle, ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { ApiError, api, errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { onFilePick } from '../lib/file-pick.js';
import { formatTokens } from '../lib/format.js';
import {
  meQuery,
  useApproveSkill,
  useCreateSkill,
  useDeleteSkill,
  useImportSkillFile,
  useInstallMarketSkill,
  useMarketSkills,
  useRejectSkill,
  useSkills,
  useSubmitSkill,
  useUpdateSkill,
} from '../lib/queries.js';
import { matchesQuery } from '../lib/search.js';
import { compareBySort } from '../lib/sort.js';
import { toast, toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const emptySkill: SkillInput = { slug: '', name: '', description: '', body: '' };
const emptySkillFile = { path: '', content: '' };
const usageOptions = [
  { value: 'all', label: '全部技能' },
  { value: 'bound', label: '已绑定' },
  { value: 'unbound', label: '未绑定' },
];
const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'draft', label: '草稿' },
  { value: 'pending', label: '待审' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已驳回' },
];
const statusMeta: Record<
  Skill['status'],
  { label: string; tone: 'outline' | 'warn' | 'success' | 'danger' }
> = {
  draft: { label: '草稿', tone: 'outline' },
  pending: { label: '待审', tone: 'warn' },
  published: { label: '已发布', tone: 'success' },
  rejected: { label: '已驳回', tone: 'danger' },
};
const scopeOptions = [
  { value: 'internal', label: '内部' },
  { value: 'market', label: '市场' },
] as const;
const marketViewOptions = [
  { value: 'all-time', label: '总榜' },
  { value: 'trending', label: '趋势' },
  { value: 'hot', label: '新热' },
] as const;

const skillFormSchema = skillInputSchema.extend({
  slug: z
    .string()
    .min(1, '不能为空，请填写后再保存')
    .max(64, '最多 64 个字符，请精简后再保存')
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '格式不正确，请检查后重新填写'),
  name: z.string().min(1, '不能为空，请填写后再保存').max(128, '最多 128 个字符，请精简后再保存'),
  description: z
    .string()
    .min(1, '不能为空，请填写后再保存')
    .max(500, '最多 500 个字符，请精简后再保存'),
});

const skillFileFormSchema = skillFileInputSchema.extend({
  path: z
    .string()
    .min(1, '不能为空，请填写后再保存')
    .max(200, '最多 200 个字符，请精简后再保存')
    .pipe(skillFileInputSchema.shape.path),
  content: z.string().max(200_000, '最多 200000 个字符，请精简后再保存').default(''),
});

export function SkillsPage() {
  const me = useQuery(meQuery);
  const canReadSkills = can(me.data, 'skills.read');
  const canReadMarket = can(me.data, 'market.read');
  const canCreateSkill = can(me.data, 'skills.create');
  const canUpdateSkill = can(me.data, 'skills.update');
  const canDeleteSkill = can(me.data, 'skills.delete');
  const canReviewSkill = can(me.data, 'skills.review');
  const canImportSkill = can(me.data, 'skills.import');
  const canReadSkillFiles = can(me.data, 'skills.files.read');
  const canWriteSkillFiles = can(me.data, 'skills.files.write');
  const canInstallMarket = can(me.data, 'market.install');
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/skills' });
  const scope = search.scope ?? 'internal';
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const usage = search.usage ?? 'all';
  const skillStatus = search.status;
  const skills = useSkills({ status: skillStatus });
  const view: ListView = search.view ?? 'cards';
  const setView = (next: ListView): void => {
    void navigate({
      to: '/skills',
      search: { ...search, view: next === 'cards' ? undefined : next },
    });
  };
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SkillWithAgentCount | null>(null);
  const [rejecting, setRejecting] = useState<SkillWithAgentCount | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importSkill = useImportSkillFile();
  const submitSkill = useSubmitSkill();
  const approveSkill = useApproveSkill();
  const install = useInstallMarketSkill();
  const actionTriggerRef = useRef<HTMLElement | null>(null);
  const panelFocus = (): HTMLElement | null =>
    actionTriggerRef.current?.isConnected ? actionTriggerRef.current : createButtonRef.current;
  const setFilter = (
    patch: {
      q?: string | undefined;
      usage?: 'bound' | 'unbound' | undefined;
      status?: Skill['status'] | undefined;
    },
    replace = false,
  ): void => {
    void navigate({ to: '/skills', search: { ...search, ...patch }, replace });
  };
  const openMarket = (): void => {
    void navigate({
      to: '/skills',
      search: {
        scope: 'market',
        ...(search.sort ? { sort: search.sort } : {}),
        ...(search.marketView ? { marketView: search.marketView } : {}),
      },
    });
  };
  const importSkillMd = async (file: File): Promise<void> => {
    if (file.size > MARKDOWN_FILE_MAX_BYTES) {
      toastError(new Error('SKILL.md 不能超过 128 KB，请精简后重试。'));
      return;
    }
    try {
      const result = await importSkill.mutateAsync(await file.text());
      toastSuccess(`已导入「${result.skill.name}」`);
      for (const warning of result.warnings) toast.info(warning);
    } catch (error) {
      toastError(error);
    }
  };
  const submitForReview = (skill: SkillWithAgentCount): void => {
    submitSkill.mutate(skill.id, {
      onSuccess: (saved) => toastSuccess(`已提交「${saved.name}」审核`),
      onError: toastError,
    });
  };
  const approve = (skill: SkillWithAgentCount): void => {
    approveSkill.mutate(skill.id, {
      onSuccess: (saved) => toastSuccess(`已发布「${saved.name}」`),
      onError: toastError,
    });
  };
  const visibleSkills = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (skills.data ?? [])
      .filter(
        (skill) =>
          (usage === 'all' ||
            (usage === 'bound' ? skill.agentCount > 0 : skill.agentCount === 0)) &&
          matchesQuery([skill.name, skill.slug, skill.description, skill.body], term),
      )
      .sort((a, b) => compareBySort(a, b, sort));
  }, [skills.data, query, sort, usage]);

  if (scope === 'market') {
    return <MarketSkillsPage skills={skills} install={install} canInstall={canInstallMarket} />;
  }
  if (!canReadSkills && canReadMarket) {
    return <MarketSkillsPage skills={skills} install={install} canInstall={canInstallMarket} />;
  }

  return (
    <ResourcePage
      section="skills"
      query={query}
      onQueryChange={(next) => setFilter({ q: next || undefined }, true)}
      sort={sort}
      onSortChange={(next) =>
        void navigate({
          to: '/skills',
          search: { ...search, sort: next === 'newest' ? undefined : next },
        })
      }
      count={visibleSkills.length}
      countPartial={skills.hasNextPage}
      status={skills.status}
      leadingFilters={
        <SegmentedToggle
          label="技能来源"
          value="internal"
          options={scopeOptions}
          onChange={openMarket}
        />
      }
      menuFilters={
        <>
          <FilterSelect
            value={skillStatus ?? 'all'}
            onValueChange={(next) => {
              if (next === 'all') setFilter({ status: undefined });
              else if (
                next === 'draft' ||
                next === 'pending' ||
                next === 'published' ||
                next === 'rejected'
              )
                setFilter({ status: next });
            }}
            options={statusOptions}
            label="按审核状态筛选"
            className="w-full"
          />
          <FilterSelect
            value={usage}
            onValueChange={(next) => {
              if (next !== 'all' && next !== 'bound' && next !== 'unbound') return;
              setFilter({ usage: next === 'all' ? undefined : next });
            }}
            options={usageOptions}
            label="按使用情况筛选"
            className="w-full"
          />
        </>
      }
      activeFilterCount={(skillStatus === undefined ? 0 : 1) + (usage === 'all' ? 0 : 1)}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            className="hidden"
            onChange={onFilePick((files) => {
              const file = files[0];
              if (file) void importSkillMd(file);
            })}
          />
          {canCreateSkill ? (
            <Button
              ref={createButtonRef}
              onClick={(event) => {
                actionTriggerRef.current = event.currentTarget;
                setCreating(true);
              }}
            >
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建技能
            </Button>
          ) : null}
          {canImportSkill ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="更多操作"
                    disabled={importSkill.isPending}
                    aria-busy={importSkill.isPending}
                  >
                    <EllipsisVertical aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={importSkill.isPending}
                    aria-busy={importSkill.isPending}
                    onSelect={() => importInputRef.current?.click()}
                  >
                    <Upload aria-hidden="true" />
                    {importSkill.isPending ? '导入中…' : '导入 SKILL.md'}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      }
      {...(visibleSkills.length > 0
        ? { toolbarActions: <ViewToggle value={view} onChange={setView} /> }
        : {})}
    >
      {skills.isPending ? <LoadingState rows={4} /> : null}
      {skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
      ) : null}
      {skills.data && skills.data.length === 0 ? (
        <PageNote
          icon={<BusinessIllustration name="tools" size="compact" />}
          title="未添加技能"
          description={
            canCreateSkill || canReadMarket ? undefined : '当前账号没有创建技能或访问市场的权限。'
          }
          action={
            canCreateSkill ? (
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => {
                  actionTriggerRef.current = event.currentTarget;
                  setCreating(true);
                }}
              >
                新建技能
              </Button>
            ) : canReadMarket ? (
              <Button variant="outline" size="sm" onClick={openMarket}>
                前往市场
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {skills.data && skills.data.length > 0 && visibleSkills.length === 0 ? (
        <PageNote
          icon={<BusinessIllustration name="search" size="compact" />}
          title="没有匹配的技能"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilter({ q: undefined, usage: undefined, status: undefined })}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}

      {visibleSkills.length > 0 && view !== 'cards' ? (
        <ul className="divide-y divide-line border-y">
          {visibleSkills.map((skill) => (
            <li
              key={skill.id}
              className="flex min-h-14 items-center gap-4 py-2 transition-colors duration-150 ease-out-soft hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <Button
                  variant="ghost"
                  className="h-auto w-full min-w-0 justify-start p-0 text-left text-base font-medium"
                  onClick={(event) => {
                    actionTriggerRef.current = event.currentTarget;
                    setEditing(skill);
                  }}
                >
                  <span className="truncate" title={skill.name}>
                    {skill.name}
                  </span>
                </Button>
                <p className="truncate text-sm text-muted-foreground">{skill.description}</p>
                {skill.status === 'rejected' && skill.reviewNote ? (
                  <p className="truncate text-sm text-danger" title={skill.reviewNote}>
                    {`驳回原因：${skill.reviewNote}`}
                  </p>
                ) : null}
              </div>
              <StatusBadge tone={statusMeta[skill.status].tone}>
                {statusMeta[skill.status].label}
              </StatusBadge>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {skill.agentCount > 0 ? `${skill.agentCount} 个专家` : '未绑定'}
              </span>
              {skill.sourceId ? (
                <span
                  className="max-w-48 shrink-0 truncate text-sm text-muted-foreground"
                  title={skill.sourceId}
                >
                  {skill.sourceId.split('/').slice(0, 2).join('/')}
                </span>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`操作 ${skill.name}`}
                      onFocus={(event) => {
                        actionTriggerRef.current = event.currentTarget;
                      }}
                      onClick={(event) => {
                        actionTriggerRef.current = event.currentTarget;
                      }}
                    >
                      <EllipsisVertical />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                  <DropdownMenuGroup>
                    {canUpdateSkill ? (
                      <DropdownMenuItem onSelect={() => setEditing(skill)}>
                        <Pencil /> 编辑
                      </DropdownMenuItem>
                    ) : null}
                    {canReadSkillFiles && skill.status === 'published' ? (
                      <DropdownMenuItem render={<a href={`/api/skills/${skill.id}/file`} />}>
                        <Download /> 导出 SKILL.md
                      </DropdownMenuItem>
                    ) : null}
                    {canUpdateSkill && (skill.status === 'draft' || skill.status === 'rejected') ? (
                      <DropdownMenuItem
                        disabled={submitSkill.isPending}
                        onSelect={() => submitForReview(skill)}
                      >
                        <Send /> 提交审核
                      </DropdownMenuItem>
                    ) : null}
                    {canReviewSkill && skill.status === 'pending' ? (
                      <>
                        <DropdownMenuItem
                          disabled={approveSkill.isPending}
                          onSelect={() => approve(skill)}
                        >
                          <Check /> 批准
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setRejecting(skill)}
                        >
                          <X /> 驳回
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {canDeleteSkill ? (
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(skill)}>
                        <Trash2 /> 删除
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      ) : null}

      {visibleSkills.length > 0 && view === 'cards' ? (
        <ul
          aria-label="技能列表"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,288px),1fr))] gap-4 pt-2"
        >
          {visibleSkills.map((skill) => (
            <li key={skill.id} className="min-w-0">
              <Card size="sm" className="h-full">
                <CardHeader>
                  <CardTitle className="min-w-0">
                    <Button
                      variant="ghost"
                      className="h-auto w-full min-w-0 justify-start p-0 text-left text-sm font-medium"
                      onClick={(event) => {
                        actionTriggerRef.current = event.currentTarget;
                        setEditing(skill);
                      }}
                    >
                      <span className="block min-w-0 truncate" title={skill.name}>
                        {skill.name}
                      </span>
                    </Button>
                  </CardTitle>
                  <CardAction className="flex items-center gap-1">
                    <StatusBadge tone={statusMeta[skill.status].tone}>
                      {statusMeta[skill.status].label}
                    </StatusBadge>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`操作 ${skill.name}`}
                            onFocus={(event) => {
                              actionTriggerRef.current = event.currentTarget;
                            }}
                            onClick={(event) => {
                              actionTriggerRef.current = event.currentTarget;
                            }}
                          >
                            <EllipsisVertical />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                        <DropdownMenuGroup>
                          {canUpdateSkill ? (
                            <DropdownMenuItem onSelect={() => setEditing(skill)}>
                              <Pencil /> 编辑
                            </DropdownMenuItem>
                          ) : null}
                          {canReadSkillFiles && skill.status === 'published' ? (
                            <DropdownMenuItem render={<a href={`/api/skills/${skill.id}/file`} />}>
                              <Download /> 导出 SKILL.md
                            </DropdownMenuItem>
                          ) : null}
                          {canUpdateSkill &&
                          (skill.status === 'draft' || skill.status === 'rejected') ? (
                            <DropdownMenuItem
                              disabled={submitSkill.isPending}
                              onSelect={() => submitForReview(skill)}
                            >
                              <Send /> 提交审核
                            </DropdownMenuItem>
                          ) : null}
                          {canReviewSkill && skill.status === 'pending' ? (
                            <>
                              <DropdownMenuItem
                                disabled={approveSkill.isPending}
                                onSelect={() => approve(skill)}
                              >
                                <Check /> 批准
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setRejecting(skill)}
                              >
                                <X /> 驳回
                              </DropdownMenuItem>
                            </>
                          ) : null}
                          {canDeleteSkill ? (
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setDeleting(skill)}
                            >
                              <Trash2 /> 删除
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="line-clamp-2 break-words text-sm text-muted-foreground">
                    {skill.description}
                  </p>
                  {skill.status === 'rejected' && skill.reviewNote ? (
                    <p
                      className="line-clamp-2 break-words text-sm text-danger"
                      title={skill.reviewNote}
                    >
                      {`驳回原因：${skill.reviewNote}`}
                    </p>
                  ) : null}
                  <RecordRows
                    rows={[
                      {
                        label: '专家',
                        value: skill.agentCount > 0 ? `${skill.agentCount} 个专家` : '未绑定',
                      },
                      ...(skill.sourceId
                        ? [
                            {
                              label: '来源',
                              value: skill.sourceId.split('/').slice(0, 2).join('/'),
                              mono: true,
                              title: skill.sourceId,
                            },
                          ]
                        : []),
                    ]}
                  />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {skills.hasNextPage ? (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={skills.isFetchingNextPage}
            aria-busy={skills.isFetchingNextPage}
            onClick={() => void skills.fetchNextPage()}
          >
            {skills.isFetchingNextPage ? '加载中…' : '加载更多'}
          </Button>
        </div>
      ) : null}

      {creating ? (
        <SkillDialog
          canReadFiles={canReadSkillFiles}
          canWriteFiles={canWriteSkillFiles}
          finalFocus={panelFocus}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <SkillDialog
          skill={editing}
          readOnly={!canUpdateSkill}
          canReadFiles={canReadSkillFiles}
          canWriteFiles={canWriteSkillFiles}
          finalFocus={panelFocus}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteSkillDialog
          skill={deleting}
          finalFocus={panelFocus}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {rejecting ? (
        <RejectSkillDialog
          skill={rejecting}
          finalFocus={panelFocus}
          onClose={() => setRejecting(null)}
        />
      ) : null}
    </ResourcePage>
  );
}

function MarketSkillsPage({
  skills,
  install,
  canInstall,
}: {
  skills: ReturnType<typeof useSkills>;
  install: ReturnType<typeof useInstallMarketSkill>;
  canInstall: boolean;
}) {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/skills' });
  const view: MarketView = search.marketView ?? 'all-time';
  const query = search.q ?? '';
  const term = query.trim();
  const tooShort = term.length === 1;
  const market = useMarketSkills(view, query);
  const loaded = !skills.isPending && !skills.isError;
  const installedIds = new Set(
    (skills.data ?? []).map((skill) => skill.sourceId).filter((id): id is string => id !== null),
  );
  const clearSearch = (): void => {
    void navigate({
      to: '/skills',
      search: { ...search, q: undefined },
      replace: true,
    });
  };
  const installSkill = (item: MarketSkill): void => {
    if (install.isPending) return;
    install.mutate({ id: item.id });
  };

  return (
    <ResourcePage
      section="skills"
      query={query}
      onQueryChange={(next) =>
        void navigate({
          to: '/skills',
          search: { ...search, q: next || undefined },
          replace: true,
        })
      }
      count={tooShort ? undefined : (market.data?.length ?? 0)}
      status={
        tooShort ? 'success' : market.isPending || market.isDebouncing ? 'pending' : market.status
      }
      leadingFilters={
        <SegmentedToggle
          label="技能来源"
          value="market"
          options={scopeOptions}
          onChange={() =>
            void navigate({
              to: '/skills',
              search: {
                ...(search.sort ? { sort: search.sort } : {}),
              },
            })
          }
        />
      }
      filters={
        query.trim() === '' ? (
          <SegmentedToggle
            label="榜单"
            value={view}
            options={marketViewOptions}
            onChange={(next) =>
              void navigate({
                to: '/skills',
                search: {
                  ...search,
                  marketView: next === 'all-time' ? undefined : next,
                },
              })
            }
          />
        ) : null
      }
    >
      {tooShort ? (
        <PageNote icon={<Sparkles aria-hidden="true" />} title="至少输入 2 个字符" />
      ) : null}
      {loaded && !canInstall ? <PageNote title="当前账户没有安装市场技能的权限" /> : null}
      {skills.isPending ? <LoadingState rows={8} layout="list" /> : null}
      {skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
      ) : null}
      {loaded && !tooShort && (market.isPending || market.isDebouncing) ? (
        <LoadingState rows={8} layout="list" />
      ) : null}
      {loaded && !tooShort && !market.isPending && !market.isDebouncing && market.isError ? (
        <ErrorState error={market.error} onRetry={() => void market.refetch()} />
      ) : null}
      {loaded &&
      !tooShort &&
      !market.isPending &&
      !market.isDebouncing &&
      market.data &&
      market.data.length === 0 ? (
        <PageNote
          icon={<BusinessIllustration name={term ? 'search' : 'tools'} size="compact" />}
          title={term ? '没有匹配的技能' : '榜单为空'}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={term ? clearSearch : () => void market.refetch()}
            >
              {term ? '清除搜索' : '刷新榜单'}
            </Button>
          }
        />
      ) : null}
      {loaded &&
      !tooShort &&
      !market.isPending &&
      !market.isDebouncing &&
      market.data &&
      market.data.length > 0 ? (
        <div className="@container">
          <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 @4xl:grid-cols-2">
            {market.data.map((item) => {
              const installed = installedIds.has(item.id);
              const pending = install.isPending && install.variables?.id === item.id;
              return (
                <li key={item.id} className="min-w-0">
                  <div className="flex min-w-0 items-center gap-3 px-2 py-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-item bg-muted text-muted-foreground">
                      <Sparkles aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-base font-medium text-fg" title={item.name}>
                        {item.name}
                      </h2>
                      <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate font-mono" title={item.source}>
                          {item.source}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{formatTokens(item.installs)} 次安装</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={installed || install.isPending || !canInstall}
                      aria-busy={pending}
                      aria-label={
                        installed
                          ? `${item.name} 已安装`
                          : canInstall
                            ? `安装 ${item.name}`
                            : `${item.name} 无法安装：当前账户没有安装市场技能的权限`
                      }
                      title={
                        !installed && !canInstall ? '当前账户没有安装市场技能的权限' : undefined
                      }
                      onClick={() => installSkill(item)}
                    >
                      {installed ? '已安装' : pending ? '安装中…' : '安装'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </ResourcePage>
  );
}

export function SkillDialog({
  skill,
  readOnly = false,
  canReadFiles = true,
  canWriteFiles = true,
  onClose: onClosed,
  finalFocus,
}: {
  skill?: Skill;
  readOnly?: boolean;
  canReadFiles?: boolean;
  canWriteFiles?: boolean;
  onClose: () => void;
  finalFocus?: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const [initial] = useState<SkillInput>(() =>
    skill
      ? {
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          body: skill.body,
        }
      : emptySkill,
  );
  const rhf = useZodForm(skillFormSchema, { defaultValues: initial });
  const errors = rhf.formState.errors;
  const [filesDirty, setFilesDirty] = useState(false);
  const [filesSaving, setFilesSaving] = useState(false);
  const [baseline, setBaseline] = useState(skill?.updatedAt);
  const formId = skill ? 'skill-edit-form' : 'skill-create-form';
  const dirty = rhf.formState.isDirty || filesDirty;
  const pending = create.isPending || update.isPending || filesSaving;
  const guard = useDraftGuard(dirty, pending, onClose);

  const submit = rhf.handleSubmit((values) => {
    if (readOnly || pending) return;
    const onError = (error: unknown): void => {
      if (error instanceof ApiError && error.code === 'CONFLICT_STALE') {
        toast.error('配置已被修改，请关闭并重新打开以加载最新版本。');
        return;
      }
      toastError(error);
    };
    if (skill) {
      update.mutate(
        { id: skill.id, input: values, expectedUpdatedAt: baseline ?? skill.updatedAt },
        {
          onSuccess: (saved) => {
            toastSuccess('技能已更新');
            rhf.reset(values);
            setBaseline(saved.updatedAt);
            if (!filesDirty) guard.finish();
          },
          onError,
        },
      );
    } else {
      create.mutate(values, {
        onSuccess: () => {
          toastSuccess('技能已创建');
          guard.finish();
        },
        onError,
      });
    }
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={skill ? (readOnly ? `查看「${skill.name}」` : '编辑技能') : '新建技能'}
        closeDisabled={pending}
        finalFocus={finalFocus}
        footer={
          <div className={cn('flex justify-end gap-2', pending && 'opacity-80')}>
            {readOnly ? (
              <Button variant="outline" onClick={guard.close} disabled={pending}>
                关闭
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={guard.close} disabled={pending}>
                  取消
                </Button>
                <Button type="submit" form={formId} aria-busy={pending} disabled={pending}>
                  {pending ? '保存中…' : '保存'}
                </Button>
              </>
            )}
          </div>
        }
      >
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (readOnly) return;
            return submit();
          }}
          className="flex flex-col gap-4"
          noValidate
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field data-disabled={pending} className="gap-1.5" data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="skill-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('name')}
                id="skill-name"
                disabled={pending}
                readOnly={readOnly}
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'skill-name-error' : undefined}
              />
              <FieldError id="skill-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.slug)}
              data-disabled={pending || Boolean(skill)}
            >
              <FieldLabel htmlFor="skill-slug">
                Slug <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('slug')}
                id="skill-slug"
                disabled={pending || Boolean(skill)}
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'skill-slug-error' : 'skill-slug-hint'}
                className="font-mono"
              />
              {skill ? (
                <FieldDescription id="skill-slug-hint">创建后不可修改。</FieldDescription>
              ) : (
                <FieldError id="skill-slug-error">{errors.slug?.message}</FieldError>
              )}
            </Field>
          </FieldGroup>
          <Field
            data-disabled={pending}
            className="gap-1.5"
            data-invalid={Boolean(errors.description)}
          >
            <FieldLabel htmlFor="skill-desc">
              描述 <RequiredMark />
            </FieldLabel>
            <Input
              {...rhf.register('description')}
              id="skill-desc"
              disabled={pending}
              readOnly={readOnly}
              aria-required="true"
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'skill-desc-error' : undefined}
              placeholder="一句话说明这个技能解决什么问题"
            />
            <FieldError id="skill-desc-error">{errors.description?.message}</FieldError>
          </Field>
          <Field data-disabled={pending} className="gap-1.5">
            <FieldLabel htmlFor="skill-body">步骤</FieldLabel>
            <Controller
              control={rhf.control}
              name="body"
              render={({ field }) => (
                <SourceEditor
                  id="skill-body"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  language="markdown"
                  // label[for] 对 contenteditable 无效，可访问名称落在编辑器表面。
                  aria-label="步骤"
                  disabled={pending}
                  readOnly={readOnly}
                  className="min-h-64"
                />
              )}
            />
            <FieldDescription>支持 Markdown。</FieldDescription>
          </Field>
          {skill ? (
            <SkillFilesEditor
              skillId={skill.id}
              canRead={canReadFiles}
              readOnly={!canWriteFiles}
              disabled={pending}
              onDirtyChange={setFilesDirty}
              onSavingChange={setFilesSaving}
            />
          ) : null}
        </form>
        <DraftGuardDialogs
          guard={guard}
          draft="技能内容与支持文件草稿会丢失。"
          closeDraft="技能内容与未添加完的支持文件会丢失。"
          pending={pending}
        />
      </DialogShell>
    </Dialog>
  );
}

function SkillFilesEditor({
  skillId,
  canRead,
  readOnly,
  disabled,
  onDirtyChange,
  onSavingChange,
}: {
  skillId: string;
  canRead: boolean;
  readOnly: boolean;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const client = useQueryClient();
  const files = useQuery({
    queryKey: ['skill-files', skillId],
    queryFn: () => api.skillFiles(skillId),
    enabled: canRead,
  });
  const rhf = useZodForm(skillFileFormSchema, { defaultValues: emptySkillFile });
  const error = rhf.formState.errors.path?.message ?? rhf.formState.errors.content?.message ?? '';
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null);
  const pending = disabled || busy;
  const canReadRef = useRef(canRead);
  useEffect(() => {
    canReadRef.current = canRead;
  }, [canRead]);

  useEffect(() => onDirtyChange(rhf.formState.isDirty), [rhf.formState.isDirty, onDirtyChange]);
  useEffect(() => onSavingChange(busy), [busy, onSavingChange]);

  const filesKey = ['skill-files', skillId];
  const invalidate = (refetchType: 'active' | 'none' = 'active'): void =>
    void client.invalidateQueries({ queryKey: filesKey, refetchType });
  const writeToCache = (update: (current: SkillFile[]) => SkillFile[]): void => {
    client.setQueryData<SkillFile[]>(filesKey, (current) => (current ? update(current) : current));
  };

  const selectFile = (path: string, content: string): void => {
    setEditingPath(path);
    rhf.reset({ path, content });
  };

  const startNew = (): void => {
    setEditingPath(null);
    rhf.reset(emptySkillFile);
  };

  const switchTo = (action: () => void): void => {
    if (!canRead || pending) return;
    if (rhf.formState.isDirty) setPendingSwitch(() => action);
    else action();
  };

  const save = rhf.handleSubmit(async (values) => {
    if (!canRead || readOnly || pending) return;
    setBusy(true);
    try {
      const saved = await api.writeSkillFile(skillId, values.path, values.content);
      writeToCache((current) =>
        current.some((file) => file.path === saved.path)
          ? current.map((file) => (file.path === saved.path ? saved : file))
          : [...current, saved],
      );
      invalidate('none');
      if (canReadRef.current) {
        const refreshed = await files.refetch();
        if (refreshed.isError) {
          toastError(new Error('支持文件已保存，但列表刷新失败，请重试。'));
          return;
        }
      }
      if (editingPath) rhf.reset(values);
      else rhf.reset(emptySkillFile);
      toastSuccess(editingPath ? '支持文件已保存' : '已添加支持文件');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  });

  const remove = async (target: string): Promise<void> => {
    if (!canRead || readOnly) return;
    setBusy(true);
    try {
      await api.deleteSkillFile(skillId, target);
      writeToCache((current) => current.filter((file) => file.path !== target));
      if (editingPath === target) {
        setEditingPath(null);
        rhf.reset(emptySkillFile);
      }
      invalidate();
      toastSuccess('已删除支持文件');
    } finally {
      setBusy(false);
    }
  };

  if (!canRead) return null;

  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor="skill-file-path">支持文件</FieldLabel>
      {files.isPending ? <LoadingState rows={1} /> : null}
      {files.isError ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : null}
      {files.data && files.data.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {files.data.map((f) => (
            <li key={f.id} className="flex items-start justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${readOnly ? '查看' : '编辑'}支持文件 ${f.path}`}
                aria-pressed={editingPath === f.path}
                title={f.path}
                disabled={pending || files.isError}
                className="h-auto min-w-0 flex-1 justify-start px-1 py-0.5 text-left font-mono text-xs whitespace-normal break-all"
                onClick={() => switchTo(() => selectFile(f.path, f.content))}
              >
                {f.path}
              </Button>
              {readOnly ? null : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除支持文件 ${f.path}`}
                  disabled={pending}
                  onClick={() => setDeleteTarget(f.path)}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-col gap-2 rounded-item border border-line p-2">
        <Input
          {...rhf.register('path', { setValueAs: (value: string) => value.trim() })}
          id="skill-file-path"
          placeholder="scripts/run.sh 或 references/api.md"
          readOnly={readOnly || editingPath !== null}
          disabled={pending}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'skill-file-path-error' : undefined}
          className="font-mono text-xs"
        />
        <Controller
          control={rhf.control}
          name="content"
          render={({ field }) => (
            <SourceEditor
              id="skill-file-content"
              value={field.value ?? ''}
              onChange={field.onChange}
              onBlur={field.onBlur}
              language="text"
              aria-label="文件内容"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'skill-file-path-error' : undefined}
              disabled={pending}
              readOnly={readOnly}
            />
          )}
        />
        {error ? <FieldError id="skill-file-path-error">{error}</FieldError> : null}
        {readOnly ? null : (
          <div className="flex justify-end gap-2">
            {editingPath ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => switchTo(startNew)}
              >
                新建文件
              </Button>
            ) : null}
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={pending}
              onClick={() => void save()}
            >
              {busy ? '处理中…' : editingPath ? '保存文件' : '添加文件'}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        title="放弃未保存的文件更改？"
        description="切换文件或新建会丢失当前编辑内容。"
        confirmLabel="放弃更改"
        confirmDisabled={pending}
        onConfirm={async () => {
          pendingSwitch?.();
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="删除支持文件"
        description={`将删除「${deleteTarget ?? ''}」。此操作不可撤销。`}
        confirmLabel="删除文件"
        confirmDisabled={pending}
        onConfirm={() => (deleteTarget ? remove(deleteTarget) : Promise.resolve())}
      />
    </Field>
  );
}

function RejectSkillDialog({
  skill,
  onClose,
  finalFocus,
}: {
  skill: SkillWithAgentCount;
  onClose: () => void;
  finalFocus?: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClose);
  const reject = useRejectSkill();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pending = reject.isPending;

  const submit = (): void => {
    if (pending) return;
    const trimmed = note.trim();
    if (trimmed === '') {
      setError('请填写驳回原因');
      return;
    }
    setError(null);
    reject.mutate(
      { id: skill.id, note: trimmed },
      {
        onSuccess: () => {
          toastSuccess(`已驳回「${skill.name}」`);
          dialog.finish(onClose);
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, dialog.close)}
    >
      <DialogShell
        title="驳回技能"
        description={`驳回「${skill.name}」，修改后可再次提交审核。`}
        closeDisabled={pending}
        finalFocus={finalFocus}
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={dialog.close}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              aria-busy={pending}
              onClick={submit}
            >
              {pending ? '提交中…' : '驳回'}
            </Button>
          </div>
        }
      >
        <Field data-disabled={pending} data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="skill-reject-note">驳回原因</FieldLabel>
          <Textarea
            id="skill-reject-note"
            rows={3}
            maxLength={500}
            disabled={pending}
            placeholder="说明需要修改的内容"
            aria-required="true"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'skill-reject-note-error' : 'skill-reject-note-hint'}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldDescription id="skill-reject-note-hint">
            会记录在技能审核信息中，最长 500 个字符。
          </FieldDescription>
          <FieldError id="skill-reject-note-error">{error}</FieldError>
        </Field>
      </DialogShell>
    </Dialog>
  );
}

function DeleteSkillDialog({
  skill,
  onClose,
  finalFocus,
}: {
  skill: SkillWithAgentCount;
  onClose: () => void;
  finalFocus?: () => HTMLElement | null;
}) {
  const remove = useDeleteSkill();
  return (
    <ConfirmDialog
      open
      title="删除技能"
      description={
        skill.agentCount > 0
          ? `将删除「${skill.name}」。${skill.agentCount} 个智能体将失去该技能，需要重新绑定。`
          : `将删除「${skill.name}」。此操作不可撤销。`
      }
      confirmLabel="删除"
      finalFocus={finalFocus}
      onClose={onClose}
      onConfirm={async () => {
        await remove.mutateAsync(skill.id);
        toastSuccess('技能已删除');
      }}
    />
  );
}
