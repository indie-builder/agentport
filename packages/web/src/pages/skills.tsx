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
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Path, PathValue } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import { PageNote } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ResourcePage } from '../components/resource-page.js';
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
import { Textarea } from '../components/ui/textarea.js';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { fieldErrors, useFormBlocker } from '../lib/form.js';
import { formatTokens } from '../lib/format.js';
import {
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
  path: z
    .string()
    .min(1, '不能为空，请填写后再保存')
    .max(200, '最多 200 个字符，请精简后再保存')
    .regex(
      /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/,
      '路径必须是相对路径，且不能包含 .. 或绝对路径',
    ),
  content: z.string().max(200_000, '最多 200000 个字符，请精简后再保存').default(''),
});

export function SkillsPage() {
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

  if (scope === 'market') return <MarketSkillsPage skills={skills} />;

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
          onChange={() =>
            void navigate({
              to: '/skills',
              search: (previous) => ({
                scope: 'market',
                ...(previous.sort ? { sort: previous.sort } : {}),
                ...(previous.marketView ? { marketView: previous.marketView } : {}),
              }),
            })
          }
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
          <Button
            variant="outline"
            disabled={importSkill.isPending}
            aria-busy={importSkill.isPending}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />{' '}
            {importSkill.isPending ? '导入中…' : '导入 SKILL.md'}
          </Button>
          <Button
            ref={createButtonRef}
            onClick={(event) => {
              actionTriggerRef.current = event.currentTarget;
              setCreating(true);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建技能
          </Button>
        </>
      }
    >
      {skills.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
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
                          <DropdownMenuItem onClick={() => setEditing(skill)}>
                            <Pencil /> 编辑
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            nativeButton={false}
                            render={<a href={`/api/skills/${skill.id}/file`} />}
                          >
                            <Download /> 导出 SKILL.md
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleting(skill)}
                          >
                            <Trash2 /> 删除
                          </DropdownMenuItem>
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
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="aria-pressed:bg-background aria-pressed:text-foreground"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function MarketSkillsPage({ skills }: { skills: ReturnType<typeof useSkills> }) {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/skills' });
  const view: MarketView = search.marketView ?? 'all-time';
  const query = search.q ?? '';
  const deferredQuery = useDeferredValue(query);
  const term = deferredQuery.trim();
  const tooShort = term.length === 1;
  const market = useMarketSkills(view, deferredQuery);
  const install = useInstallMarketSkill();
  const [installingId, setInstallingId] = useState<string | null>(null);
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
    if (install.isPending) return;
    setInstallingId(item.id);
    install.mutate(
      { id: item.id },
      {
        onSuccess: ({ skill, warnings }) => {
          toastSuccess(`已安装「${skill.name}」`);
          for (const warning of warnings) toast.info(warning);
        },
        onError: toastError,
        onSettled: () => setInstallingId(null),
      },
    );
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
      count={market.data?.length ?? 0}
      status={tooShort ? 'success' : market.status}
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
      {!tooShort && market.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {!tooShort && market.isError ? (
        <ErrorState error={market.error} onRetry={() => void market.refetch()} />
      ) : null}
      {!tooShort && market.data && market.data.length === 0 ? (
        <PageNote
          icon={<Sparkles aria-hidden="true" />}
          title={term ? '没有匹配的技能' : '榜单为空'}
          description={term ? '试试其他关键词。' : 'skills.sh 暂时没有返回榜单数据。'}
          action={
            term ? (
              <Button variant="outline" size="sm" onClick={clearSearch}>
                清除搜索
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {!tooShort && market.data && market.data.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {market.data.map((item, index) => {
            const installed = installedIds.has(item.id);
            const pending = installingId === item.id;
            return (
              <li key={item.id} className="min-w-0">
                <Card className="h-full">
                  <CardHeader className="grid-cols-[auto_minmax(0,1fr)]!">
                    <span className="flex size-10 shrink-0 items-center justify-center self-center rounded-item bg-muted font-mono text-sm text-muted-foreground">
                      #{index + 1}
                    </span>
                    <CardTitle className="col-start-2 min-w-0">
                      <h2 className="truncate" title={item.name}>
                        {item.name}
                      </h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-3">
                    <Badge variant="secondary" className="max-w-full font-mono">
                      <span className="truncate">{item.source}</span>
                    </Badge>
                  </CardContent>
                  <CardFooter className="mt-auto justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatTokens(item.installs)} 次安装
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={installed || install.isPending}
                      aria-busy={pending}
                      aria-label={installed ? `${item.name} 已安装` : `安装 ${item.name}`}
                      onClick={() => installSkill(item)}
                    >
                      {installed ? '已安装' : pending ? '安装中…' : '安装'}
                    </Button>
                  </CardFooter>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}
    </ResourcePage>
  );
}

function SkillDialog({
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
  const [form, setForm] = useState<SkillInput>(
    skill
      ? {
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          body: skill.body,
        }
      : emptySkill,
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 支持文件编辑器有自己的草稿与请求，它们的未保存/在途状态也要保护弹层关闭。
  const [filesDirty, setFilesDirty] = useState(false);
  const [filesSaving, setFilesSaving] = useState(false);
  const initial = useMemo<SkillInput>(
    () =>
      skill
        ? {
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            body: skill.body,
          }
        : emptySkill,
    [skill],
  );
  const rhf = useZodForm(skillFormSchema, { defaultValues: initial });
  const errors = rhf.formState.errors;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || filesDirty;

  const set = <K extends keyof SkillInput>(key: K, value: SkillInput[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    rhf.setValue(key as Path<SkillInput>, value as PathValue<SkillInput, Path<SkillInput>>);
    rhf.clearErrors(key);
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    const parsed = skillFormSchema.safeParse(form);
    if (!parsed.success) {
      rhf.clearErrors();
      for (const [path, message] of Object.entries(fieldErrors(parsed.error.issues))) {
        rhf.setError(path as keyof SkillInput, { type: 'validation', message });
      }
      return;
    }
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
        { id: skill.id, input: parsed.data, expectedUpdatedAt: skill.updatedAt },
        {
          onSuccess: () => {
            toastSuccess('技能已更新');
            onClose();
          },
          onError,
        },
      );
    } else {
      create.mutate(parsed.data, {
        onSuccess: () => {
          toastSuccess('技能已创建');
          onClose();
        },
        onError,
      });
    }
  };

  const pending = create.isPending || update.isPending || filesSaving;
  const blocker = useFormBlocker(dirty, pending);
  // 半填的配置不能因为 Esc / 点遮罩就消失：脏时先确认；请求中不能丢弃。
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
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
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field data-disabled={pending} className="gap-1.5" data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="skill-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('name')}
                id="skill-name"
                disabled={pending}
                value={form.name}
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'skill-name-error' : undefined}
                onChange={(event) => set('name', event.target.value)}
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
                value={form.slug}
                disabled={pending || Boolean(skill)}
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'skill-slug-error' : 'skill-slug-hint'}
                onChange={(event) => set('slug', event.target.value)}
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
              value={form.description}
              aria-required="true"
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'skill-desc-error' : undefined}
              onChange={(event) => set('description', event.target.value)}
              placeholder="一句话说明这个技能解决什么问题"
            />
            <FieldError id="skill-desc-error">{errors.description?.message}</FieldError>
          </Field>
          <Field data-disabled={pending} className="gap-1.5">
            <FieldLabel htmlFor="skill-body">步骤</FieldLabel>
            <Textarea
              {...rhf.register('body')}
              id="skill-body"
              disabled={pending}
              rows={10}
              value={form.body}
              onChange={(event) => set('body', event.target.value)}
              // Keep Markdown compact and monospaced with readable line spacing.
              className="font-mono text-xs leading-relaxed"
              placeholder="1. 先读取 …&#10;2. 再调用 mcp__…&#10;3. 最后汇总 …"
            />
            <FieldDescription>支持 Markdown。</FieldDescription>
          </Field>
          {skill ? (
            <SkillFilesEditor
              skillId={skill.id}
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
            if (!pending) onClose();
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
  onDirtyChange,
  onSavingChange,
}: {
  skillId: string;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const client = useQueryClient();
  const files = useQuery({
    queryKey: ['skill-files', skillId],
    queryFn: () => api.skillFiles(skillId),
  });
  const rhf = useZodForm(skillFileFormSchema, { defaultValues: { path: '', content: '' } });
  const path = rhf.watch('path');
  const content = rhf.watch('content');
  const error = rhf.formState.errors.path?.message ?? '';
  const [saving, setSaving] = useState(false);

  // 草稿与在途请求交回父级弹层，Esc / 点遮罩 / 取消都要先确认。
  useEffect(
    () => onDirtyChange(path.trim() !== '' || content !== ''),
    [path, content, onDirtyChange],
  );
  useEffect(() => onSavingChange(saving), [saving, onSavingChange]);

  const invalidate = (): void =>
    void client.invalidateQueries({ queryKey: ['skill-files', skillId] });

  const add = async (): Promise<void> => {
    const parsed = skillFileFormSchema.safeParse({ path, content });
    if (!parsed.success) {
      rhf.clearErrors();
      rhf.setError('path', {
        type: 'validation',
        message: parsed.error.issues[0]?.message ?? '路径不合法',
      });
      return;
    }
    setSaving(true);
    try {
      await api.writeSkillFile(skillId, parsed.data.path, parsed.data.content);
      rhf.reset();
      invalidate();
      toastSuccess('已添加支持文件');
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (target: string): Promise<void> => {
    try {
      await api.deleteSkillFile(skillId, target);
      invalidate();
      toastSuccess('已删除支持文件');
    } catch (err) {
      toastError(err);
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
            <li key={f.id} className="flex items-center justify-between gap-2">
              <code className="truncate font-mono text-xs text-fg">{f.path}</code>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除支持文件 ${f.path}`}
                onClick={() => void remove(f.path)}
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
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'skill-file-path-error' : undefined}
          className="font-mono text-xs"
        />
        <FieldLabel htmlFor="skill-file-content" className="sr-only">
          文件内容
        </FieldLabel>
        <Textarea
          {...rhf.register('content')}
          id="skill-file-content"
          rows={3}
          placeholder="文件内容"
          className="font-mono text-xs leading-relaxed"
        />
        {error ? <FieldError id="skill-file-path-error">{error}</FieldError> : null}
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void add()}
          >
            {saving ? '添加中…' : '添加文件'}
          </Button>
        </div>
      </div>
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
