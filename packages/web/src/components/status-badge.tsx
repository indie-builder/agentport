import type { RuntimeEnvironmentVersionStatus } from '@agentport/shared';
import { CircleAlert, CircleCheck, Clock, LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Badge } from './ui/badge.js';

const STATUS_TONE_VARIANT = {
  default: 'neutral',
  success: 'success',
  warn: 'warn',
  brand: 'brand',
  danger: 'danger',
  outline: 'subtle',
  mono: 'mono',
} as const;

type StatusTone = keyof typeof STATUS_TONE_VARIANT;

export function StatusBadge({
  tone = 'default',
  className,
  ...props
}: Omit<ComponentProps<typeof Badge>, 'variant' | 'size'> & { tone?: StatusTone }) {
  return <Badge variant={STATUS_TONE_VARIANT[tone]} size="tag" className={className} {...props} />;
}

const buildStatusMeta: Record<
  RuntimeEnvironmentVersionStatus,
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  queued: { label: '排队中', icon: Clock, className: 'text-muted-foreground' },
  building: { label: '构建中', icon: LoaderCircle, className: 'text-fg' },
  ready: { label: '就绪', icon: CircleCheck, className: 'text-success' },
  failed: { label: '失败', icon: CircleAlert, className: 'text-danger' },
};

export function BuildStatusLabel({ status }: { status: RuntimeEnvironmentVersionStatus }) {
  const meta = buildStatusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`flex items-center gap-1.5 ${meta.className}`}>
      <Icon
        className={status === 'building' ? 'size-3.5 animate-spin' : 'size-3.5'}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
}
