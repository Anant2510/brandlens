'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { RuleHealthRow } from '@brandlens/contracts';
import { AXIS_PROPS, ChartFrame, ChartTooltipCard, useChartTheme } from './chart-primitives';
import { EmptyState } from '@/components/ui/empty-state';
import { formatPercent, formatUsd } from '@/lib/format';
import { dimensionLabel } from '@/lib/domain';

/**
 * Override rate against evaluation volume.
 *
 * The 20% reference line is the product-health boundary: above it the rule is
 * broken, not the customer. High-volume rules to the right of that line are
 * the ones costing the most trust.
 */
export function RuleHealthScatter({
  rows,
  height = 280,
  onSelect,
}: {
  rows: RuleHealthRow[];
  height?: number;
  onSelect?: (row: RuleHealthRow) => void;
}) {
  const theme = useChartTheme();

  const data = React.useMemo(
    () =>
      rows
        .filter((r) => r.evaluations > 0)
        .map((r) => ({
          ...r,
          x: r.evaluations,
          y: r.overrideRate,
          z: Math.max(1, r.costUsd * 1000),
        })),
    [rows],
  );

  if (data.length === 0) {
    return (
      <ChartFrame title="Rule health" description="Override rate vs evaluations" height={height}>
        <EmptyState
          compact
          title="No rule evaluations yet"
          description="Rule health appears once checks have run against an active ruleset."
        />
      </ChartFrame>
    );
  }

  const unhealthy = data.filter((d) => d.overrideRate > 0.2).length;

  return (
    <ChartFrame
      title="Rule health"
      description="Override rate against evaluation volume. Above 20% the rule is broken, not the customer."
      height={height}
      summary={`${data.length} rules plotted, ${unhealthy} above the 20% override line.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 12, left: -16, bottom: 4 }}>
          <CartesianGrid stroke={theme.grid} strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey="x"
            name="Evaluations"
            {...AXIS_PROPS}
            stroke={theme.axis}
            label={{ value: 'evaluations', position: 'insideBottomRight', offset: -2, fontSize: 10, fill: theme.axis }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Override rate"
            domain={[0, 'dataMax']}
            {...AXIS_PROPS}
            stroke={theme.axis}
            width={46}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          />
          <ZAxis type="number" dataKey="z" range={[24, 220]} name="Cost" />
          <ReferenceLine
            y={0.2}
            stroke="var(--danger)"
            strokeDasharray="4 4"
            label={{ value: '20% — rule is broken', position: 'insideTopRight', fontSize: 10, fill: 'var(--danger)' }}
          />
          <Tooltip
            cursor={{ strokeDasharray: '3 3', stroke: theme.grid }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as RuleHealthRow;
              return (
                <ChartTooltipCard
                  title={point.ruleKey}
                  rows={[
                    { label: 'Override rate', value: formatPercent(point.overrideRate) },
                    { label: 'Fail rate', value: formatPercent(point.failRate) },
                    { label: 'Evaluations', value: point.evaluations },
                    { label: 'Dimension', value: dimensionLabel(point.dimension) },
                    { label: 'Cost', value: formatUsd(point.costUsd) },
                  ]}
                />
              );
            }}
          />
          <Scatter
            data={data}
            fillOpacity={0.75}
            isAnimationActive={false}
            onClick={onSelect ? (point) => onSelect(point as unknown as RuleHealthRow) : undefined}
            cursor={onSelect ? 'pointer' : undefined}
          >
            {data.map((point) => (
              <Cell
                key={point.ruleKey}
                fill={point.overrideRate > 0.2 ? 'var(--danger)' : point.overrideRate > 0.1 ? 'var(--warn)' : 'var(--chart-1)'}
              />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
