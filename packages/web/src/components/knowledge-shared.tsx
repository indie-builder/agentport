import { useEffect, useRef, useState } from 'react';
import type {
  KnowledgeContentKind,
  KnowledgeDocumentVersion,
  KnowledgeFolder,
  KnowledgeLocator,
  KnowledgeVersionOrigin,
} from '../lib/api.js';
import { ApiError } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import { ConfirmDialog } from './confirm-dialog.js';

export const documentStatusLabel = {
  pending: '排队',
  processing: '解析中',
  ready: '可检索',
  failed: '失败',
  disabled: '已停用',
} as const;

export const documentStatusTone = {
  pending: 'default',
  processing: 'warn',
  ready: 'success',
  failed: 'danger',
  disabled: 'outline',
} as const;

export const jobStatusLabel = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
} as const;

export const jobStatusTone = {
  queued: 'default',
  running: 'warn',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'outline',
} as const;

export const jobTypeLabel = {
  ingest: '文档摄取',
  reindex: '重建索引',
  sync: '来源同步',
  source_probe: '来源连接测试',
  wiki_generate: 'Wiki 生成',
  cleanup: '清理',
} as const;

export const sourceStatusLabel = {
  active: '启用',
  paused: '已暂停',
  auth_error: '凭证失效',
  disabled: '已停用',
} as const;

export const pageStatusLabel = {
  draft: '草稿',
  published: '已发布',
  stale: '待刷新',
  failed: '生成失败',
} as const;

export const contentKindLabel: Record<KnowledgeContentKind, string> = {
  document: '文档',
  faq: 'FAQ',
  wiki: 'Wiki',
};

export const originLabel: Record<KnowledgeVersionOrigin, string> = {
  source: '来源解析',
  manual: '人工编辑',
  faq: 'FAQ',
  wiki: 'Wiki',
};

/** 前端上传只做后缀/大小预检；格式与字节仍由后端按真实内容复核。 */
export const AUDIO_MAX_BYTES = 25_000_000;
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg']);
const AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/flac',
  'audio/ogg',
]);

export function isAudioUpload(file: { name: string; type: string }): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return (
    (extension !== undefined && AUDIO_EXTENSIONS.has(extension)) ||
    file.type.toLowerCase().startsWith('audio/') ||
    file.type.toLowerCase() === 'application/ogg'
  );
}

export function isAudioMimeType(mimeType: string): boolean {
  return AUDIO_MIME_TYPES.has(mimeType.split(';')[0]?.trim().toLowerCase() ?? '');
}

export function isTerminalJobStatus(status: string | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** 删除来源会级联删除它的任务：详情 404 表示任务已不存在，不是暂时故障。 */
export function isMissingJob(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function treeFolders(
  folders: KnowledgeFolder[],
): Array<{ id: string; label: string; depth: number }> {
  const byParent = new Map<string | null, KnowledgeFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentId, siblings);
  }
  const rows: Array<{ id: string; label: string; depth: number }> = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      rows.push({ id: folder.id, label: folder.name, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function versionLabel(version: KnowledgeDocumentVersion): string {
  return `v${version.version} · ${originLabel[version.origin] ?? version.origin}`;
}

function formatTimestamp(ms: number, withHours: boolean): string {
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return withHours
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
    : `${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** 两端用同一精度；0 是合法时码，所以只判 undefined。 */
function timeRangeLabel(fromMs: number, toMs: number): string {
  const withHours = fromMs >= 3_600_000 || toMs >= 3_600_000;
  return `${formatTimestamp(fromMs, withHours)}–${formatTimestamp(toMs, withHours)}`;
}

/** 定位只展示真实存在的字段；缺省不编造页码或坐标。 */
export function locatorLabel(locator: KnowledgeLocator | null | undefined): string | null {
  if (!locator) return null;
  const parts: string[] = [];
  if (locator.pageFrom !== undefined) {
    parts.push(
      locator.pageTo !== undefined && locator.pageTo !== locator.pageFrom
        ? `第 ${locator.pageFrom}–${locator.pageTo} 页`
        : `第 ${locator.pageFrom} 页`,
    );
  }
  if (locator.timeFromMs !== undefined && locator.timeToMs !== undefined) {
    parts.push(timeRangeLabel(locator.timeFromMs, locator.timeToMs));
  }
  if (locator.lineFrom !== undefined) {
    parts.push(
      locator.lineTo !== undefined && locator.lineTo !== locator.lineFrom
        ? `第 ${locator.lineFrom}–${locator.lineTo} 行`
        : `第 ${locator.lineFrom} 行`,
    );
  }
  if (locator.headingPath && locator.headingPath.length > 0) {
    parts.push(locator.headingPath.join(' › '));
  }
  if (locator.sheet) parts.push(`工作表 ${locator.sheet}`);
  if (locator.cellRange) parts.push(`单元格 ${locator.cellRange}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function scoreKindLabel(scoreKind: 'rrf' | 'rerank' | undefined): string {
  return scoreKind === 'rerank' ? '重排分数' : 'RRF 分数';
}

/** 弹层草稿保护：dirty 关闭先确认，pending 期间禁止关闭与路由离开。 */
export function useDraftGuard(dirty: boolean, pending: boolean, onClose: () => void) {
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
export function DraftGuardDialogs({
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
