import type { KnowledgeBase, KnowledgeBaseSettings } from '@agentport/shared';
import { knowledgeImageProcessingSchema } from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { can } from '../lib/access.js';
import { api, errorMessage, type KnowledgeModelProfile } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import {
  meQuery,
  useCreateKnowledgeModelProfile,
  useKnowledgeModelProfileSelections,
  useKnowledgeModelProfiles,
  useUpdateKnowledgeBase,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DialogShell } from './dialog-shell.js';
import { Collapsible, CollapsibleContent } from './motion-collapsible.js';
import { RequiredMark } from './required-mark.js';
import { ErrorState } from './states.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Dialog } from './ui/dialog.js';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field.js';
import { Input } from './ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';
import { Switch } from './ui/switch.js';
import { Textarea } from './ui/textarea.js';

const FAILURE_TEXT: Record<string, string> = {
  auth: '凭证被端点拒绝，请检查 API Key',
  rate_limit: '端点限流，请稍后重试',
  timeout: '端点超时，请检查地址与网络',
  unavailable: '连不上端点，请检查地址与网络',
  bad_response: '端点响应不符合 embedding/rerank/ASR 格式',
};

/** 弹层草稿保护：dirty 关闭先确认，pending 期间禁止关闭与路由离开。 */
function useDraftGuard(dirty: boolean, pending: boolean, onClose: () => void) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则其 resolver 永远挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };
  return { blocker, confirmDiscard, setConfirmDiscard, finish, close };
}

/** 弹层内统一的放弃草稿与路由离开确认。 */
function DraftGuardDialogs({
  guard,
  draft,
  pending,
}: {
  guard: ReturnType<typeof useDraftGuard>;
  draft: string;
  pending: boolean;
}) {
  return (
    <>
      <ConfirmDialog
        open={guard.confirmDiscard}
        onClose={() => guard.setConfirmDiscard(false)}
        title="放弃未保存的更改？"
        description={`关闭后${draft}`}
        confirmLabel="放弃并关闭"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (!pending) guard.finish();
        }}
      />
      <ConfirmDialog
        open={guard.blocker.status === 'blocked'}
        onClose={() => guard.blocker.reset?.()}
        title="放弃未保存的更改？"
        description={pending ? '正在保存，请等待请求完成。' : `离开后${draft}`}
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => guard.blocker.proceed()}
      />
    </>
  );
}

