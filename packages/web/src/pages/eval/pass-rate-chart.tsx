import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../../components/ui/chart.js';
import type { EvalRun } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';

export function buildEvalPassRatePoints(runs: EvalRun[]): { label: string; ratePct: number }[] {
  return [...runs]
    .filter((run) => run.status !== 'running' && run.total > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((run) => ({
      label: formatDateTime(run.createdAt),
      ratePct: Math.round((run.passed / run.total) * 100),
    }));
}

export function EvalPassRateChart({
  runs,
  compact = false,
}: {
  runs: EvalRun[];
  compact?: boolean;
}) {
  const points = buildEvalPassRatePoints(runs);
  if (points.length < 2) return null;
  const config = {
    ratePct: { label: '通过率', color: 'var(--color-chart-runs)' },
  } satisfies ChartConfig;
  return (
    <div aria-hidden="true" className={compact ? undefined : 'mb-3'}>
      <ChartContainer
        config={config}
        className={compact ? 'aspect-auto h-24 w-full' : 'aspect-auto h-48 w-full'}
      >
        <LineChart
          accessibilityLayer={false}
          data={points}
          margin={
            compact
              ? { top: 4, right: 6, bottom: 0, left: 0 }
              : { top: 8, right: 8, bottom: 0, left: 8 }
          }
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="label"
            hide={compact}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            domain={[0, 100]}
            {...(compact ? { ticks: [0, 50, 100] } : {})}
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tickMargin={compact ? 4 : 8}
            width={compact ? 32 : 36}
            tickFormatter={(value: number) => `${value}%`}
          />
          <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
          {compact ? null : <ChartLegend content={<ChartLegendContent />} />}
          <Line
            dataKey="ratePct"
            type="monotone"
            stroke="var(--color-ratePct)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
}
