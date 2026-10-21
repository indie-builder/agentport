import {
  type Skill,
  type SkillInput,
  type SkillWithAgentCount,
  skillInputSchema,
} from '@agentport/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
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
import { cn } from '../lib/cn.js';
import { fieldErrors } from '../lib/form.js';
import { useCreateSkill, useDeleteSkill, useSkills, useUpdateSkill } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

const emptySkill: SkillInput = { slug: '', name: '', description: '', body: '' };
const usageOptions = [
  { value: 'all', label: '全部技能' },
  { value: 'bound', label: '已绑定' },
  { value: 'unbound', label: '未绑定' },
];

export function SkillsPage() {
  const skills = useSkills();
  const navigate = useNavigate();
  const search = useSearch({ from: '/shell/skills' });
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const usage = search.usage ?? 'all';
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SkillWithAgentCount | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const actionTriggerRef = useRef<HTMLElement | null>(null);
  // 关闭后回到真实触发器；菜单项会随菜单卸载，所以记的是常驻的下拉触发器。
  const panelFocus = (): HTMLElement | null =>
    actionTriggerRef.current?.isConnected ? actionTriggerRef.current : null;
  const setFilter = (
    patch: { q?: string | undefined; usage?: 'bound' | 'unbound' | undefined },
    replace = false,
  ): void => {
    void navigate({ to: '/skills', search: (previous) => ({ ...previous, ...patch }), replace });
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
        <Button ref={createButtonRef} onClick={() => setCreating(true)}>
          <Plus data-icon="inline-start" aria-hidden="true" /> 新建技能
        </Button>
      }
    >
      {skills.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
      ) : null}
      {skills.data && skills.data.length === 0 ? (
        <PageNote
          icon={<Sparkles aria-hidden="true" />}
          title="还没有技能"
          description="把重复出现的步骤写成技能，多个专家可以共享它。"
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建技能
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
                      <DropdownMenuContent align="end" sideOffset={4} className="w-36">
                        <DropdownMenuGroup>
                          <DropdownMenuItem onClick={() => setEditing(skill)}>
                            <Pencil /> 编辑
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

      {creating ? (
        <SkillDialog
          finalFocus={() => (createButtonRef.current?.isConnected ? createButtonRef.current : null)}
          onClose={() => setCreating(false)}
        />
      ) : null}
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const set = <K extends keyof SkillInput>(key: K, value: SkillInput[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: '' }));
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const parsed = skillInputSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    const onError = (error: unknown): void => {
      toastError(error);
    };
    if (skill) {
      update.mutate(
        { id: skill.id, input: parsed.data },
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

  const pending = create.isPending || update.isPending;
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
        description="技能内容会写入 SKILL.md 的正文。"
        closeDisabled={pending}
        finalFocus={finalFocus}
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5" data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="skill-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                id="skill-name"
                value={form.name}
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'skill-name-error' : undefined}
                onChange={(event) => set('name', event.target.value)}
              />
              <FieldError id="skill-name-error">{errors.name}</FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.slug)}
              data-disabled={Boolean(skill)}
            >
              <FieldLabel htmlFor="skill-slug">
                Slug <RequiredMark />
              </FieldLabel>
              <Input
                id="skill-slug"
                value={form.slug}
                disabled={Boolean(skill)}
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'skill-slug-error' : 'skill-slug-hint'}
                onChange={(event) => set('slug', event.target.value)}
                // Keep the directory slug monospaced for literal identifier editing.
                className="font-mono"
              />
              {skill ? (
                <FieldDescription id="skill-slug-hint">
                  创建后不可修改：它对应目录名。
                </FieldDescription>
              ) : (
                <FieldError id="skill-slug-error">{errors.slug}</FieldError>
              )}
            </Field>
          </FieldGroup>
          <Field className="gap-1.5" data-invalid={Boolean(errors.description)}>
            <FieldLabel htmlFor="skill-desc">
              描述 <RequiredMark />
            </FieldLabel>
            <Input
              id="skill-desc"
              value={form.description}
              aria-required="true"
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'skill-desc-error' : undefined}
              onChange={(event) => set('description', event.target.value)}
              placeholder="一句话说明这个技能解决什么问题"
            />
            <FieldError id="skill-desc-error">{errors.description}</FieldError>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="skill-body">步骤</FieldLabel>
            <Textarea
              id="skill-body"
              rows={10}
              value={form.body}
              onChange={(event) => set('body', event.target.value)}
              // Keep Markdown compact and monospaced with readable line spacing.
              className="font-mono text-xs leading-relaxed"
              placeholder="1. 先读取 …&#10;2. 再调用 mcp__…&#10;3. 最后汇总 …"
            />
            <FieldDescription>支持 Markdown，渲染为 SKILL.md 正文。</FieldDescription>
          </Field>
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
          description="关闭后这段技能内容会丢失。"
          confirmLabel="放弃并关闭"
          onConfirm={async () => {
            onClose();
          }}
        />
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
          : `将删除「${skill.name}」。目前没有智能体绑定它。`
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
