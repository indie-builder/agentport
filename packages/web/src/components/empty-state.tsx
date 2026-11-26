import { Link, type LinkProps } from '@tanstack/react-router';
import {
  Activity,
  ArrowRight,
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

export type EmptyStateVariant = 'stage' | 'filter' | 'clear' | 'permission' | 'idle' | 'checklist';

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

export interface EmptyChecklistStep {
  id: string;
  title: string;
  description?: string | undefined;
  status: 'done' | 'current' | 'upcoming';
  action?: ReactNode;
}

export type EmptyStarter = {
  id: string;
  icon?: ReactNode;
  title: string;
  description: string;
} & ({ to: string; onClick?: never } | { onClick: () => void; to?: never });

export interface EmptyStateProps {
  variant?: EmptyStateVariant | undefined;
  scale?: EmptyStateScale | undefined;
  specimen?: EmptySpecimenName | undefined;
  icon?: ReactNode;
  illustration?: ReactNode;
  title: string;
  description?: ReactNode;
  activeFilters?: readonly EmptyFilterChip[] | undefined;
  steps?: readonly EmptyChecklistStep[] | undefined;
  starters?: readonly EmptyStarter[] | undefined;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  footer?: ReactNode;
  className?: string | undefined;
}

interface SpecimenMeta {
  layout: 'card' | 'timeline' | 'table' | 'trend';
  icon: LucideIcon;
  tags: readonly [string, string];
  accentDot?: boolean;
}

const SPECIMEN_META: Record<EmptySpecimenName, SpecimenMeta> = {
  agents: { layout: 'card', icon: Bot, tags: ['CLAUDE.md', 'skills'], accentDot: true },
  channels: { layout: 'card', icon: Hash, tags: ['@mention', 'thread'], accentDot: true },
  schedules: {
    layout: 'timeline',
    icon: CalendarClock,
    tags: ['0 9 * * *', 'UTC'],
    accentDot: true,
  },
  skills: { layout: 'card', icon: Sparkles, tags: ['SKILL.md', 'scripts'] },
  connectors: { layout: 'card', icon: Plug, tags: ['MCP', 'HTTP API'], accentDot: true },
  plugins: { layout: 'card', icon: Puzzle, tags: ['plugin.json', 'hooks'] },
  knowledge: { layout: 'card', icon: BookOpen, tags: ['chunks', 'vector'], accentDot: true },
  documents: { layout: 'table', icon: FileText, tags: ['PDF', 'Markdown'] },
  'data-domains': { layout: 'table', icon: Database, tags: ['schema', 'RLS'] },
  runs: { layout: 'timeline', icon: Activity, tags: ['trace', 'tokens'], accentDot: true },
  models: { layout: 'card', icon: Cpu, tags: ['LLM', 'Embedding'], accentDot: true },
  eval: { layout: 'table', icon: FlaskConical, tags: ['pass@1', 'baseline'] },
  memory: { layout: 'card', icon: Brain, tags: ['MEMORY.md', 'scoped'] },
  outputs: { layout: 'card', icon: FileOutput, tags: ['v1', 'artifact'] },
  shares: { layout: 'card', icon: Share2, tags: ['/s/link', 'read-only'] },
  security: { layout: 'card', icon: ShieldCheck, tags: ['policy', 'guard'], accentDot: true },
  governance: { layout: 'card', icon: Scale, tags: ['budget', 'quota'] },
  accounts: { layout: 'card', icon: Users, tags: ['member', 'role'] },
  integrations: { layout: 'card', icon: KeyRound, tags: ['Bearer', 'Webhook'] },
  environments: { layout: 'card', icon: Container, tags: ['sandbox', 'image'], accentDot: true },
  trend: { layout: 'trend', icon: TrendingUp, tags: ['7d', 'runs'] },
};

function defaultScaleFor(variant: EmptyStateVariant): EmptyStateScale {
  if (variant === 'stage' || variant === 'checklist' || variant === 'permission') return 'page';
  if (variant === 'filter' || variant === 'clear') return 'section';
  return 'panel';
}

function EmptySpecimen({ name, compact = false }: { name: EmptySpecimenName; compact?: boolean }) {
  const meta = SPECIMEN_META[name];
  const Icon = meta.icon;

  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative flex items-center justify-center',
        compact ? 'mb-4 h-24 w-52' : 'mb-5 h-28 w-62',
      )}
    >
      <div
        className={cn(
          'absolute top-1 rounded-card border border-line bg-sunken opacity-75 -rotate-2 -translate-y-1',
          compact ? 'h-16 w-44' : 'h-19 w-52',
        )}
      />
      <div
        className={cn(
          'relative flex flex-col gap-2.5 rounded-card bg-surface px-3.5 py-3 cds-card-surface',
          compact ? 'w-48' : 'w-57',
        )}
      >
        {meta.layout === 'timeline' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <div className="grid size-6 shrink-0 place-items-center rounded-icon border border-line bg-sunken text-fg">
                <Icon className="size-3.5" aria-hidden="true" />
              </div>
              <div className="h-1.5 w-24 rounded-pill bg-selected" />
              <div className="ml-auto size-1.5 rounded-pill bg-success ring-4 ring-success-soft" />
            </div>
            <div className="flex items-center gap-2.5 pl-1">
              <div className="size-1.5 shrink-0 rounded-pill bg-line-strong" />
              <div className="h-1.5 w-28 rounded-pill bg-sunken" />
              <div className="ml-auto h-1.5 w-8 rounded-pill bg-sunken" />
            </div>
          </div>
        ) : meta.layout === 'table' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="grid size-6 shrink-0 place-items-center rounded-icon border border-line bg-sunken text-fg">
                <Icon className="size-3.5" aria-hidden="true" />
              </div>
              <div className="grid flex-1 grid-cols-3 gap-1.5">
                <div className="h-1.5 rounded-pill bg-selected" />
                <div className="h-1.5 rounded-pill bg-sunken" />
                <div className="h-1.5 rounded-pill bg-sunken" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5 pt-0.5">
              <div className="h-1.5 rounded-pill bg-sunken" />
              <div className="h-1.5 rounded-pill bg-selected" />
              <div className="h-1.5 rounded-pill bg-sunken" />
            </div>
          </div>
        ) : meta.layout === 'trend' ? (
          <div className="flex items-center gap-2.5">
            <div className="grid size-7 shrink-0 place-items-center rounded-icon border border-line bg-sunken text-fg">
              <Icon className="size-4" aria-hidden="true" />
            </div>
            <svg
              viewBox="0 0 120 32"
              className="h-8 flex-1 text-subtle"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2 26 L26 22 L48 24 L74 13 L96 16 L118 6"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <div className="grid size-7 shrink-0 place-items-center rounded-icon border border-line bg-sunken text-fg">
              <Icon className="size-4" aria-hidden="true" />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="h-1.5 w-3/4 rounded-pill bg-selected" />
              <div className="h-1.5 w-1/2 rounded-pill bg-sunken" />
            </div>
            {meta.accentDot ? (
              <div className="size-1.5 shrink-0 rounded-pill bg-success ring-4 ring-success-soft" />
            ) : null}
          </div>
        )}
        <div className="flex items-center gap-1.5 border-t border-line pt-2">
          {meta.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex h-4.5 items-center rounded-tag bg-sunken px-2 font-mono text-2xs text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function FilterChipList({ filters }: { filters: readonly EmptyFilterChip[] }) {
  if (filters.length === 0) return null;
  return (
    <div className="mt-3.5 flex max-w-[440px] flex-wrap items-center justify-center gap-1.5">
      {filters.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 items-center gap-1.5 rounded-tag bg-chip px-2 text-xs text-fg"
        >
          <span className="text-muted-foreground">{chip.label}:</span>
          <span className="max-w-[180px] truncate">{chip.value}</span>
          {chip.onRemove ? (
            <button
              type="button"
              onClick={chip.onRemove}
              aria-label={`移除筛选：${chip.label} ${chip.value}`}
              className="grid size-3.5 place-items-center rounded text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-selected hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function StarterGrid({ starters }: { starters: readonly EmptyStarter[] }) {
  if (starters.length === 0) return null;
  const cardClassName =
    'group flex flex-col gap-1.5 rounded-card bg-surface p-3.5 text-left cds-card-surface cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="mt-8 grid w-full max-w-[660px] grid-cols-[repeat(auto-fit,minmax(min(100%,190px),1fr))] gap-3">
      {starters.map((starter) => {
        const body = (
          <>
            <div className="flex items-center justify-between gap-2 text-sm font-medium text-fg">
              <span className="flex min-w-0 items-center gap-2">
                {starter.icon ? (
                  <span className="grid size-6 shrink-0 place-items-center rounded-tag bg-sunken text-muted-foreground [&_svg]:size-3.5">
                    {starter.icon}
                  </span>
                ) : null}
                <span className="truncate">{starter.title}</span>
              </span>
              <ArrowRight
                className="size-3.5 shrink-0 text-subtle transition-transform duration-150 ease-out-soft group-hover:translate-x-0.5 group-hover:text-fg"
                aria-hidden="true"
              />
            </div>
            <p className="text-xs leading-4 text-muted-foreground">{starter.description}</p>
          </>
        );

        if (starter.to !== undefined) {
          return (
            <Link
              key={starter.id}
              to={starter.to as NonNullable<LinkProps['to']>}
              data-hover="lift"
              className={cardClassName}
            >
              {body}
            </Link>
          );
        }

        return (
          <button
            key={starter.id}
            type="button"
            onClick={starter.onClick}
            data-hover="lift"
            className={cardClassName}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

function defaultVariantIcon(variant: EmptyStateVariant, compact: boolean): ReactNode {
  const iconClass = compact ? 'size-4' : 'size-5';
  if (variant === 'filter') return <SearchX className={iconClass} aria-hidden="true" />;
  if (variant === 'clear') return <Check className={iconClass} aria-hidden="true" />;
  if (variant === 'permission') return <Lock className={iconClass} aria-hidden="true" />;
  return null;
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
  steps,
  starters,
  action,
  secondaryAction,
  footer,
  className,
}: EmptyStateProps) {
  const resolvedScale = scale ?? defaultScaleFor(variant);
  const hasActions = Boolean(action || secondaryAction);

  if (resolvedScale === 'inline') {
    const inlineIcon = icon ?? defaultVariantIcon(variant, true);
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-1.5 px-4 py-8 text-center',
          className,
        )}
      >
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-fg">
          {inlineIcon ? (
            <span
              className={cn(
                'inline-flex shrink-0 items-center justify-center',
                variant === 'clear' ? 'text-success' : 'text-muted-foreground',
              )}
            >
              {inlineIcon}
            </span>
          ) : null}
          <span>{title}</span>
        </div>
        {description ? (
          <div className="max-w-[400px] text-xs text-muted-foreground">{description}</div>
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

  if (variant === 'checklist') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center px-6',
          resolvedScale === 'page'
            ? 'empty-stage-dots min-h-[420px] flex-1 overflow-hidden rounded-dialog py-12'
            : resolvedScale === 'section'
              ? 'min-h-[260px] py-10'
              : 'px-5 py-10',
          className,
        )}
      >
        <div className="w-full max-w-[520px] rounded-composer bg-surface p-6 text-left cds-card-surface">
          <div>
            <div className="text-base font-medium text-fg">{title}</div>
            {description ? (
              <div className="mt-1 text-sm text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {steps && steps.length > 0 ? (
            <ol className="mt-4 divide-y divide-line border-t border-line">
              {steps.map((step, index) => (
                <li key={step.id} className="flex items-center gap-3 py-3.5 last:pb-0.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium',
                      step.status === 'done'
                        ? 'bg-success-soft text-success'
                        : step.status === 'current'
                          ? 'bg-fg text-surface'
                          : 'border border-line bg-sunken text-muted-foreground',
                    )}
                  >
                    {step.status === 'done' ? <Check className="size-3.5" /> : index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'text-sm font-medium',
                        step.status === 'done' ? 'text-muted-foreground line-through' : 'text-fg',
                      )}
                    >
                      {step.title}
                    </div>
                    {step.description ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">{step.description}</div>
                    ) : null}
                  </div>
                  {step.action ? <div className="shrink-0">{step.action}</div> : null}
                </li>
              ))}
            </ol>
          ) : null}
          {hasActions ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {action}
              {secondaryAction}
            </div>
          ) : null}
          {footer ? <div className="mt-4 text-xs text-muted-foreground">{footer}</div> : null}
        </div>
      </div>
    );
  }

  if (variant === 'permission') {
    const gateIcon = icon ?? defaultVariantIcon('permission', false);
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center px-6',
          resolvedScale === 'page'
            ? 'min-h-[420px] flex-1 py-12'
            : resolvedScale === 'section'
              ? 'min-h-[260px] py-10'
              : 'px-5 py-10',
          className,
        )}
      >
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-composer bg-surface px-6 py-7 text-center cds-card-surface">
          {illustration ? (
            <div className="mb-4">{illustration}</div>
          ) : gateIcon ? (
            <div className="mb-3.5 grid size-10 place-items-center rounded-full bg-sunken text-muted-foreground">
              {gateIcon}
            </div>
          ) : null}
          <div
            className={cn(
              'font-medium text-fg',
              resolvedScale === 'page' ? 'text-lg' : 'text-base',
            )}
          >
            {title}
          </div>
          {description ? (
            <div className="mt-1.5 max-w-[360px] text-sm text-muted-foreground">{description}</div>
          ) : null}
          {hasActions ? (
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {action}
              {secondaryAction}
            </div>
          ) : null}
          {footer ? <div className="mt-4 text-xs text-muted-foreground">{footer}</div> : null}
        </div>
      </div>
    );
  }

  const badgeIcon = icon ?? defaultVariantIcon(variant, false);
  const useDots = resolvedScale === 'page' && (variant === 'stage' || variant === 'idle');

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        resolvedScale === 'page'
          ? 'min-h-[420px] flex-1 overflow-hidden rounded-dialog px-6 py-12'
          : resolvedScale === 'section'
            ? 'min-h-[260px] rounded-card px-6 py-12'
            : 'px-5 py-12',
        useDots && 'empty-stage-dots',
        className,
      )}
    >
      {illustration ? (
        <div className="mb-4">{illustration}</div>
      ) : specimen ? (
        <EmptySpecimen name={specimen} compact={resolvedScale === 'panel'} />
      ) : badgeIcon ? (
        <div
          className={cn(
            'mb-3.5 grid size-10 place-items-center rounded-full',
            variant === 'clear'
              ? 'bg-success-soft text-success'
              : 'bg-sunken text-muted-foreground',
          )}
        >
          {badgeIcon}
        </div>
      ) : null}
      <div
        className={cn(
          'font-medium text-fg',
          resolvedScale === 'page'
            ? 'text-lg'
            : resolvedScale === 'section'
              ? 'text-base'
              : 'text-sm',
        )}
      >
        {title}
      </div>
      {description ? (
        <div
          className={cn(
            'mt-1.5 max-w-[440px] text-muted-foreground',
            resolvedScale === 'panel' ? 'text-xs' : 'text-sm',
          )}
        >
          {description}
        </div>
      ) : null}
      {activeFilters ? <FilterChipList filters={activeFilters} /> : null}
      {hasActions ? (
        <div className="mt-4.5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
      {variant === 'stage' && starters ? <StarterGrid starters={starters} /> : null}
      {footer ? <div className="mt-5 text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  );
}