/** 库级设置：分块参数、Wiki 自动更新、重排 profile，以及整库重建入口。 */
export function KnowledgeSettingsDialog({
  base,
  onClose,
  finalFocus,
}: {
  base: KnowledgeBase;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const update = useUpdateKnowledgeBase();
  const profiles = useKnowledgeModelProfileSelections();
  const me = useQuery(meQuery);
  // 保存设置只需要 knowledge.update；重建会调用模型处理，单独要求 knowledge.execute。
  const canExecute = can(me.data, 'knowledge.execute');
  const client = useQueryClient();
  // 历史库的 wire 可能还没有图片设置；按共享 schema 的默认值补齐，避免读写 undefined。
  const [settings, setSettings] = useState<KnowledgeBaseSettings>(() => ({
    ...base.settings,
    imageProcessing: base.settings.imageProcessing ?? knowledgeImageProcessingSchema.parse({}),
  }));
  const [embeddingProfileId, setEmbeddingProfileId] = useState(base.embeddingProfileId);
  const [rerankProfileId, setRerankProfileId] = useState(base.rerankProfileId ?? 'none');
  const [asrProfileId, setAsrProfileId] = useState(base.asrProfileId ?? 'none');
  const [chunkTokens, setChunkTokens] = useState(String(base.settings.chunkTokens));
  const [chunkOverlap, setChunkOverlap] = useState(String(base.settings.chunkOverlap));
  const [errors, setErrors] = useState<{
    chunkTokens?: string;
    chunkOverlap?: string;
    imageModel?: string;
    imageAction?: string;
    imageVector?: string;
    imageVectorMinScore?: string;
  }>({});
  const [confirming, setConfirming] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const pending = update.isPending || rebuilding;
  const initialSignature = useRef(
    JSON.stringify({
      settings,
      embeddingProfileId,
      rerankProfileId,
      asrProfileId,
      chunkTokens,
      chunkOverlap,
    }),
  );
  const dirty =
    JSON.stringify({
      settings,
      embeddingProfileId,
      rerankProfileId,
      asrProfileId,
      chunkTokens,
      chunkOverlap,
    }) !== initialSignature.current;
  const guard = useDraftGuard(dirty, pending, onClose);
  const embedding = (profiles.data ?? []).filter(
    (profile) =>
      profile.kind === 'embedding' && (profile.enabled || profile.id === base.embeddingProfileId),
  );
  const rerank = (profiles.data ?? []).filter(
    (profile) =>
      profile.kind === 'rerank' && (profile.enabled || profile.id === base.rerankProfileId),
  );
  // 已绑定但停用的 ASR 仍保留在选项里，避免把停用静默换成别的模型。
  const asr = (profiles.data ?? []).filter(
    (profile) => profile.kind === 'asr' && (profile.enabled || profile.id === base.asrProfileId),
  );
  // 图片向量能力跟随当前所选 profile；历史库绑定的停用 profile 仍可能出现在列表里。
  const selectedEmbedding = (profiles.data ?? []).find(
    (profile) => profile.kind === 'embedding' && profile.id === embeddingProfileId,
  );
  const imageVectorsAvailable = selectedEmbedding?.supportsImageVectors === true;
  // profile 列表拿到之前不下结论，避免把「未加载」当成「不支持」而误拦保存。
  const imageVectorsBlocked = profiles.isSuccess && !imageVectorsAvailable;
  const image = settings.imageProcessing;
  const patchImage = (next: Partial<KnowledgeBaseSettings['imageProcessing']>): void =>
    setSettings({ ...settings, imageProcessing: { ...image, ...next } });

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    const tokens = Number(chunkTokens);
    const overlap = Number(chunkOverlap);
    const model = image.model?.trim() || null;
    const nextErrors: typeof errors = {};
    if (!Number.isInteger(tokens) || tokens < 200 || tokens > 4000) {
      nextErrors.chunkTokens = '分块长度需为 200–4000 的整数';
    }
    if (
      !Number.isInteger(overlap) ||
      overlap < 0 ||
      overlap >= (Number.isInteger(tokens) ? tokens : 200)
    ) {
      nextErrors.chunkOverlap = '分块重叠需为 0 到小于分块长度的整数';
    }
    if (image.enabled && model === null) {
      nextErrors.imageModel = '请填写视觉模型 ID';
    }
    if (image.enabled && !image.ocrEnabled && !image.captionEnabled) {
      nextErrors.imageAction = 'OCR 与图片描述至少开启一个';
    }
    if (image.imageVectorEnabled && (!image.enabled || imageVectorsBlocked)) {
      nextErrors.imageVector =
        image.enabled && imageVectorsBlocked
          ? '所选 embedding profile 不支持图片向量，请关闭「图片向量」后再保存'
          : '图片向量需要 Cohere embed-v4.0，并在 profile 里开启图片输入';
    }
    if (
      image.imageVectorEnabled &&
      (!Number.isFinite(image.imageVectorMinScore) ||
        image.imageVectorMinScore < -1 ||
        image.imageVectorMinScore > 1)
    ) {
      nextErrors.imageVectorMinScore = '向量最低分需为 -1 到 1 之间的数字';
    }
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    update.mutate(
      {
        baseId: base.id,
        patch: {
          // 只发送真正换绑的 profile；未换绑时保留后端当前的绑定不变。
          ...(embeddingProfileId === base.embeddingProfileId ? {} : { embeddingProfileId }),
          rerankProfileId: rerankProfileId === 'none' ? null : rerankProfileId,
          asrProfileId: asrProfileId === 'none' ? null : asrProfileId,
          settings: {
            ...settings,
            chunkTokens: tokens,
            chunkOverlap: overlap,
            imageProcessing: {
              ...image,
              enabled: image.enabled,
              model: image.enabled ? model : null,
              imageVectorEnabled: image.enabled && image.imageVectorEnabled,
            },
          },
        },
      },
      {
        onSuccess: () => {
          toastSuccess('知识库设置已保存');
          guard.finish();
        },
        onError: toastError,
      },
    );
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (pending) {
            details.cancel();
            return;
          }
          if (!next) guard.close();
        }}
      >
        <DialogShell title="知识库设置" closeDisabled={pending} finalFocus={finalFocus}>
          <form className="flex flex-col gap-4" noValidate onSubmit={save}>
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5 sm:col-span-2">
                <FieldLabel htmlFor="knowledge-settings-embedding">
                  Embedding <RequiredMark />
                </FieldLabel>
                <Select
                  value={embeddingProfileId}
                  disabled={pending || profiles.isPending || embedding.length === 0}
                  onValueChange={(next) => {
                    if (next !== null) setEmbeddingProfileId(next);
                  }}
                  items={embedding.map((profile) => ({ value: profile.id, label: profile.name }))}
                >
                  <SelectTrigger id="knowledge-settings-embedding" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {embedding.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {embeddingProfileId === base.embeddingProfileId ? null : (
                  <FieldDescription>
                    保存后立即切换检索模型；已有文档需重建后恢复向量检索。
                  </FieldDescription>
                )}
              </Field>
              <Field className="gap-1.5 sm:col-span-2">
                <FieldLabel htmlFor="knowledge-settings-rerank">重排</FieldLabel>
                <Select
                  value={rerankProfileId}
                  disabled={pending || profiles.isPending}
                  onValueChange={(next) => {
                    if (next !== null) setRerankProfileId(next);
                  }}
                  items={[
                    { value: 'none', label: '不启用' },
                    ...rerank.map((profile) => ({ value: profile.id, label: profile.name })),
                  ]}
                >
                  <SelectTrigger id="knowledge-settings-rerank" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">不启用</SelectItem>
                      {rerank.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-1.5" data-invalid={Boolean(errors.chunkTokens)}>
                <FieldLabel htmlFor="knowledge-settings-chunk-tokens">
                  分块长度（字符） <RequiredMark />
                </FieldLabel>
                <Input
                  id="knowledge-settings-chunk-tokens"
                  inputMode="numeric"
                  value={chunkTokens}
                  disabled={pending}
                  aria-invalid={Boolean(errors.chunkTokens)}
                  aria-describedby={
                    errors.chunkTokens ? 'knowledge-settings-chunk-tokens-error' : undefined
                  }
                  onChange={(event) => setChunkTokens(event.target.value)}
                />
                <FieldError id="knowledge-settings-chunk-tokens-error">
                  {errors.chunkTokens}
                </FieldError>
              </Field>
              <Field className="gap-1.5" data-invalid={Boolean(errors.chunkOverlap)}>
                <FieldLabel htmlFor="knowledge-settings-chunk-overlap">
                  分块重叠（字符） <RequiredMark />
                </FieldLabel>
                <Input
                  id="knowledge-settings-chunk-overlap"
                  inputMode="numeric"
                  value={chunkOverlap}
                  disabled={pending}
                  aria-invalid={Boolean(errors.chunkOverlap)}
                  aria-describedby={
                    errors.chunkOverlap ? 'knowledge-settings-chunk-overlap-error' : undefined
                  }
                  onChange={(event) => setChunkOverlap(event.target.value)}
                />
                <FieldError id="knowledge-settings-chunk-overlap-error">
                  {errors.chunkOverlap}
                </FieldError>
              </Field>
              <Field className="gap-1.5 sm:col-span-2">
                <FieldLabel htmlFor="knowledge-settings-asr">音频转录</FieldLabel>
                <Select
                  value={asrProfileId}
                  disabled={pending || profiles.isPending}
                  onValueChange={(next) => {
                    if (next !== null) setAsrProfileId(next);
                  }}
                  items={[
                    { value: 'none', label: '不启用' },
                    ...asr.map((profile) => ({
                      value: profile.id,
                      label: profile.enabled ? profile.name : `${profile.name}（已停用）`,
                    })),
                  ]}
                >
                  <SelectTrigger id="knowledge-settings-asr" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">不启用</SelectItem>
                      {asr.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id} disabled={!profile.enabled}>
                          {profile.name}
                          {profile.enabled ? null : '（已停用）'}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {profiles.isError ? (
                <div className="flex items-center gap-2 sm:col-span-2">
                  <FieldError>模型 profile 没有加载出来</FieldError>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={() => void profiles.refetch()}
                  >
                    重试
                  </Button>
                </div>
              ) : null}
            </FieldGroup>
            <Field orientation="horizontal" className="items-center gap-2">
              <Checkbox
                id="knowledge-settings-wiki-auto"
                checked={settings.wikiAutoUpdate}
                disabled={pending}
                onCheckedChange={(checked) => setSettings({ ...settings, wikiAutoUpdate: checked })}
              />
              <FieldLabel htmlFor="knowledge-settings-wiki-auto">
                文档更新后自动刷新 Wiki
              </FieldLabel>
            </Field>
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="knowledge-settings-image-enabled"
                  checked={image.enabled}
                  disabled={pending}
                  aria-label="图片处理"
                  onCheckedChange={(checked) =>
                    patchImage({
                      enabled: checked,
                      ...(checked ? {} : { imageVectorEnabled: false }),
                    })
                  }
                />
                <FieldLabel htmlFor="knowledge-settings-image-enabled">图片处理</FieldLabel>
              </div>
              <Collapsible open={image.enabled} className="empty:hidden">
                <CollapsibleContent animated>
                  <FieldGroup className="grid gap-3 sm:grid-cols-2">
                    <Field
                      className="gap-1.5 sm:col-span-2"
                      data-invalid={Boolean(errors.imageModel)}
                    >
                      <FieldLabel htmlFor="knowledge-settings-image-model">
                        视觉模型 <RequiredMark />
                      </FieldLabel>
                      <Input
                        id="knowledge-settings-image-model"
                        value={image.model ?? ''}
                        disabled={pending}
                        className="font-mono"
                        placeholder="网关支持的模型 ID"
                        aria-invalid={Boolean(errors.imageModel)}
                        aria-describedby={
                          errors.imageModel ? 'knowledge-settings-image-model-error' : undefined
                        }
                        onChange={(event) => patchImage({ model: event.target.value || null })}
                      />
                      <FieldError id="knowledge-settings-image-model-error">
                        {errors.imageModel}
                      </FieldError>
                    </Field>
                    <Field orientation="horizontal" className="items-center gap-2">
                      <Switch
                        id="knowledge-settings-image-ocr"
                        checked={image.ocrEnabled}
                        disabled={pending}
                        aria-label="OCR"
                        aria-invalid={Boolean(errors.imageAction)}
                        aria-describedby={
                          errors.imageAction ? 'knowledge-settings-image-action-error' : undefined
                        }
                        onCheckedChange={(checked) => patchImage({ ocrEnabled: checked })}
                      />
                      <FieldLabel htmlFor="knowledge-settings-image-ocr">OCR</FieldLabel>
                    </Field>
                    <Field orientation="horizontal" className="items-center gap-2">
                      <Switch
                        id="knowledge-settings-image-caption"
                        checked={image.captionEnabled}
                        disabled={pending}
                        aria-label="图片描述"
                        aria-invalid={Boolean(errors.imageAction)}
                        aria-describedby={
                          errors.imageAction ? 'knowledge-settings-image-action-error' : undefined
                        }
                        onCheckedChange={(checked) => patchImage({ captionEnabled: checked })}
                      />
                      <FieldLabel htmlFor="knowledge-settings-image-caption">图片描述</FieldLabel>
                    </Field>
                    <FieldError
                      id="knowledge-settings-image-action-error"
                      className="sm:col-span-2"
                    >
                      {errors.imageAction}
                    </FieldError>
                    <Field className="gap-1.5">
                      <FieldLabel htmlFor="knowledge-settings-image-language">描述语言</FieldLabel>
                      <Input
                        id="knowledge-settings-image-language"
                        value={image.descriptionLanguage}
                        disabled={pending}
                        maxLength={35}
                        onChange={(event) =>
                          patchImage({ descriptionLanguage: event.target.value })
                        }
                      />
                    </Field>
                    <Field className="gap-1.5 sm:col-span-2">
                      <FieldLabel htmlFor="knowledge-settings-image-instructions">
                        自定义指令
                      </FieldLabel>
                      <Textarea
                        id="knowledge-settings-image-instructions"
                        value={image.customInstructions}
                        disabled={pending}
                        maxLength={2000}
                        rows={2}
                        onChange={(event) => patchImage({ customInstructions: event.target.value })}
                      />
                    </Field>
                    <Field orientation="horizontal" className="items-center gap-2">
                      <Switch
                        id="knowledge-settings-image-vector"
                        checked={image.imageVectorEnabled}
                        disabled={pending || (imageVectorsBlocked && !image.imageVectorEnabled)}
                        aria-label="图片向量"
                        aria-invalid={Boolean(errors.imageVector)}
                        aria-describedby={
                          errors.imageVector ? 'knowledge-settings-image-vector-error' : undefined
                        }
                        onCheckedChange={(checked) => patchImage({ imageVectorEnabled: checked })}
                      />
                      <FieldLabel htmlFor="knowledge-settings-image-vector">图片向量</FieldLabel>
                    </Field>
                    <Field className="gap-1.5" data-invalid={Boolean(errors.imageVectorMinScore)}>
                      <FieldLabel htmlFor="knowledge-settings-image-min-score">
                        向量最低分
                      </FieldLabel>
                      <Input
                        id="knowledge-settings-image-min-score"
                        inputMode="decimal"
                        value={String(image.imageVectorMinScore)}
                        disabled={pending || (imageVectorsBlocked && !image.imageVectorEnabled)}
                        aria-invalid={Boolean(errors.imageVectorMinScore)}
                        aria-describedby={
                          errors.imageVectorMinScore
                            ? 'knowledge-settings-image-min-score-error'
                            : undefined
                        }
                        onChange={(event) =>
                          patchImage({ imageVectorMinScore: Number(event.target.value) })
                        }
                      />
                      <FieldError id="knowledge-settings-image-min-score-error">
                        {errors.imageVectorMinScore}
                      </FieldError>
                    </Field>
                    <FieldError
                      id="knowledge-settings-image-vector-error"
                      className="sm:col-span-2"
                    >
                      {errors.imageVector}
                    </FieldError>
                    {imageVectorsBlocked ? (
                      <FieldDescription className="sm:col-span-2">
                        所选 embedding profile 不支持图片向量；需要 Cohere embed-v4.0，并在模型
                        profile 里开启图片输入。
                      </FieldDescription>
                    ) : null}
                  </FieldGroup>
                </CollapsibleContent>
              </Collapsible>
            </div>
            <FieldDescription>
              分块参数只影响之后重新解析的文档；已有内容需要重建索引后才会改用新设置。
            </FieldDescription>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={update.isPending}>
                {update.isPending ? '保存中…' : '保存设置'}
              </Button>
            </div>
          </form>
          {canExecute ? (
            <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">重建全部索引</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || dirty}
                  aria-busy={rebuilding}
                  onClick={() => setConfirming(true)}
                >
                  {rebuilding ? '重建中…' : '重建全部索引'}
                </Button>
              </div>
              <FieldDescription>
                逐文档从原件生成并切换新版本，人工分块修改不会带入；失败文档保留原版本，已成功的文档不会回滚。
                {dirty ? '有未保存的设置，保存后才能重建。' : null}
              </FieldDescription>
            </div>
          ) : null}
          <DraftGuardDialogs guard={guard} draft="知识库设置草稿会丢失。" pending={pending} />
        </DialogShell>
      </Dialog>
      {confirming ? (
        <ConfirmDialog
          open
          title="重建全部索引"
          description="逐文档从原件生成并切换新版本，人工分块修改不会带入；失败文档保留原版本，已成功的文档不会回滚。"
          confirmLabel="确认重建"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            setRebuilding(true);
            try {
              await api.rebuildKnowledgeBase(base.id, { chunksOnly: false });
              void client.invalidateQueries({ queryKey: ['knowledge'] });
              toastSuccess('已开始重建全部索引');
            } finally {
              setRebuilding(false);
            }
          }}
        />
      ) : null}
    </>
  );
}

