import { cn } from '../lib/cn.js';

/**
 * 遥测头：页面标题右侧的读数 + 刻度带。
 *
 * 它替代「四张同款统计卡」——卡片把注意力平均分配，而读数回答的是
 * 「现在值多少、和上一条比是变好还是变坏」。
 *
 * 刻度带：每个刻度是一次运行，按时间从左到右。颜色只有三种：
 * 灰（完成）、橙（进行中）、红（失败）。它让「最近是否稳定」一眼可见，
 * 而不需要读一行行表格。
 */
export interface TelemetryTick {
  id: string;
  state: 'ok' | 'error' | 'live' | 'idle';
  label: string;
}

export function TelemetryReadout({
  label,
  value,
  unit,
  hint,
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-2xs font-medium uppercase tracking-[0.08em] text-subtle">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="font-mono text-lg font-medium leading-none tabular-nums text-fg">
          {value}
        </span>
        {unit ? <span className="font-mono text-2xs text-subtle">{unit}</span> : null}
      </div>
      {hint ? <div className="mt-1 truncate text-2xs text-subtle">{hint}</div> : null}
    </div>
  );
}

export function TelemetryStrip({ ticks, label }: { ticks: TelemetryTick[]; label: string }) {
  if (ticks.length === 0) {
    return (
      <div className="text-2xs text-subtle" role="img" aria-label={`${label}：暂无数据`}>
        暂无运行
      </div>
    );
  }
  return (
    <div
      className="flex items-end gap-[3px]"
      role="img"
      aria-label={`${label}：${ticks.length} 次运行，${ticks.filter((t) => t.state === 'error').length} 次失败`}
    >
      {ticks.map((tick) => (
        <span
          key={tick.id}
          title={tick.label}
          className={cn(
            'h-4 w-[3px] rounded-[1px]',
            tick.state === 'ok' && 'bg-line-strong',
            tick.state === 'error' && 'bg-danger',
            tick.state === 'live' && 'live-dot bg-ink',
            tick.state === 'idle' && 'bg-line',
          )}
        />
      ))}
    </div>
  );
}
