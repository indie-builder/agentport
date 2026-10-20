import { type Skill, type SkillInput, skillInputSchema } from '@agentport/shared';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Page, PageHeader } from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { FieldError, FieldHint, Input } from '../components/ui/input.js';
import { Label, RequiredMark } from '../components/ui/label.js';
import { Textarea } from '../components/ui/textarea.js';
import { cn } from '../lib/cn.js';
import { fieldErrors } from '../lib/form.js';
import { useCreateSkill, useDeleteSkill, useSkills, useUpdateSkill } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

const emptySkill: SkillInput = { slug: '', name: '', description: '', body: '' };

export function SkillsPage() {
  const skills = useSkills();
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Page>
      <PageHeader
        title="技能"
        description="可复用的操作流程，渲染为 .claude/skills/<slug>/SKILL.md，供智能体按需读取。"
        actions={
          <Button ref={createButtonRef} size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> 新建技能
          </Button>
        }
      />

      {skills.isPending ? <LoadingState rows={4} /> : null}
      {skills.isError ? (
        <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
      ) : null}
      {skills.data && skills.data.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="size-5" />}
          title="还没有技能"
          description="把重复出现的步骤写成技能，多个智能体可以共享它。"
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> 新建技能
            </Button>
          }
        />
      ) : null}

      {skills.data && skills.data.length > 0 ? (
        <div className="grid border-t border-line md:grid-cols-2">
          {skills.data.map((skill) => (
            <div
              key={skill.id}
              className="group border-b border-line py-3 pr-4 transition-colors hover:bg-sunken/50 md:[&:nth-child(odd)]:border-r md:[&:nth-child(odd)]:pr-5 md:[&:nth-child(even)]:pl-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-base font-medium text-fg">{skill.name}</div>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <code className="font-mono text-2xs text-subtle">{skill.slug}</code>
                    <span className="text-2xs text-subtle">被 {skill.agentCount} 个智能体使用</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(skill)}>
                    <span className="sr-only">编辑 {skill.name}</span>
                    <Sparkles className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDeleting(skill)}
                    className="hover:text-danger"
                  >
                    <span className="sr-only">删除 {skill.name}</span>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
                {skill.description || '（无描述）'}
              </p>
              {skill.body ? (
                <p className="mt-2 line-clamp-2 border-t border-line/60 pt-2 text-2xs leading-relaxed text-subtle">
                  {skill.body}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {creating ? (
        <SkillDialog returnFocusRef={createButtonRef} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? <SkillDialog skill={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteSkillDialog skill={deleting} onClose={() => setDeleting(null)} /> : null}
    </Page>
  );
}

function SkillDialog({
  skill,
  onClose,
  returnFocusRef,
}: {
  skill?: Skill;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
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

  return (
    <Dialog
      open
      onClose={onClose}
      title={skill ? '编辑技能' : '新建技能'}
      description="技能内容会写入 SKILL.md 的正文。"
      {...(returnFocusRef ? { returnFocusRef } : {})}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="skill-name">
              名称 <RequiredMark />
            </Label>
            <Input
              id="skill-name"
              value={form.name}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'skill-name-error' : undefined}
              onChange={(event) => set('name', event.target.value)}
            />
            <FieldError id="skill-name-error">{errors.name}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-slug">
              Slug <RequiredMark />
            </Label>
            <Input
              id="skill-slug"
              value={form.slug}
              disabled={Boolean(skill)}
              aria-invalid={Boolean(errors.slug)}
              aria-describedby={errors.slug ? 'skill-slug-error' : 'skill-slug-hint'}
              onChange={(event) => set('slug', event.target.value)}
              className="font-mono"
            />
            {skill ? (
              <FieldHint id="skill-slug-hint">创建后不可修改：它对应目录名。</FieldHint>
            ) : (
              <FieldError id="skill-slug-error">{errors.slug}</FieldError>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-desc">
            描述 <RequiredMark />
          </Label>
          <Input
            id="skill-desc"
            value={form.description}
            aria-invalid={Boolean(errors.description)}
            aria-describedby={errors.description ? 'skill-desc-error' : undefined}
            onChange={(event) => set('description', event.target.value)}
            placeholder="一句话说明这个技能解决什么问题"
          />
          <FieldError id="skill-desc-error">{errors.description}</FieldError>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-body">步骤</Label>
          <Textarea
            id="skill-body"
            rows={10}
            value={form.body}
            onChange={(event) => set('body', event.target.value)}
            className="font-mono text-xs leading-relaxed"
            placeholder="1. 先读取 …&#10;2. 再调用 mcp__…&#10;3. 最后汇总 …"
          />
          <FieldHint>支持 Markdown，渲染为 SKILL.md 正文。</FieldHint>
        </div>
        <div className={cn('flex justify-end gap-2', pending && 'opacity-80')}>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteSkillDialog({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const remove = useDeleteSkill();
  return (
    <ConfirmDialog
      open
      title="删除技能"
      description={`将删除「${skill.name}」。已绑定的智能体会自动解除绑定。`}
      confirmLabel="删除"
      onClose={onClose}
      onConfirm={async () => {
        await remove.mutateAsync(skill.id);
        toastSuccess('技能已删除');
      }}
    />
  );
}
