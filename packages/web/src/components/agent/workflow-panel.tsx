import type { AgentWorkflow } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { FileCode, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import {
  agentWorkflowsQuery,
  useCreateAgentWorkflow,
  useDeleteAgentWorkflow,
  useUpdateAgentWorkflow,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useEditStateNotify } from '../../lib/use-edit-state-notify.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { SourceEditor } from '../source-editor.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { Button } from '../ui/button.js';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';

type WorkflowAction =
  | { type: 'open'; workflow: AgentWorkflow }
  | { type: 'create' }
  | { type: 'delete'; workflow: AgentWorkflow };

/** 工作流：编辑 `.claude/workflows/<slug>.js`；名称与描述由脚本内的 meta 解析。 */
export function WorkflowsPanel({
  agentId,
  canWrite = true,
  onDirtyChange,
  onPendingChange,
}: {
  agentId: string;
  canWrite?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const workflows = useQuery(agentWorkflowsQuery(agentId));
  const create = useCreateAgentWorkflow();
  const update = useUpdateAgentWorkflow();
  const remove = useDeleteAgentWorkflow();
  const [selected, setSelected] = useState<string | null>(null);
  const autoSelected = useRef(false);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState<{ content: string; updatedAt: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WorkflowAction | null>(null);

  const current = workflows.data?.find((workflow) => workflow.id === selected) ?? null;
  const dirty = creating
    ? slug.trim() !== '' || draft !== ''
    : baseline !== null && draft !== baseline.content;
  const saving = create.isPending || update.isPending;
  const pending = saving || remove.isPending;

  const open = (workflow: AgentWorkflow): void => {
    setSelected(workflow.id);
    setDraft(workflow.content);
    setBaseline({ content: workflow.content, updatedAt: workflow.updatedAt });
    setCreating(false);
    setSlug('');
    setSaveError(null);
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    setSlug('');
    setDraft('');
    setBaseline(null);
    setSaveError(null);
  };

  const apply = (action: WorkflowAction): void => {
    if (pending) return;
    if (action.type === 'open') {
      open(action.workflow);
      return;
    }
    if (!canWrite) return;
    if (action.type === 'create') startCreate();
  };

  const guard = (action: WorkflowAction): void => {
    if (pending) return;
    if (action.type !== 'open' && !canWrite) return;
    if (dirty || action.type === 'delete') setConfirming(action);
    else apply(action);
  };

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  useEffect(() => {
    if (autoSelected.current || workflows.data === undefined) return;
    autoSelected.current = true;
    if (selected !== null || creating) return;
    const first = workflows.data[0];
    if (!first) return;
    setSelected(first.id);
    setDraft(first.content);
    setBaseline({ content: first.content, updatedAt: first.updatedAt });
  }, [workflows.data, selected, creating]);

  const saved = (workflow: AgentWorkflow, created: boolean): void => {
    toastSuccess(created ? '工作流已创建' : '工作流已保存');
    setSelected(workflow.id);
    setSlug('');
    setDraft(workflow.content);
    setBaseline({ content: workflow.content, updatedAt: workflow.updatedAt });
    setCreating(false);
    setSaveError(null);
  };

  const submit = (): void => {
    if (pending || !canWrite) return;
    if (creating) {
      const target = slug.trim();
      if (!target || !draft.trim()) return;
      create.mutate(
        { agentId, slug: target, content: draft },
        {
          onSuccess: (workflow) => saved(workflow, true),
          onError: (error) => setSaveError(errorMessage(error)),
        },
      );
      return;
    }
    if (!current || !baseline) return;
    update.mutate(
      {
        agentId,
        workflowId: current.id,
        content: draft,
        expectedUpdatedAt: baseline.updatedAt,
      },
      {
        onSuccess: (workflow) => saved(workflow, false),
        onError: (error) => setSaveError(errorMessage(error)),
      },
    );
  };

  if (workflows.isPending) return <LoadingState rows={2} />;
  if (workflows.data === undefined) {
    return <ErrorState error={workflows.error} onRetry={() => void workflows.refetch()} />;
  }

  if (workflows.data.length === 0 && !creating) {
    return (
      <EmptyState
        icon={<FileCode className="size-5" aria-hidden="true" />}
        title="还没有工作流"
        description="工作流把一段脚本保存为 .claude/workflows/<slug>.js，专家可在运行时按需触发。"
        action={
          canWrite ? (
            <Button disabled={pending} onClick={() => guard({ type: 'create' })}>
              <Plus data-icon="inline-start" /> 新建工作流
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <Button
          variant="outline"
          disabled={pending || !canWrite}
          onClick={() => guard({ type: 'create' })}
        >
          <Plus data-icon="inline-start" /> 新建工作流
        </Button>
        <ul className="flex flex-col gap-0.5">
          {workflows.data.map((workflow) => (
            <li key={workflow.id} className="min-w-0 max-w-full">
              <button
                type="button"
                disabled={pending}
                aria-current={workflow.id === selected ? 'true' : undefined}
                onClick={() => guard({ type: 'open', workflow })}
                className={cn(
                  'flex w-full max-w-full min-w-0 flex-col gap-0.5 rounded-item px-2 py-1.5 text-left transition-colors duration-150 ease-out-soft',
                  workflow.id === selected
                    ? 'bg-selected text-selected-foreground'
                    : 'hover:bg-hover',
                )}
              >
                <span className="w-full truncate text-sm font-medium">{workflow.name}</span>
                <span className="w-full truncate font-mono text-2xs text-muted-foreground">
                  workflows/{workflow.slug}.js
                </span>
                {workflow.description ? (
                  <span className="line-clamp-2 w-full text-xs text-muted-foreground">
                    {workflow.description}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {workflows.isError ? (
          <ErrorState error={workflows.error} onRetry={() => void workflows.refetch()} />
        ) : null}
        {creating || current ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-md font-semibold text-fg">
                {creating ? '新建工作流' : current?.name}
              </h2>
              {creating ? null : (
                <span className="font-mono text-xs text-muted-foreground">
                  workflows/{current?.slug}.js
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {current ? (
                  <Button
                    variant="destructive"
                    size="icon"
                    aria-label={`删除工作流 ${current.name}`}
                    title={`删除工作流 ${current.name}`}
                    disabled={pending || !canWrite}
                    onClick={() => guard({ type: 'delete', workflow: current })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
                <Button
                  onClick={submit}
                  disabled={
                    saving || !canWrite || !dirty || (creating && (!slug.trim() || !draft.trim()))
                  }
                  aria-busy={saving}
                >
                  {saving ? '保存中…' : '保存工作流'}
                </Button>
              </div>
            </div>
            {!creating && current?.description ? (
              <p className="text-sm text-muted-foreground">{current.description}</p>
            ) : null}
            <FieldGroup>
              <Field className="gap-1.5" data-disabled={pending || !canWrite}>
                <FieldLabel htmlFor="workflow-slug">文件名 slug</FieldLabel>
                <Input
                  id="workflow-slug"
                  value={creating ? slug : (current?.slug ?? '')}
                  placeholder="release-notes"
                  className="font-mono"
                  disabled={!creating || pending || !canWrite}
                  onChange={(event) => setSlug(event.target.value)}
                />
                {creating ? null : <FieldDescription>创建后不可修改</FieldDescription>}
              </Field>
              <Field className="gap-1.5" data-disabled={pending || !canWrite}>
                <FieldLabel htmlFor="workflow-content">脚本内容（JavaScript）</FieldLabel>
                <SourceEditor
                  id="workflow-content"
                  value={draft}
                  language="text"
                  aria-label="工作流脚本内容"
                  aria-describedby="workflow-content-hint"
                  disabled={pending || !canWrite}
                  onChange={(value) => {
                    setDraft(value);
                    setSaveError(null);
                  }}
                  className="min-h-72"
                />
                <FieldDescription id="workflow-content-hint">
                  首条语句须为{' '}
                  <code className="font-mono">
                    export const meta = {'{ name, description, ... }'}
                  </code>
                  ；name/description 必填，可加 phases 等字面量字段。
                </FieldDescription>
              </Field>
            </FieldGroup>
            {saveError ? (
              <p role="alert" className="text-sm text-danger">
                {saveError}
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState title="选择或新建工作流" />
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => {
          if (pending) return;
          setConfirming(null);
        }}
        title={
          confirming?.type === 'delete'
            ? dirty
              ? '放弃修改并删除？'
              : '删除工作流？'
            : '放弃未保存的修改？'
        }
        description={
          confirming?.type === 'delete'
            ? dirty
              ? `「${current?.name ?? ''}」还有未保存的内容，继续会放弃这些修改并删除该工作流，此操作不可撤销。`
              : `将删除「${confirming.workflow.name}」，此操作不可撤销。`
            : `「${current?.name ?? '新建工作流'}」还有未保存的内容，继续后会丢失。`
        }
        confirmLabel={
          confirming?.type === 'delete' && !dirty
            ? '删除'
            : confirming?.type === 'delete'
              ? '放弃并删除'
              : '放弃并继续'
        }
        confirmDisabled={pending || !canWrite}
        onConfirm={async () => {
          if (!canWrite) return;
          const action = confirming;
          if (action?.type === 'delete') {
            await remove.mutateAsync({ agentId, workflowId: action.workflow.id });
            toastSuccess('工作流已删除');
            if (selected === action.workflow.id) {
              setSelected(null);
              setBaseline(null);
            }
            setConfirming(null);
          } else {
            setConfirming(null);
            if (action) apply(action);
          }
        }}
      />
    </div>
  );
}
