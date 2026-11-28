import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  CalendarClock,
  Check,
  Container,
  Cpu,
  Database,
  FileOutput,
  FileText,
  FlaskConical,
  Hash,
  KeyRound,
  Lock,
  type LucideIcon,
  Plug,
  Puzzle,
  Scale,
  SearchX,
  Share2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export type EmptyStateVariant = 'stage' | 'filter' | 'clear' | 'permission' | 'idle';

export type EmptyStateScale = 'page' | 'section' | 'panel' | 'inline';

export type EmptySpecimenName =
  | 'agents'
  | 'channels'
  | 'schedules'
  | 'skills'
  | 'connectors'
  | 'plugins'
  | 'knowledge'
  | 'documents'
  | 'data-domains'
  | 'runs'
  | 'models'
  | 'eval'
  | 'memory'
  | 'outputs'
  | 'shares'
  | 'security'
  | 'governance'
  | 'accounts'
  | 'integrations'
  | 'environments'
  | 'trend';

export interface EmptyFilterChip {
  key: string;
  label: string;
  value: string;
  onRemove?: (() => void) | undefined;
}

export interface EmptyStateProps {
  variant?: EmptyStateVariant | undefined;
  scale?: EmptyStateScale | undefined;
  specimen?: EmptySpecimenName | undefined;
  icon?: ReactNode;
  illustration?: ReactNode;
  title: string;
  description?: ReactNode;
  activeFilters?: readonly EmptyFilterChip[] | undefined;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  footer?: ReactNode;
  className?: string | undefined;
}

const SPECIMEN_ICON: Record<EmptySpecimenName, LucideIcon> = {
  agents: Bot,
  channels: Hash,
  schedules: CalendarClock,
  skills: Sparkles,
  connectors: Plug,
  plugins: Puzzle,
  knowledge: BookOpen,
  documents: FileText,
  'data-domains': Database,
  runs: Activity,
  models: Cpu,
  eval: FlaskConical,
  memory: Brain,
  outputs: FileOutput,
  shares: Share2,
  security: ShieldCheck,
  governance: Scale,
  accounts: Users,
  integrations: KeyRound,
  environments: Container,
  trend: TrendingUp,
};

function defaultScaleFor(variant: EmptyStateVariant): EmptyStateScale {
  if (variant === 'stage' || variant === 'permission') return 'page';
  if (variant === 'filter' || variant === 'clear') return 'section';
  return 'panel';
}

function defaultVariantIcon(variant: EmptyStateVariant): ReactNode {
  if (variant === 'filter') return <SearchX aria-hidden="true" />;
  if (variant === 'clear') return <Check aria-hidden="true" />;
  if (variant === 'permission') return <Lock aria-hidden="true" />;
  return null;
}

function FilterChipList({ filters }: { filters: readonly EmptyFilterChip[] }) {
  if (filters.length === 0) return null;
  return (
    <div className="mt-3 flex max-w-[440px] flex-wrap items-center justify-center gap-1.5">
      {filters.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 items-center gap-1.5 rounded-tag bg-chip px-2 text-xs text-fg"
        >
          <span className="text-muted-foreground">{chip.label}:</span>
          <span className="max-w-[180px] truncate">{chip.value}</span>
          {chip.onRemove ? (
            <ButtonPrimitive
              onClick={chip.onRemove}
              aria-label={`移除筛选：${chip.label} ${chip.value}`}
              className="grid size-3.5 place-items-center rounded text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-selected hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden="true" />
            </ButtonPrimitive>
          ) : null}
        </span>
      ))}
    </div>
  );
}

export function EmptyState({
  variant = 'idle',
  scale,
  specimen,
  icon,
  illustration,
  title,
  description,
  activeFilters,
  action,
  secondaryAction,
  footer,
  className,
}: EmptyStateProps) {
  const resolvedScale = scale ?? defaultScaleFor(variant);
  const hasActions = Boolean(action || secondaryAction);
  const SpecimenIcon = specimen ? SPECIMEN_ICON[specimen] : null;
  const resolvedIcon =
    icon ?? (SpecimenIcon ? <SpecimenIcon aria-hidden="true" /> : defaultVariantIcon(variant));

  if (resolvedScale === 'inline') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-1.5 px-4 py-6 text-center',
          className,
        )}
      >
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-fg">
          {resolvedIcon ? (
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex shrink-0 items-center justify-center [&_svg]:size-4',
                variant === 'clear' ? 'text-success' : 'text-muted-foreground',
              )}
            >
              {resolvedIcon}
            </span>
          ) : null}
          <span>{title}</span>
        </div>
        {description ? (
          <div className="max-w-[360px] text-xs text-muted-foreground">{description}</div>
        ) : null}
        {activeFilters ? <FilterChipList filters={activeFilters} /> : null}
        {hasActions ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            {action}
            {secondaryAction}
          </div>
        ) : null}
        {footer ? <div className="mt-2 text-xs text-muted-foreground">{footer}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        resolvedScale === 'page'
          ? 'min-h-[360px] flex-1 px-6 py-12'
          : resolvedScale === 'section'
            ? 'min-h-[220px] px-6 py-12'
            : 'px-5 py-10',
        className,
      )}
    >
      {illustration ? (
        <div className="mb-4">{illustration}</div>
      ) : resolvedIcon ? (
        <div
          aria-hidden="true"
          className={cn(
            'mb-3 flex size-9 items-center justify-center rounded-[10px] [&_svg]:size-4',
            variant === 'clear'
              ? 'bg-success-soft text-success'
              : 'border border-line bg-surface text-muted-foreground shadow-xs',
          )}
        >
          {resolvedIcon}
        </div>
      ) : null}
      <div className="text-base font-medium text-fg">{title}</div>
      {description ? (
        <div className="mt-1 max-w-[360px] text-sm text-muted-foreground">{description}</div>
      ) : null}
      {activeFilters ? <FilterChipList filters={activeFilters} /> : null}
      {hasActions ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
      {footer ? <div className="mt-3 text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  );
}
