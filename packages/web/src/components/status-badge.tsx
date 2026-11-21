import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Clock, LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { Badge } from './ui/badge.js';

const statusBadgeVariants = cva('rounded-tag px-1.5', {
  variants: {
    tone: {
      default: 'border-line bg-sunken text-fg',
      success: 'border-line bg-success-soft text-success',
      warn: 'border-line bg-warning-soft text-warning',
      brand: 'border-line bg-selected text-fg',
      danger: 'border-line bg-danger-soft text-danger',
      outline: 'border-line-strong bg-transparent text-muted-foreground',
      mono: 'border-code-line bg-code font-mono text-muted-foreground',
    },
  },
  defaultVariants: {
    tone: 'default',
  },
});

type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>['tone']>;

export function StatusBadge({
  tone = 'default',
  className,
  ...props
}: Omit<ComponentProps<typeof Badge>, 'variant'> & { tone?: StatusTone }) {
  return (
    <Badge variant="outline" className={cn(statusBadgeVariants({ tone }), className)} {...props} />
  );
}

type BuildStatus = 'queued' | 'building' | 'ready' | 'failed';

const buildStatusMeta: Record<
  BuildStatus,
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  queued: { label: '排队中', icon: Clock, className: 'text-muted-foreground' },
  building: { label: '构建中', icon: LoaderCircle, className: 'text-fg' },
  ready: { label: '就绪', icon: CircleCheck, className: 'text-success' },
  failed: { label: '失败', icon: CircleAlert, className: 'text-danger' },
};

export function BuildStatusLabel({ status }: { status: BuildStatus }) {
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
