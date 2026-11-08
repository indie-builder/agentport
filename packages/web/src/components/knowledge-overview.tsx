import type { KnowledgeBase } from '@agentport/shared';
import { Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { useKnowledgeBaseSummary, useKnowledgeModelProfileSelections } from '../lib/queries.js';
import { DuplicateBaseDialog } from './knowledge-duplicate-dialog.js';
import { ExpertUsage } from './knowledge-expert-usage.js';
import { jobStatusLabel, jobStatusTone, jobTypeLabel } from './knowledge-shared.js';
import { PageSection, PageToolbar } from './page.js';
import { ErrorState, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';

function ConfigItem({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-fg">{value}</dd>
      {note ? <dd className="min-w-0 break-words text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

/** 汇总只带字符串类型；未知类型如实显示原值，不猜成某个已知任务。 */
function jobTypeName(type: string): string {
  return jobTypeLabel[type as keyof typeof jobTypeLabel] ?? type;
}

function CountItem({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="shrink-0 text-sm tabular-nums text-fg">{count}</dd>
    </div>
  );
}

/**
 * 概览只做查看与少量入口：配置、内容计数、使用此库的专家。
 * 模型名与计数都来自真实接口，读不到时如实标注，不猜默认值。
 */
export function KnowledgeOverview({
  base,
  canCreate,
  canReadAgents,
  onOpenJobs,
  onDuplicated,
}: {
  base: KnowledgeBase;
  canCreate: boolean;
  canReadAgents: boolean;
  onOpenJobs: () => void;
  onDuplicated: (baseId: string) => void;
}) {
  const summary = useKnowledgeBaseSummary(base.id);
  const profiles = useKnowledgeModelProfileSelections();
  const [duplicating, setDuplicating] = useState(false);
  const [duplicatedBaseId, setDuplicatedBaseId] = useState<string | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);

  // 弹层卸载、blocker 结算后再离开当前库。
  useEffect(() => {
    if (duplicating || duplicatedBaseId === null) return;
    setDuplicatedBaseId(null);
    onDuplicated(duplicatedBaseId);
  }, [duplicating, duplicatedBaseId, onDuplicated]);

  const profileName = (id: string | null): string => {
    if (id === null) return '未启用';
    if (profiles.isPending) return '加载中';
    if (profiles.isError) return '读取失败';
    return (profiles.data ?? []).find((profile) => profile.id === id)?.name ?? '已不可见';
  };

  const image = base.settings.imageProcessing;
  const lastJob = summary.data?.lastJob ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {base.description ? (
        <p className="min-w-0 break-words text-sm leading-relaxed text-fg">{base.description}</p>
      ) : null}
      {canCreate ? (
        <PageToolbar>
          <Button
            ref={copyButtonRef}
            variant="outline"
            className="ml-auto"
            onClick={() => setDuplicating(true)}
          >
            <Copy data-icon="inline-start" aria-hidden="true" /> 复制知识库
          </Button>
        </PageToolbar>
      ) : null}
      <PageSection
        title="配置"
        divided={false}
        actions={
          profiles.isError ? (
            <Button variant="link" size="xs" onClick={() => void profiles.refetch()}>
              重试
            </Button>
          ) : undefined
        }
      >
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          <ConfigItem label="向量模型" value={profileName(base.embeddingProfileId)} />
          <ConfigItem label="重排" value={profileName(base.rerankProfileId)} />
          <ConfigItem label="音频转录" value={profileName(base.asrProfileId)} />
          <ConfigItem
            label="分块"
            value={`${base.settings.chunkTokens} tokens · 重叠 ${base.settings.chunkOverlap}`}
          />
          <ConfigItem
            label="Wiki 自动更新"
            value={base.settings.wikiAutoUpdate ? '已开启' : '未开启'}
          />
          <ConfigItem
            label="图片处理"
            value={image.enabled ? '已启用' : '未启用'}
            note={
              image.enabled
                ? [
                    image.model,
                    image.imageVectorEnabled ? `图片向量 ≥ ${image.imageVectorMinScore}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : undefined
            }
          />
        </dl>
      </PageSection>
      <PageSection
        title="内容"
        actions={
          <Button variant="link" size="sm" onClick={onOpenJobs}>
            处理记录
          </Button>
        }
      >
        {summary.isPending ? <LoadingState rows={2} /> : null}
        {summary.isError ? (
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        ) : null}
        {summary.data ? (
          <>
            <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
              <CountItem label="文档" count={summary.data.documents} />
              <CountItem label="FAQ" count={summary.data.faqs} />
              <CountItem label="Wiki" count={summary.data.wikiPages} />
              <CountItem label="来源" count={summary.data.sources} />
              <CountItem label="文件夹" count={summary.data.folders} />
              <CountItem label="标签" count={summary.data.tags} />
            </dl>
            {lastJob ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-fg">{jobTypeName(lastJob.type)}</span>
                <StatusBadge tone={jobStatusTone[lastJob.status]}>
                  {jobStatusLabel[lastJob.status]}
                </StatusBadge>
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  title={formatDateTime(lastJob.updatedAt)}
                >
                  {formatRelative(lastJob.updatedAt)}
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </PageSection>
      {canReadAgents ? (
        <PageSection title="使用此库的专家">
          <ExpertUsage base={base} enabled showTitle={false} />
        </PageSection>
      ) : null}
      {duplicating ? (
        <DuplicateBaseDialog
          base={base}
          finalFocus={() => (copyButtonRef.current?.isConnected ? copyButtonRef.current : null)}
          onClose={() => setDuplicating(false)}
          onDuplicated={(baseId) => {
            setDuplicating(false);
            setDuplicatedBaseId(baseId);
          }}
        />
      ) : null}
    </div>
  );
}
