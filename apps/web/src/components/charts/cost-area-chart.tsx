'use client';

import * as React from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_PROPS, ChartFrame, ChartTooltipCard, useChartTheme } from './chart-primitives';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, formatUsd } from '@/lib/format';

export interface CostPoint {
  date: string;
  costUsd: number;
  checks: number;
}

export function CostAreaChart({ data, height = 220 }: { data: CostPoint[]; height?: number }) {
  const theme = useChartTheme();
  const rows = React.useMemo(
    () => data.map((d) => ({ ...d, costPerAsset: d.checks > 0 ? d.costUsd / d.checks : 0 })),
    [data],
  );

  if (rows.length === 0) {
    return (
      <ChartFrame title="Cost per asset" height={height}>
        <EmptyState compact title="No spend recorded" description="Costs appear once a check consumes model calls." />
      </ChartFrame>
    );
  }

  const total = rows.reduce((sum, r) => sum + r.costUsd, 0);

  return (
    <ChartFrame
      title="Cost per asset"
      description={`Daily model spend divided by assets analyzed. ${formatUsd(total)} total in window.`}
      height={height}
      summary={`Daily cost per asset over ${rows.length} days, ${formatUsd(total)} total.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id="bl-cost-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={theme.grid} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            {...AXIS_PROPS}
            stroke={theme.axis}
            tickFormatter={(v: string) => formatDate(v).slice(0, 6)}
            minTickGap={24}
          />
          <YAxis
            {...AXIS_PROPS}
            stroke={theme.axis}
            width={54}
            tickFormatter={(v: number) => (v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`)}
          />
          <Tooltip
            cursor={{ stroke: theme.grid }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as CostPoint & { costPerAsset: number };
              return (
                <ChartTooltipCard
                  title={formatDate(String(label))}
                  rows={[
                    { label: 'Cost / asset', value: formatUsd(point.costPerAsset), color: 'var(--chart-2)' },
                    { label: 'Total spend', value: formatUsd(point.costUsd) },
                    { label: 'Checks', value: point.checks },
                  ]}
                />
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="costPerAsset"
            stroke="var(--chart-2)"
            strokeWidth={2}
            fill="url(#bl-cost-gradient)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
