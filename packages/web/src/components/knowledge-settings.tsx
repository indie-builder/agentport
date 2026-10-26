import type { KnowledgeBase, KnowledgeBaseSettings } from '@agentport/shared';
import { knowledgeImageProcessingSchema } from '@agentport/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, type KnowledgeModelProfile } from '../lib/api.js';
import {
  useCreateKnowledgeModelProfile,
  useKnowledgeModelProfiles,
  useUpdateKnowledgeBase,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DialogShell } from './dialog-shell.js';
import { RequiredMark } from './required-mark.js';
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
  bad_response: '端点响应不符合 embedding/rerank 格式',
};

/** 图片向量只接受与文本查询同空间的 Cohere v2 embed-v4.0。 */
function supportsImageVectors(profile: KnowledgeModelProfile | undefined): boolean {
  return (
    profile !== undefined &&
    profile.kind === 'embedding' &&
    profile.enabled &&
    profile.embeddingProtocol === 'cohere_v2' &&
    profile.model === 'embed-v4.0' &&
    profile.imageInputEnabled
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
  const profiles = useKnowledgeModelProfiles();
  const client = useQueryClient();
  // 历史库的 wire 可能还没有图片设置；按共享 schema 的默认值补齐，避免读写 undefined。
  const [settings, setSettings] = useState<KnowledgeBaseSettings>(() => ({
    ...base.settings,
    imageProcessing: base.settings.imageProcessing ?? knowledgeImageProcessingSchema.parse({}),
  }));
  const [rerankProfileId, setRerankProfileId] = useState(base.rerankProfileId ?? 'none');
  const [chunkTokens, setChunkTokens] = useState(String(base.settings.chunkTokens));
  const [chunkOverlap, setChunkOverlap] = useState(String(base.settings.chunkOverlap));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const pending = update.isPending || rebuilding;
  const rerank = (profiles.data ?? []).filter(
    (profile) =>
      profile.kind === 'rerank' && (profile.enabled || profile.id === base.rerankProfileId),
  );
  const embedding = (profiles.data ?? []).find(
    (profile) => profile.kind === 'embedding' && profile.id === base.embeddingProfileId,
  );
  const imageVectorsAvailable = supportsImageVectors(embedding);
  // profile 列表拿到之前不下结论，避免把「未加载」当成「不支持」而误拦保存。
  const imageVectorsBlocked = profiles.isSuccess && !imageVectorsAvailable;
  const image = settings.imageProcessing;
  const patchImage = (next: Partial<KnowledgeBaseSettings['imageProcessing']>): void =>
    setSettings({ ...settings, imageProcessing: { ...image, ...next } });

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    const tokens = Number(chunkTokens);
    const overlap = Number(chunkOverlap);
    if (!Number.isInteger(tokens) || tokens < 200 || tokens > 4000) {
      setError('分块长度需为 200–4000 的整数');
      return;
    }
    if (!Number.isInteger(overlap) || overlap < 0 || overlap >= tokens) {
      setError('分块重叠需为 0 到小于分块长度的整数');
      return;
    }
    const model = image.model?.trim() || null;
    if (image.enabled && (model === null || (!image.ocrEnabled && !image.captionEnabled))) {
      setError('开启图片处理需要视觉模型，且 OCR 与描述至少开启一个');
      return;
    }
    if (image.imageVectorEnabled && (!image.enabled || imageVectorsBlocked)) {
      setError('图片向量需要 Cohere embed-v4.0 且 profile 已开启图片输入');
      return;
    }
    if (
      image.imageVectorEnabled &&
      (!Number.isFinite(image.imageVectorMinScore) ||
        image.imageVectorMinScore < -1 ||
        image.imageVectorMinScore > 1)
    ) {
      setError('向量最低分需为 -1 到 1 之间的数字');
      return;
    }
    setError(null);
    update.mutate(
      {
        baseId: base.id,
        patch: {
          rerankProfileId: rerankProfileId === 'none' ? null : rerankProfileId,
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
          onClose();
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
          if (!next) onClose();
        }}
      >
        <DialogShell title="知识库设置" closeDisabled={pending} finalFocus={finalFocus}>
          <form className="flex flex-col gap-4" noValidate onSubmit={save}>
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5" data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="knowledge-settings-chunk-tokens">
                  分块长度（字符） <RequiredMark />
                </FieldLabel>
                <Input
                  id="knowledge-settings-chunk-tokens"
                  inputMode="numeric"
                  value={chunkTokens}
                  disabled={pending}
                  onChange={(event) => setChunkTokens(event.target.value)}
                />
              </Field>
              <Field className="gap-1.5" data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="knowledge-settings-chunk-overlap">
                  分块重叠（字符） <RequiredMark />
                </FieldLabel>
                <Input
                  id="knowledge-settings-chunk-overlap"
                  inputMode="numeric"
                  value={chunkOverlap}
                  disabled={pending}
                  onChange={(event) => setChunkOverlap(event.target.value)}
                />
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
              {image.enabled ? (
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  <Field className="gap-1.5 sm:col-span-2">
                    <FieldLabel htmlFor="knowledge-settings-image-model">
                      视觉模型 <RequiredMark />
                    </FieldLabel>
                    <Input
                      id="knowledge-settings-image-model"
                      value={image.model ?? ''}
                      disabled={pending}
                      className="font-mono"
                      placeholder="网关支持的模型 ID"
                      onChange={(event) => patchImage({ model: event.target.value || null })}
                    />
                  </Field>
                  <Field orientation="horizontal" className="items-center gap-2">
                    <Switch
                      id="knowledge-settings-image-ocr"
                      checked={image.ocrEnabled}
                      disabled={pending}
                      aria-label="OCR"
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
                      onCheckedChange={(checked) => patchImage({ captionEnabled: checked })}
                    />
                    <FieldLabel htmlFor="knowledge-settings-image-caption">图片描述</FieldLabel>
                  </Field>
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor="knowledge-settings-image-language">描述语言</FieldLabel>
                    <Input
                      id="knowledge-settings-image-language"
                      value={image.descriptionLanguage}
                      disabled={pending}
                      maxLength={35}
                      onChange={(event) => patchImage({ descriptionLanguage: event.target.value })}
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
                      disabled={pending || imageVectorsBlocked}
                      aria-label="图片向量"
                      onCheckedChange={(checked) => patchImage({ imageVectorEnabled: checked })}
                    />
                    <FieldLabel htmlFor="knowledge-settings-image-vector">图片向量</FieldLabel>
                  </Field>
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor="knowledge-settings-image-min-score">向量最低分</FieldLabel>
                    <Input
                      id="knowledge-settings-image-min-score"
                      inputMode="decimal"
                      value={String(image.imageVectorMinScore)}
                      disabled={pending || imageVectorsBlocked}
                      onChange={(event) =>
                        patchImage({ imageVectorMinScore: Number(event.target.value) })
                      }
                    />
                  </Field>
                  {imageVectorsBlocked ? (
                    <FieldDescription className="sm:col-span-2">
                      图片向量需要 Cohere embed-v4.0，并在模型 profile 里开启图片输入。
                    </FieldDescription>
                  ) : null}
                </FieldGroup>
              ) : null}
            </div>
            <FieldError>{error}</FieldError>
            <FieldDescription>
              分块参数只影响之后重新解析的文档；改完需要重建索引才会作用到已有内容。
            </FieldDescription>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={pending}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={update.isPending}>
                {update.isPending ? '保存中…' : '保存设置'}
              </Button>
            </div>
          </form>
          <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">重建全部索引</span>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-busy={rebuilding}
                onClick={() => setConfirming(true)}
              >
                {rebuilding ? '重建中…' : '重建全部索引'}
              </Button>
            </div>
            <FieldDescription>
              重新解析并向量化全部文档；未手动改过的分块会用当前设置重新生成。
            </FieldDescription>
          </div>
        </DialogShell>
      </Dialog>
      {confirming ? (
        <ConfirmDialog
          open
          title="重建全部索引"
          description="重建会用原件覆盖当前分块，手动改过的文案会丢失。只有确定不需要这些手改内容时再继续。"
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

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['knowledge'] });
  };

  const test = async (profile: KnowledgeModelProfile): Promise<void> => {
    setResults({ ...results, [profile.id]: '测试中…' });
    try {
      const result = await api.testKnowledgeModelProfile(profile.id);
      setResults({
        ...results,
        [profile.id]: result.ok
          ? '连接正常'
          : (FAILURE_TEXT[result.kind ?? ''] ?? '端点返回异常，请检查配置'),
      });
    } catch (error) {
      setResults({ ...results, [profile.id]: errorMessage(error) });
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogShell
          title="模型配置"
          description="知识库的 embedding 与重排 profile；凭证只写不回显。"
          finalFocus={finalFocus}
        >
          <div className="flex flex-col gap-4">
            {editing === null ? (
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setEditing('new')}>
                  新增 profile
                </Button>
              </div>
            ) : (
              <ProfileForm
                key={editing === 'new' ? 'new' : editing.id}
                profile={editing === 'new' ? null : editing}
                onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  refresh();
                }}
              />
            )}
            {profiles.isPending ? <p className="text-sm text-muted-foreground">加载中…</p> : null}
            {profiles.isError ? <FieldError>模型 profile 没有加载出来</FieldError> : null}
            {(profiles.data ?? []).length === 0 && !profiles.isPending ? (
              <FieldDescription>
                还没有模型 profile；先新增一个 embedding profile。
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
                          {profile.kind === 'embedding' ? 'Embedding' : '重排'}
                        </span>
                      </p>
                      <p className="truncate font-mono text-2xs text-muted-foreground">
                        {profile.model} · {profile.endpointUrl}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {profile.kind === 'embedding'
                          ? `维度固定 1024 · ${profile.embeddingProtocol === 'cohere_v2' ? 'Cohere v2' : 'OpenAI'}`
                          : '无维度'}{' '}
                        · {profile.hasSecret ? '已保存密钥' : '无密钥'}
                        {profile.kind === 'embedding' && profile.imageInputEnabled
                          ? ' · 支持图片输入'
                          : ''}
                        {profile.enabled ? '' : ' · 已停用'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void test(profile)}
                        disabled={results[profile.id] === '测试中…'}
                      >
                        测试
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(profile)}>
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
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
}: {
  profile: KnowledgeModelProfile | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const create = useCreateKnowledgeModelProfile();
  const [kind, setKind] = useState<'embedding' | 'rerank'>(profile?.kind ?? 'embedding');
  const [name, setName] = useState(profile?.name ?? '');
  const [endpointUrl, setEndpointUrl] = useState(profile?.endpointUrl ?? '');
  const [model, setModel] = useState(profile?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'cohere_v2'>(
    profile?.embeddingProtocol ?? 'openai',
  );
  const [imageInput, setImageInput] = useState(profile?.imageInputEnabled ?? false);
  const [saving, setSaving] = useState(false);
  const invalid = [name, endpointUrl, model].some((value) => value.trim() === '');
  const busy = saving;
  const imageCapable = kind === 'embedding' && protocol === 'cohere_v2' && model === 'embed-v4.0';

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const input = {
      name: name.trim(),
      endpointUrl: endpointUrl.trim(),
      model: model.trim(),
      // 图片输入只对 Cohere v2 的 embed-v4.0 生效；其他模型一律发 false。
      ...(kind === 'embedding'
        ? { embeddingProtocol: protocol, imageInputEnabled: imageCapable && imageInput }
        : {}),
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
                if (next === 'embedding' || next === 'rerank') setKind(next);
              }}
              items={[
                { value: 'embedding', label: 'Embedding' },
                { value: 'rerank', label: '重排' },
              ]}
            >
              <SelectTrigger id="knowledge-profile-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="embedding">Embedding</SelectItem>
                  <SelectItem value="rerank">重排</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field className="gap-1.5">
          <FieldLabel htmlFor="knowledge-profile-name">
            名称 <RequiredMark />
          </FieldLabel>
          <Input
            id="knowledge-profile-name"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field className="gap-1.5 sm:col-span-2">
          <FieldLabel htmlFor="knowledge-profile-endpoint">
            Endpoint URL <RequiredMark />
          </FieldLabel>
          <Input
            id="knowledge-profile-endpoint"
            value={endpointUrl}
            disabled={busy}
            placeholder="https://…"
            onChange={(event) => setEndpointUrl(event.target.value)}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="knowledge-profile-model">
            模型 <RequiredMark />
          </FieldLabel>
          <Input
            id="knowledge-profile-model"
            value={model}
            disabled={busy}
            className="font-mono"
            onChange={(event) => setModel(event.target.value)}
          />
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
        <Button type="submit" size="sm" disabled={busy || invalid} aria-busy={busy}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </form>
  );
}
