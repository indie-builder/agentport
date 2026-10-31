import {
  type MarketSkill,
  type MarketView,
  type Skill,
  type SkillInput,
  type SkillWithAgentCount,
  skillFileInputSchema,
  skillInputSchema,
} from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import { PageNote } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ResourcePage } from '../components/resource-page.js';
import { SourceEditor } from '../components/source-editor.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
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
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.js';
import { ApiError, api } from '../lib/api.js';
import { can } from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { useFormBlocker } from '../lib/form.js';
import { formatTokens } from '../lib/format.js';
import {
  meQuery,
  useCreateSkill,
  useDeleteSkill,
  useImportSkillFile,
  useInstallMarketSkill,
  useMarketSkills,
  useSkills,
  useUpdateSkill,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const emptySkill: SkillInput = { slug: '', name: '', description: '', body: '' };
const emptySkillFile = { path: '', content: '' };
const maxSkillFileBytes = 131_072;
const usageOptions = [
  { value: 'all', label: '全部技能' },
  { value: 'bound', label: '已绑定' },
  { value: 'unbound', label: '未绑定' },
];
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
  // 表单只补中文必填/长度提示，规范路径（保留 SKILL.md、拒绝空段与 . / ..）仍由共享 schema 判定。
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
  const canImportSkill = can(me.data, 'skills.import');
  const canReadSkillFiles = can(me.data, 'skills.files.read');
  const canInstallMarket = can(me.data, 'market.install');
  const skills = useSkills();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/skills' });
  const scope = search.scope ?? 'internal';
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const usage = search.usage ?? 'all';
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SkillWithAgentCount | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importSkill = useImportSkillFile();
  // 安装生命周期放在常驻页上：切换 scope 卸载市场子页时，请求与提示仍然接得住。
  const install = useInstallMarketSkill();
  const actionTriggerRef = useRef<HTMLElement | null>(null);
  // 关闭后回到真实触发器；菜单项会随菜单卸载，所以记的是常驻的下拉触发器。
  const panelFocus = (): HTMLElement | null =>
    actionTriggerRef.current?.isConnected ? actionTriggerRef.current : createButtonRef.current;
  const setFilter = (
    patch: { q?: string | undefined; usage?: 'bound' | 'unbound' | undefined },
    replace = false,
  ): void => {
    void navigate({ to: '/skills', search: (previous) => ({ ...previous, ...patch }), replace });
  };
  const openMarket = (): void => {
    void navigate({
      to: '/skills',
      search: (previous) => ({
        scope: 'market',
        ...(previous.sort ? { sort: previous.sort } : {}),
        ...(previous.marketView ? { marketView: previous.marketView } : {}),
      }),
    });
  };
  const importSkillMd = async (file: File): Promise<void> => {
    if (file.size > maxSkillFileBytes) {
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
  const visibleSkills = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (skills.data ?? [])
      .filter(
        (skill) =>
          (usage === 'all' ||
            (usage === 'bound' ? skill.agentCount > 0 : skill.agentCount === 0)) &&
          [skill.name, skill.slug, skill.description, skill.body].some((value) =>
            value.toLocaleLowerCase().includes(term),
          ),
      )
      .sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }, [skills.data, query, sort, usage]);

  if (scope === 'market') {
    return (
      <MarketSkillsPage
        skills={skills}
        install={install}
        canInstall={canInstallMarket}
      />
    );
  }
  if (!canReadSkills && canReadMarket) {
    return (
      <MarketSkillsPage
        skills={skills}
        install={install}
        canInstall={canInstallMarket}
      />
    );
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
      status={skills.status}
      leadingFilters={
        <SegmentedToggle
          label="技能来源"
          value="internal"
          options={scopeOptions}
          onChange={openMarket}
        />
      }
      filters={
        <FilterSelect
          value={usage}
          onValueChange={(next) => {
            if (next !== 'all' && next !== 'bound' && next !== 'unbound') return;
            setFilter({ usage: next === 'all' ? undefined : next });
          }}
          options={usageOptions}
          label="按使用情况筛选"
          className="w-36"
        />
      }
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 先清空 value，同一个文件重试时才会再次触发 change。
              event.target.value = '';
              if (file) void importSkillMd(file);
            }}
          />
          {canImportSkill ? (
          <Button
            variant="outline"
            disabled={importSkill.isPending}
            aria-busy={importSkill.isPending}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />{' '}
            {importSkill.isPending ? '导入中…' : '导入 SKILL.md'}
          </Button>
          ) : null}
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
        </>
      }
    >
      {skills.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
      ) : null}
      {skills.data && skills.data.length === 0 ? (
        <PageNote
          icon={<Sparkles aria-hidden="true" />}
          title="技能库为空"
          action={
            <Button variant="outline" size="sm" onClick={openMarket}>
              前往市场
            </Button>
          }
        />
      ) : null}
      {skills.data && skills.data.length > 0 && visibleSkills.length === 0 ? (
        <PageNote
          icon={<Sparkles aria-hidden="true" />}
          title="没有匹配的技能"
          description="试试其他关键词或使用情况。"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilter({ q: undefined, usage: undefined })}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}

      {visibleSkills.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visibleSkills.map((skill) => (
            <li key={skill.id} className="min-w-0">
              <Card className="h-full">
                <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto]!">
                  <span className="row-span-2 flex size-10 shrink-0 items-center justify-center self-center rounded-item bg-muted text-muted-foreground">
                    <Sparkles aria-hidden="true" />
                  </span>
                  <CardTitle className="col-start-2 min-w-0">
                    <h2 className="min-w-0">
                      <Button
                        variant="ghost"
                        className="h-auto w-full min-w-0 justify-start p-0 text-base leading-snug font-medium"
                        onClick={(event) => {
                          actionTriggerRef.current = event.currentTarget;
                          setEditing(skill);
                        }}
                      >
                        <span className="truncate" title={skill.name}>
                          {skill.name}
                        </span>
                      </Button>
                    </h2>
                  </CardTitle>
                  <CardAction className="col-start-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`操作 ${skill.name}`}
                            onClick={(event) => {
                              actionTriggerRef.current = event.currentTarget;
                            }}
                          >
                            <MoreHorizontal />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                        <DropdownMenuGroup>
                          {canUpdateSkill ? (
                            <DropdownMenuItem onClick={() => setEditing(skill)}>
                              <Pencil /> 编辑
                            </DropdownMenuItem>
                          ) : null}
                          {canReadSkillFiles ? (
                            <DropdownMenuItem
                              nativeButton={false}
                              render={<a href={`/api/skills/${skill.id}/file`} />}
                            >
                              <Download /> 导出 SKILL.md
                            </DropdownMenuItem>
                          ) : null}
                          {canDeleteSkill ? (
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleting(skill)}
                            >
                              <Trash2 /> 删除
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                  <CardDescription className="col-start-2 row-start-2 line-clamp-2 min-h-10">
                    {skill.description || '暂无描述'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <Badge variant="secondary" className="max-w-full font-mono">
                    <span className="truncate">{skill.slug}</span>
                  </Badge>
                  {skill.sourceId ? (
                    <Badge variant="outline" className="max-w-full font-mono">
                      <span className="truncate" title={skill.sourceId}>
                        来自 {skill.sourceId.split('/').slice(0, 2).join('/')}
                      </span>
                    </Badge>
                  ) : null}
                </CardContent>
                <CardFooter className="mt-auto justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    被 {skill.agentCount} 个专家使用
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`编辑 ${skill.name}`}
                    title={`编辑 ${skill.name}`}
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      actionTriggerRef.current = event.currentTarget;
                      setEditing(skill);
                    }}
                  >
                    编辑
                  </Button>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {creating ? <SkillDialog finalFocus={panelFocus} onClose={() => setCreating(false)} /> : null}
      {editing ? (
        <SkillDialog skill={editing} finalFocus={panelFocus} onClose={() => setEditing(null)} />
      ) : null}
      {deleting ? (
        <DeleteSkillDialog
          skill={deleting}
          finalFocus={panelFocus}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </ResourcePage>
  );
}

function SegmentedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      multiple={false}
      spacing={0}
      className="rounded-lg bg-muted text-muted-foreground"
      value={[value]}
      onValueChange={(values) => {
        const next = options.find((option) => option.value === values[0])?.value;
        if (next) onChange(next);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
      search: (previous) => ({ ...previous, q: undefined }),
      replace: true,
    });
  };
  const installSkill = (item: MarketSkill): void => {
    // 串行安装：只有全局 pending 结束才允许下一次点击。
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
          search: (previous) => ({ ...previous, q: next || undefined }),
          replace: true,
        })
      }
      sort="newest"
      onSortChange={() => {}}
      count={tooShort ? undefined : (market.data?.length ?? 0)}
      status={
        tooShort ? 'success' : market.isPending || market.isDebouncing ? 'pending' : market.status
      }
      hideSort
      leadingFilters={
        <SegmentedToggle
          label="技能来源"
          value="market"
          options={scopeOptions}
          onChange={() =>
            void navigate({
              to: '/skills',
              search: (previous) => ({
                ...(previous.sort ? { sort: previous.sort } : {}),
              }),
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
                search: (previous) => ({
                  ...previous,
                  marketView: next === 'all-time' ? undefined : next,
                }),
              })
            }
          />
        ) : null
      }
    >
      {tooShort ? (
        <PageNote
          icon={<Sparkles aria-hidden="true" />}
          title="至少输入 2 个字符"
          description="再多输入一个字符即可搜索市场。"
        />
      ) : null}
      {skills.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
      ) : null}
      {loaded && !tooShort && (market.isPending || market.isDebouncing) ? (
        <LoadingState rows={4} layout="cards" />
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
          icon={<Sparkles aria-hidden="true" />}
          title={term ? '没有匹配的技能' : '榜单为空'}
          description={term ? '试试其他关键词。' : 'skills.sh 暂时没有返回榜单数据。'}
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
                      disabled={installed || install.isPending}
                      aria-busy={pending}
                      aria-label={installed ? `${item.name} 已安装` : `安装 ${item.name}`}
                      className="transition-[color,background-color,border-color,opacity] duration-150 ease-out-soft"
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
  onClose,
  finalFocus,
}: {
  skill?: Skill;
  onClose: () => void;
  finalFocus?: () => HTMLElement | null;
}) {
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
  // RHF 是唯一数据源；支持文件编辑器有自己的草稿与请求，两者一起保护弹层关闭。
  const rhf = useZodForm(skillFormSchema, { defaultValues: initial });
  const errors = rhf.formState.errors;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  const [filesSaving, setFilesSaving] = useState(false);
  // 保存成功后只前进版本基线，弹层可继续编辑支持文件而不带旧版本号。
  const [baseline, setBaseline] = useState(skill?.updatedAt);
  const dirty = rhf.formState.isDirty || filesDirty;

  const submit = rhf.handleSubmit((values) => {
    if (pending) return;
    const onError = (error: unknown): void => {
      // 冲突时保留当前草稿，让用户关闭后重开拿到最新版本再决定。
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
            // 支持文件草稿由各自编辑器保存，主表单保存不丢弃它们。
            if (!filesDirty) finish();
          },
          onError,
        },
      );
    } else {
      create.mutate(values, {
        onSuccess: () => {
          toastSuccess('技能已创建');
          finish();
        },
        onError,
      });
    }
  });

  const pending = create.isPending || update.isPending || filesSaving;
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则它的 resolver 一直挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  // 半填的配置不能因为 Esc / 点遮罩就消失：脏时先确认；请求中不能丢弃。
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell
        title={skill ? '编辑技能' : '新建技能'}
        closeDisabled={pending}
        finalFocus={finalFocus}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
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
                // Keep the directory slug monospaced for literal identifier editing.
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
                  className="min-h-[16rem]"
                />
              )}
            />
            <FieldDescription>支持 Markdown。</FieldDescription>
          </Field>
          {skill ? (
            <SkillFilesEditor
              skillId={skill.id}
              disabled={pending}
              onDirtyChange={setFilesDirty}
              onSavingChange={setFilesSaving}
            />
          ) : null}
          <div className={cn('flex justify-end gap-2', pending && 'opacity-80')}>
            <Button variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" aria-busy={pending} disabled={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后技能内容与未添加完的支持文件会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={
            pending ? '正在保存，请等待请求完成。' : '离开后技能内容与支持文件草稿会丢失。'
          }
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}

