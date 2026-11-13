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

export function EvalPassRateChart({ runs }: { runs: EvalRun[] }) {
  const points = buildEvalPassRatePoints(runs);
  if (points.length < 2) return null;
  const config = {
    ratePct: { label: '通过率', color: 'var(--color-chart-runs)' },
  } satisfies ChartConfig;
  return (
    // 图表仅视觉展示，读屏改走下方同源运行历史表。
    <div aria-hidden="true" className="mb-3">
      <ChartContainer config={config} className="aspect-auto h-48 w-full">
        <LineChart
          accessibilityLayer={false}
          data={points}
          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis
            domain={[0, 100]}
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tickMargin={8}
            width={36}
            tickFormatter={(value: number) => `${value}%`}
          />
          <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
          <ChartLegend content={<ChartLegendContent />} />
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
