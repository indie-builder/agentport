import type { OverviewTimeseriesPoint } from '@agentport/shared';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../components/ui/chart.js';

const trendConfig = {
  runs: { label: '运行', color: 'var(--color-chart-runs)' },
  failed: { label: '失败', color: 'var(--color-chart-failed)' },
} satisfies ChartConfig;

export function RunTrendChart({ points }: { points: OverviewTimeseriesPoint[] }) {
  return (
    <ChartContainer config={trendConfig} className="aspect-auto h-56 w-full">
      <AreaChart
        accessibilityLayer={false}
        data={points}
        margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: string) => value.slice(5)}
        />
        <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickMargin={8} width={48} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Area
          dataKey="runs"
          type="monotone"
          fill="var(--color-runs)"
          fillOpacity={0.08}
          stroke="var(--color-runs)"
          strokeWidth={1.5}
          isAnimationActive={false}
        />
        <Area
          dataKey="failed"
          type="monotone"
          fill="var(--color-failed)"
          fillOpacity={0.16}
          stroke="var(--color-failed)"
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