/** 官方 SKILL.md 目录的支持资源文件（scripts/、references/ 等），随技能铺到工作区。 */
function SkillFilesEditor({
  skillId,
  disabled,
  onDirtyChange,
  onSavingChange,
}: {
  skillId: string;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const client = useQueryClient();
  const files = useQuery({
    queryKey: ['skill-files', skillId],
    queryFn: () => api.skillFiles(skillId),
  });
  const rhf = useZodForm(skillFileFormSchema, { defaultValues: emptySkillFile });
  const error = rhf.formState.errors.path?.message ?? rhf.formState.errors.content?.message ?? '';
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null);
  const pending = disabled || busy;

  // 草稿与在途请求交回父级弹层，Esc / 点遮罩 / 取消都要先确认。
  useEffect(() => onDirtyChange(rhf.formState.isDirty), [rhf.formState.isDirty, onDirtyChange]);
  useEffect(() => onSavingChange(busy), [busy, onSavingChange]);

  const invalidate = (): void =>
    void client.invalidateQueries({ queryKey: ['skill-files', skillId] });

  const selectFile = (path: string, content: string): void => {
    setEditingPath(path);
    rhf.reset({ path, content });
  };

  const startNew = (): void => {
    setEditingPath(null);
    rhf.reset(emptySkillFile);
  };

  // 切换文件/新建会覆盖当前草稿，脏时先确认。
  const switchTo = (action: () => void): void => {
    if (pending) return;
    if (rhf.formState.isDirty) setPendingSwitch(() => action);
    else action();
  };

  const save = rhf.handleSubmit(async (values) => {
    if (pending) return;
    setBusy(true);
    try {
      await api.writeSkillFile(skillId, values.path, values.content);
      // 等列表真正刷新后再解 busy：慢网下重选不能拿到旧内容覆盖刚保存的版本。
      const refreshed = await files.refetch();
      if (refreshed.isError) {
        toastError(new Error('支持文件已保存，但列表刷新失败，请重试。'));
        return;
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

  // 失败交给 ConfirmDialog 统一提示并保留确认框重试；这里吞错会让它误以为完成而关闭。
  const remove = async (target: string): Promise<void> => {
    setBusy(true);
    try {
      await api.deleteSkillFile(skillId, target);
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
                aria-label={`编辑支持文件 ${f.path}`}
                aria-pressed={editingPath === f.path}
                title={f.path}
                // 刷新失败时列表还是旧内容，重试成功前不能载入覆盖刚保存的版本。
                disabled={pending || files.isError}
                className="h-auto min-w-0 flex-1 justify-start px-1 py-0.5 text-left font-mono text-xs whitespace-normal break-all"
                onClick={() => switchTo(() => selectFile(f.path, f.content))}
              >
                {f.path}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除支持文件 ${f.path}`}
                disabled={pending}
                onClick={() => setDeleteTarget(f.path)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-col gap-2 rounded-item border border-line p-2">
        <Input
          {...rhf.register('path', { setValueAs: (value: string) => value.trim() })}
          id="skill-file-path"
          placeholder="scripts/run.sh 或 references/api.md"
          readOnly={editingPath !== null}
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
            />
          )}
        />
        {error ? <FieldError id="skill-file-path-error">{error}</FieldError> : null}
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
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void save()}
          >
            {busy ? '处理中…' : editingPath ? '保存文件' : '添加文件'}
          </Button>
        </div>
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
