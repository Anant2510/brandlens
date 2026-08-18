'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_PROPS, ChartFrame, ChartTooltipCard, useChartTheme } from './chart-primitives';
import { EmptyState } from '@/components/ui/empty-state';
import { dimensionLabel } from '@/lib/domain';
import { formatPercent } from '@/lib/format';

export interface DimensionPassPoint {
  dimension: string;
  passRate: number;
  evaluations: number;
}

function colorFor(rate: number): string {
  if (rate >= 0.85) return 'var(--ok)';
  if (rate >= 0.7) return 'var(--warn)';
  return 'var(--danger)';
}

export function DimensionPassChart({ data, height = 220 }: { data: DimensionPassPoint[]; height?: number }) {
  const theme = useChartTheme();
  const rows = React.useMemo(
    () => [...data].sort((a, b) => a.passRate - b.passRate).map((d) => ({ ...d, label: dimensionLabel(d.dimension) })),
    [data],
  );

  if (rows.length === 0) {
    return (
      <ChartFrame title="Pass rate by dimension" height={height}>
        <EmptyState compact title="No criteria evaluated yet" description="Publish a ruleset and run a check." />
      </ChartFrame>
    );
  }

  return (
    <ChartFrame
      title="Pass rate by dimension"
      description="Share of evaluated criteria that passed"
      height={height}
      summary={rows.map((r) => `${r.label} ${formatPercent(r.passRate, 0)}`).join('; ')}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid} strokeDasharray="2 4" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 1]}
            {...AXIS_PROPS}
            stroke={theme.axis}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          />
          <YAxis type="category" dataKey="label" {...AXIS_PROPS} stroke={theme.axis} width={84} />
          <Tooltip
            cursor={{ fill: theme.grid, fillOpacity: 0.35 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as DimensionPassPoint & { label: string };
              return (
                <ChartTooltipCard
                  title={point.label}
                  rows={[
                    { label: 'Pass rate', value: formatPercent(point.passRate), color: colorFor(point.passRate) },
                    { label: 'Evaluations', value: point.evaluations },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="passRate" radius={[0, 3, 3, 0]} barSize={12} isAnimationActive={false}>
            {rows.map((row) => (
              <Cell key={row.dimension} fill={colorFor(row.passRate)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
