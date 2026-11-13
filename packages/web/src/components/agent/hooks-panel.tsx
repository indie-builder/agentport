import { type AgentHookFile, agentHookFilePathSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { FileCode, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import {
  agentHooksQuery,
  useDeleteAgentHookFile,
  useWriteAgentHookFile,
  useWriteAgentHooksSettings,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useEditStateNotify } from '../../lib/use-edit-state-notify.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { SourceEditor } from '../source-editor.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { Button } from '../ui/button.js';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';

function configText(config: Record<string, unknown> | null): string {
  return config === null ? '' : `${JSON.stringify(config, null, 2)}\n`;
}

function parseConfig(text: string): { config: Record<string, unknown> | null } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { config: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'hooks 配置必须是 JSON 对象' };
    }
    return { config: parsed as Record<string, unknown> };
  } catch {
    return { error: 'hooks 配置不是合法 JSON' };
  }
}

type HooksAction =
  | { type: 'select'; file: AgentHookFile }
  | { type: 'create' }
  | { type: 'delete'; file: AgentHookFile };

/** 文件型 hooks：编辑 `.claude/settings.json` 的 `hooks` 与 `.claude/hooks/**` 脚本。 */
export function HooksPanel({
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
  const hooks = useQuery(agentHooksQuery(agentId));
  const saveSettings = useWriteAgentHooksSettings();
  const saveFile = useWriteAgentHookFile();
  const removeFile = useDeleteAgentHookFile();

  const [enabled, setEnabled] = useState(false);
  const [configDraft, setConfigDraft] = useState('');
  const [baseline, setBaseline] = useState<{ enabled: boolean; config: string } | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [contentDraft, setContentDraft] = useState('');
  const [executable, setExecutable] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);

  const autoSelected = useRef(false);
  const [confirming, setConfirming] = useState<HooksAction | null>(null);

  const current = hooks.data?.files.find((file) => file.path === selected) ?? null;
  const settingsDirty =
    baseline !== null && (enabled !== baseline.enabled || configDraft !== baseline.config);
  const fileDirty = creating
    ? pathDraft.trim() !== '' || contentDraft !== ''
    : current !== null && (current.content !== contentDraft || current.executable !== executable);
  const dirty = settingsDirty || fileDirty;
  const saving = saveSettings.isPending || saveFile.isPending;
  const pending = saving || removeFile.isPending;

  useEffect(() => {
    const data = hooks.data;
    if (!data || baseline !== null) return;
    const text = configText(data.config);
    setEnabled(data.enabled);
    setConfigDraft(text);
    setBaseline({ enabled: data.enabled, config: text });
  }, [hooks.data, baseline]);

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  useEffect(() => {
    if (autoSelected.current || hooks.data === undefined) return;
    autoSelected.current = true;
    if (selected !== null || creating) return;
    const first = hooks.data.files[0];
    if (!first) return;
    setSelected(first.path);
    setContentDraft(first.content);
    setExecutable(first.executable);
  }, [hooks.data, selected, creating]);

  const open = (file: AgentHookFile): void => {
    setSelected(file.path);
    setContentDraft(file.content);
    setExecutable(file.executable);
    setCreating(false);
    setPathDraft('');
    setFileError(null);
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    setPathDraft('');
    setContentDraft('');
    setExecutable(true);
    setFileError(null);
  };

  const guard = (action: HooksAction): void => {
    if (pending) return;
    if (action.type !== 'select' && !canWrite) return;
    if (dirty || action.type === 'delete') setConfirming(action);
    else if (action.type === 'select') open(action.file);
    else if (action.type === 'create') startCreate();
  };

  const submitSettings = (): void => {
    if (pending || !canWrite || !baseline) return;
    const parsed = parseConfig(configDraft);
    if ('error' in parsed) {
      setSettingsError(parsed.error);
      return;
    }
    saveSettings.mutate(
      { agentId, enabled, config: parsed.config },
      {
        onSuccess: (data) => {
          const text = configText(data.config);
          setEnabled(data.enabled);
          setConfigDraft(text);
          setBaseline({ enabled: data.enabled, config: text });
          setSettingsError(null);
          toastSuccess('Hooks 设置已保存');
        },
        onError: (error) => setSettingsError(errorMessage(error)),
      },
    );
  };

  const submitFile = (): void => {
    if (pending || !canWrite) return;
    const path = creating ? pathDraft.trim() : (current?.path ?? '');
    const checked = agentHookFilePathSchema.safeParse(path);
    if (!checked.success) {
      setFileError(checked.error.issues[0]?.message ?? '路径无效');
      return;
    }
    saveFile.mutate(
      { agentId, path: checked.data, content: contentDraft, executable },
      {
        onSuccess: (file) => {
          setSelected(file.path);
          setPathDraft('');
          setContentDraft(file.content);
          setExecutable(file.executable);
          setCreating(false);
          setFileError(null);
          toastSuccess('Hooks 脚本已保存');
        },
        onError: (error) => setFileError(errorMessage(error)),
      },
    );
  };

  if (hooks.isPending) return <LoadingState rows={2} />;
  if (hooks.data === undefined) {
    return <ErrorState error={hooks.error} onRetry={() => void hooks.refetch()} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        role="note"
        className="flex items-start gap-2 rounded-item border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-fg"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <p>
          Hooks 会在沙箱内自动执行 shell 命令。只启用并配置你信任的脚本；关闭开关后不渲染、不执行。
        </p>
      </div>

      <FieldGroup>
        <Field className="gap-1.5" data-disabled={pending || !canWrite}>
          <div className="flex items-center gap-2">
            <Switch
              id="hooks-enabled"
              checked={enabled}
              disabled={pending || !canWrite}
              onCheckedChange={setEnabled}
            />
            <FieldLabel htmlFor="hooks-enabled">启用文件型 hooks</FieldLabel>
          </div>
          <FieldDescription>
            启用后把 `.claude/settings.json` 的 `hooks` 与 `.claude/hooks/**` 渲染进工作区。
          </FieldDescription>
        </Field>
        <Field className="gap-1.5" data-disabled={pending || !canWrite}>
          <FieldLabel htmlFor="hooks-config">hooks 配置（JSON）</FieldLabel>
          <SourceEditor
            id="hooks-config"
            value={configDraft}
            language="json"
            aria-label="hooks 配置"
            disabled={pending || !canWrite}
            onChange={(value) => {
              setConfigDraft(value);
              setSettingsError(null);
            }}
            className="min-h-40"
          />
          <FieldDescription>
            写入 `.claude/settings.json` 的 `hooks` 字段，结构与官方 settings 一致；留空表示不配置。
          </FieldDescription>
          {settingsError ? (
            <p role="alert" className="text-sm text-danger">
              {settingsError}
            </p>
          ) : null}
          <div>
            <Button
              onClick={submitSettings}
              disabled={saving || !canWrite || !settingsDirty}
              aria-busy={saveSettings.isPending}
            >
              {saveSettings.isPending ? '保存中…' : '保存 hooks 设置'}
            </Button>
          </div>
        </Field>
      </FieldGroup>

      <div className="border-t border-border pt-4">
        {hooks.data.files.length === 0 && !creating ? (
          <EmptyState
            icon={<FileCode className="size-5" aria-hidden="true" />}
            title="还没有 hook 脚本"
            description="脚本保存到 .claude/hooks/<path>，由上面的 hooks 配置按路径引用。"
            action={
              canWrite ? (
                <Button disabled={pending} onClick={() => guard({ type: 'create' })}>
                  <Plus data-icon="inline-start" /> 新建脚本
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-2">
              <Button
                variant="outline"
                disabled={pending || !canWrite}
                onClick={() => guard({ type: 'create' })}
              >
                <Plus data-icon="inline-start" /> 新建脚本
              </Button>
              <ul className="flex flex-col gap-0.5">
                {hooks.data.files.map((file) => (
                  <li key={file.path} className="min-w-0 max-w-full">
                    <button
                      type="button"
                      disabled={pending}
                      aria-current={file.path === selected ? 'true' : undefined}
                      onClick={() => guard({ type: 'select', file })}
                      className={cn(
                        'flex w-full max-w-full min-w-0 flex-col gap-0.5 rounded-item px-2 py-1.5 text-left transition-colors duration-150 ease-out-soft',
                        file.path === selected
                          ? 'bg-selected text-selected-foreground'
                          : 'hover:bg-hover',
                      )}
                    >
                      <span className="w-full truncate font-mono text-xs">hooks/{file.path}</span>
                      <span className="text-2xs text-muted-foreground">
                        {file.executable ? '可执行' : '不可执行'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              {creating || current ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="min-w-0 truncate text-md font-semibold text-fg">
                      {creating ? '新建 hook 脚本' : `hooks/${current?.path}`}
                    </h2>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      {current ? (
                        <Button
                          variant="destructive"
                          size="icon"
                          aria-label={`删除 hook 脚本 ${current.path}`}
                          title={`删除 hook 脚本 ${current.path}`}
                          disabled={pending || !canWrite}
                          onClick={() => guard({ type: 'delete', file: current })}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      ) : null}
                      <Button
                        onClick={submitFile}
                        disabled={
                          saving ||
                          !canWrite ||
                          (creating ? !pathDraft.trim() : !fileDirty) ||
                          (creating && contentDraft === '' && !pathDraft.trim())
                        }
                        aria-busy={saveFile.isPending}
                      >
                        {saveFile.isPending ? '保存中…' : '保存脚本'}
                      </Button>
                    </div>
                  </div>
                  <FieldGroup>
                    {creating ? (
                      <Field className="gap-1.5" data-disabled={pending || !canWrite}>
                        <FieldLabel htmlFor="hook-path">脚本路径</FieldLabel>
                        <Input
                          id="hook-path"
                          value={pathDraft}
                          placeholder="guard.sh"
                          className="font-mono"
                          disabled={pending || !canWrite}
                          onChange={(event) => {
                            setPathDraft(event.target.value);
                            setFileError(null);
                          }}
                        />
                        <FieldDescription>
                          相对 `.claude/hooks/` 的安全相对路径，不能包含绝对路径或 `..`。
                        </FieldDescription>
                      </Field>
                    ) : null}
                    <Field className="gap-1.5" data-disabled={pending || !canWrite}>
                      <FieldLabel htmlFor="hook-content">脚本内容</FieldLabel>
                      <SourceEditor
                        id="hook-content"
                        value={contentDraft}
                        language="text"
                        aria-label="hook 脚本内容"
                        disabled={pending || !canWrite}
                        onChange={(value) => {
                          setContentDraft(value);
                          setFileError(null);
                        }}
                        className="min-h-64"
                      />
                      <FieldDescription>
                        {`写入 .claude/hooks/${creating ? pathDraft.trim() || '<path>' : (current?.path ?? '')}。`}
                      </FieldDescription>
                    </Field>
                    <Field className="gap-1.5" data-disabled={pending || !canWrite}>
                      <div className="flex items-center gap-2">
                        <Switch
                          id="hook-executable"
                          checked={executable}
                          disabled={pending || !canWrite}
                          onCheckedChange={setExecutable}
                        />
                        <FieldLabel htmlFor="hook-executable">保留可执行位</FieldLabel>
                      </div>
                      <FieldDescription>
                        {'直接执行 .claude/hooks/<path> 的配置需要可执行位；用 bash 调用时可关闭。'}
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                  {fileError ? (
                    <p role="alert" className="text-sm text-danger">
                      {fileError}
                    </p>
                  ) : null}
                </>
              ) : (
                <EmptyState title="选择或新建 hook 脚本" />
              )}
            </div>
          </div>
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
              : '删除 hook 脚本？'
            : '放弃未保存的修改？'
        }
        description={
          confirming?.type === 'delete'
            ? dirty
              ? `「hooks/${confirming.file.path}」还有未保存的内容，继续会放弃这些修改并删除该脚本，此操作不可撤销。`
              : `将删除「hooks/${confirming.file.path}」，此操作不可撤销。`
            : '当前 hooks 还有未保存的内容，继续后会丢失。'
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
            await removeFile.mutateAsync({ agentId, path: action.file.path });
            toastSuccess('Hooks 脚本已删除');
            if (selected === action.file.path) {
              setSelected(null);
              setContentDraft('');
            }
            setConfirming(null);
          } else {
            setConfirming(null);
            if (action?.type === 'select') open(action.file);
            else if (action?.type === 'create') startCreate();
          }
        }}
      />
    </div>
  );
}