/** 列表 toolbar 入口：知识库依赖的 embedding/rerank profile 都在这里增改删测。 */
export function KnowledgeProfilesDialog({
  onClose,
  finalFocus,
}: {
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const client = useQueryClient();
  const profiles = useKnowledgeModelProfiles();
  const [editing, setEditing] = useState<KnowledgeModelProfile | 'new' | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeModelProfile | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  // 内联表单的草稿与保存状态提升到外层：关闭弹层、切换编辑对象都要先确认。
  const [formDirty, setFormDirty] = useState(false);
  const [formPending, setFormPending] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<(() => void) | null>(null);
  const guard = useDraftGuard(formDirty, formPending, onClose);
  const requestEditing = (next: KnowledgeModelProfile | 'new' | null): void => {
    if (formPending) return;
    const apply = (): void => {
      setFormDirty(false);
      setEditing(next);
    };
    if (formDirty) setConfirmSwitch(() => apply);
    else apply();
  };

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['knowledge'] });
  };

  const test = async (profile: KnowledgeModelProfile): Promise<void> => {
    setResults((prev) => ({ ...prev, [profile.id]: '测试中…' }));
    try {
      const result = await api.testKnowledgeModelProfile(profile.id);
      setResults((prev) => ({
        ...prev,
        [profile.id]: result.ok
          ? '连接正常'
          : (FAILURE_TEXT[result.kind ?? ''] ?? '端点返回异常，请检查配置'),
      }));
    } catch (error) {
      setResults((prev) => ({ ...prev, [profile.id]: errorMessage(error) }));
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (formPending) {
            details.cancel();
            return;
          }
          if (!next) guard.close();
        }}
      >
        <DialogShell
          title="模型配置"
          description="知识库的 embedding、重排与音频转录 profile；凭证只写不回显。"
          closeDisabled={formPending}
          finalFocus={finalFocus}
        >
          <div className="flex flex-col gap-4">
            {editing === null ? (
              <div className="flex justify-end">
                <Button size="sm" disabled={formPending} onClick={() => requestEditing('new')}>
                  新增 profile
                </Button>
              </div>
            ) : (
              <ProfileForm
                key={editing === 'new' ? 'new' : editing.id}
                profile={editing === 'new' ? null : editing}
                onCancel={() => requestEditing(null)}
                onSaved={() => {
                  // 保存成功会卸载表单，它的 finally 再也传不回 pending，必须在外层先解锁。
                  setFormPending(false);
                  setFormDirty(false);
                  setEditing(null);
                  refresh();
                }}
                onDirtyChange={setFormDirty}
                onPendingChange={setFormPending}
              />
            )}
            {profiles.isPending ? <p className="text-sm text-muted-foreground">加载中…</p> : null}
            {profiles.isError ? (
              <ErrorState
                title="模型 profile 没有加载出来"
                error={profiles.error}
                onRetry={() => void profiles.refetch()}
              />
            ) : null}
            {profiles.isSuccess && (profiles.data ?? []).length === 0 ? (
              <FieldDescription>
                还没有模型 profile；先新增一个 embedding 或 ASR profile。
              </FieldDescription>
            ) : null}
            <ul className="flex flex-col gap-2">
              {(profiles.data ?? []).map((profile) => (
                <li
                  key={profile.id}
                  className="flex flex-col gap-2 rounded-item border border-line p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {profile.name}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {profile.kind === 'embedding'
                            ? 'Embedding'
                            : profile.kind === 'rerank'
                              ? '重排'
                              : 'ASR 转录'}
                        </span>
                      </p>
                      <p className="truncate font-mono text-2xs text-muted-foreground">
                        {profile.model} · {profile.endpointUrl}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {profile.kind === 'embedding'
                          ? `维度固定 1024 · ${profile.embeddingProtocol === 'cohere_v2' ? 'Cohere v2' : 'OpenAI'}`
                          : profile.kind === 'rerank'
                            ? '无维度'
                            : 'OpenAI 转录（段级时间） · 请通过上传音频验证'}{' '}
                        · {profile.hasSecret ? '已保存密钥' : '无密钥'}
                        {profile.kind === 'embedding' && profile.imageInputEnabled
                          ? ' · 支持图片输入'
                          : ''}
                        {profile.enabled ? '' : ' · 已停用'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {profile.kind === 'asr' ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void test(profile)}
                          disabled={results[profile.id] === '测试中…'}
                        >
                          测试
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={formPending}
                        onClick={() => requestEditing(profile)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={formPending}
                        onClick={() => setDeleting(profile)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                  {results[profile.id] ? (
                    <p className="text-xs text-muted-foreground">{results[profile.id]}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <DraftGuardDialogs
            guard={guard}
            draft="模型 profile 草稿会丢失。"
            pending={formPending}
          />
          <ConfirmDialog
            open={confirmSwitch !== null}
            title="放弃未保存的更改？"
            description="切换编辑对象会丢弃当前 profile 草稿。"
            confirmLabel="放弃并切换"
            confirmDisabled={formPending}
            onClose={() => setConfirmSwitch(null)}
            onConfirm={async () => {
              const apply = confirmSwitch;
              setConfirmSwitch(null);
              apply?.();
            }}
          />
        </DialogShell>
      </Dialog>
      {deleting ? (
        <ConfirmDialog
          open
          title="删除模型 profile"
          description={`将删除「${deleting.name}」。仍被知识库使用时无法删除，需先在知识库设置里切换。`}
          confirmLabel="确认删除"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteKnowledgeModelProfile(deleting.id);
            refresh();
            toastSuccess('模型 profile 已删除');
          }}
        />
      ) : null}
    </>
  );
}

function ProfileForm({
  profile,
  onCancel,
  onSaved,
  onDirtyChange,
  onPendingChange,
}: {
  profile: KnowledgeModelProfile | null;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const create = useCreateKnowledgeModelProfile();
  const [kind, setKind] = useState<'embedding' | 'rerank' | 'asr'>(profile?.kind ?? 'embedding');
  const [name, setName] = useState(profile?.name ?? '');
  const [endpointUrl, setEndpointUrl] = useState(profile?.endpointUrl ?? '');
  const [model, setModel] = useState(profile?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'cohere_v2'>(
    profile?.embeddingProtocol ?? 'openai',
  );
  const [imageInput, setImageInput] = useState(profile?.imageInputEnabled ?? false);
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; endpointUrl?: string; model?: string }>({});
  const initial = useRef({
    kind: profile?.kind ?? 'embedding',
    name: profile?.name ?? '',
    endpointUrl: profile?.endpointUrl ?? '',
    model: profile?.model ?? '',
    protocol: profile?.embeddingProtocol ?? 'openai',
    imageInput: profile?.imageInputEnabled ?? false,
    enabled: profile?.enabled ?? true,
  }).current;
  const dirty =
    kind !== initial.kind ||
    name !== initial.name ||
    endpointUrl !== initial.endpointUrl ||
    model !== initial.model ||
    apiKey !== '' ||
    protocol !== initial.protocol ||
    imageInput !== initial.imageInput ||
    (kind === 'asr' && enabled !== initial.enabled);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onPendingChange(saving), [saving, onPendingChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const busy = saving;
  const imageCapable = kind === 'embedding' && protocol === 'cohere_v2' && model === 'embed-v4.0';

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    if (name.trim() === '') nextErrors.name = '请填写 profile 名称';
    if (endpointUrl.trim() === '') nextErrors.endpointUrl = '请填写 Endpoint URL';
    if (model.trim() === '') nextErrors.model = '请填写模型 ID';
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    const input = {
      name: name.trim(),
      endpointUrl: endpointUrl.trim(),
      model: model.trim(),
      // 图片输入只对 Cohere v2 的 embed-v4.0 生效；其他模型一律发 false。
      ...(kind === 'embedding'
        ? { embeddingProtocol: protocol, imageInputEnabled: imageCapable && imageInput }
        : {}),
      ...(kind === 'asr' ? { enabled } : {}),
      // 留空即保持原密钥；不回显，也不把空串当成清除。
      ...(apiKey === '' ? {} : { apiKey }),
    };
    setSaving(true);
    try {
      if (profile === null) {
        await create.mutateAsync({ kind, ...input });
      } else {
        await api.updateKnowledgeModelProfile(profile.id, input);
      }
      toastSuccess(profile === null ? '模型 profile 已创建' : '模型 profile 已保存');
      onSaved();
    } catch (error) {
      toastError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="flex flex-col gap-3 rounded-item border border-line p-3" onSubmit={save}>
      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        {profile === null ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-profile-kind">类型</FieldLabel>
            <Select
              value={kind}
              disabled={busy}
              onValueChange={(next) => {
                if (next === 'embedding' || next === 'rerank' || next === 'asr') setKind(next);
              }}
              items={[
                { value: 'embedding', label: 'Embedding' },
                { value: 'rerank', label: '重排' },
                { value: 'asr', label: 'ASR 转录' },
              ]}
            >
              <SelectTrigger id="knowledge-profile-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="embedding">Embedding</SelectItem>
                  <SelectItem value="rerank">重排</SelectItem>
                  <SelectItem value="asr">ASR 转录</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field className="gap-1.5" data-invalid={Boolean(errors.name)}>
          <FieldLabel htmlFor="knowledge-profile-name">
            名称 <RequiredMark />
          </FieldLabel>
          <Input
            id="knowledge-profile-name"
            value={name}
            disabled={busy}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? 'knowledge-profile-name-error' : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          <FieldError id="knowledge-profile-name-error">{errors.name}</FieldError>
        </Field>
        <Field className="gap-1.5 sm:col-span-2" data-invalid={Boolean(errors.endpointUrl)}>
          <FieldLabel htmlFor="knowledge-profile-endpoint">
            Endpoint URL <RequiredMark />
          </FieldLabel>
          <Input
            id="knowledge-profile-endpoint"
            value={endpointUrl}
            disabled={busy}
            placeholder="https://…"
            aria-invalid={Boolean(errors.endpointUrl)}
            aria-describedby={errors.endpointUrl ? 'knowledge-profile-endpoint-error' : undefined}
            onChange={(event) => setEndpointUrl(event.target.value)}
          />
          <FieldError id="knowledge-profile-endpoint-error">{errors.endpointUrl}</FieldError>
        </Field>
        <Field className="gap-1.5" data-invalid={Boolean(errors.model)}>
          <FieldLabel htmlFor="knowledge-profile-model">
            模型 <RequiredMark />
          </FieldLabel>
          <Input
            id="knowledge-profile-model"
            value={model}
            disabled={busy}
            className="font-mono"
            aria-invalid={Boolean(errors.model)}
            aria-describedby={errors.model ? 'knowledge-profile-model-error' : undefined}
            onChange={(event) => setModel(event.target.value)}
          />
          <FieldError id="knowledge-profile-model-error">{errors.model}</FieldError>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="knowledge-profile-key">API Key</FieldLabel>
          <Input
            id="knowledge-profile-key"
            type="password"
            value={apiKey}
            autoComplete="off"
            disabled={busy}
            placeholder={profile?.hasSecret ? '留空保持原密钥' : '可选'}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        {kind === 'embedding' ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-profile-protocol">Embedding 协议</FieldLabel>
            <Select
              value={protocol}
              disabled={busy}
              onValueChange={(next) => {
                if (next === 'openai' || next === 'cohere_v2') setProtocol(next);
              }}
              items={[
                { value: 'openai', label: 'OpenAI' },
                { value: 'cohere_v2', label: 'Cohere v2' },
              ]}
            >
              <SelectTrigger id="knowledge-profile-protocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="cohere_v2">Cohere v2</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </FieldGroup>
      {kind === 'asr' ? (
        <div className="flex flex-col gap-3">
          <FieldDescription>协议固定为 OpenAI 转录（段级时间）。</FieldDescription>
          <Field orientation="horizontal" className="items-center gap-2">
            <Switch
              id="knowledge-profile-enabled"
              checked={enabled}
              disabled={busy}
              aria-label="启用"
              onCheckedChange={setEnabled}
            />
            <FieldLabel htmlFor="knowledge-profile-enabled">启用</FieldLabel>
          </Field>
        </div>
      ) : null}
      {kind === 'embedding' ? (
        <>
          <Field orientation="horizontal" className="items-center gap-2">
            <Switch
              id="knowledge-profile-image-input"
              checked={imageCapable && imageInput}
              disabled={busy || !imageCapable}
              aria-label="图片输入"
              onCheckedChange={setImageInput}
            />
            <FieldLabel htmlFor="knowledge-profile-image-input">图片输入</FieldLabel>
          </Field>
          <FieldDescription>
            {imageCapable
              ? 'Embedding 维度固定 1024，不可配置。'
              : '仅 Cohere v2 协议的 embed-v4.0 支持图片输入；维度固定 1024。'}
          </FieldDescription>
        </>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </form>
  );
}
