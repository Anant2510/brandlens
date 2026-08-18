'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AXIS_PROPS, ChartFrame, ChartTooltipCard, useChartTheme } from './chart-primitives';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/format';

export interface ScoreTrendPoint {
  date: string;
  avgScore: number;
  checks: number;
}

export function ScoreTrendChart({
  data,
  height = 220,
  passThreshold = 85,
}: {
  data: ScoreTrendPoint[];
  height?: number;
  passThreshold?: number;
}) {
  const theme = useChartTheme();

  if (data.length === 0) {
    return (
      <ChartFrame title="Score trend" description="Average compliance score per day" height={height}>
        <EmptyState compact title="No checks in this window" description="Run a check to start the trend." />
      </ChartFrame>
    );
  }

  const summary = `Average score from ${formatDate(data[0]?.date)} to ${formatDate(data[data.length - 1]?.date)}, ranging ${Math.min(
    ...data.map((d) => d.avgScore),
  ).toFixed(0)} to ${Math.max(...data.map((d) => d.avgScore)).toFixed(0)}.`;

  return (
    <ChartFrame
      title="Score trend"
      description="Deterministic aggregate score, averaged per day"
      height={height}
      summary={summary}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            {...AXIS_PROPS}
            stroke={theme.axis}
            tickFormatter={(value: string) => formatDate(value).slice(0, 6)}
            minTickGap={24}
          />
          <YAxis domain={[0, 100]} {...AXIS_PROPS} stroke={theme.axis} width={42} />
          <ReferenceLine
            y={passThreshold}
            stroke="var(--ok)"
            strokeDasharray="4 4"
            label={{ value: 'pass', position: 'right', fontSize: 10, fill: 'var(--ok)' }}
          />
          <Tooltip
            cursor={{ stroke: theme.grid }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as ScoreTrendPoint;
              return (
                <ChartTooltipCard
                  title={formatDate(String(label))}
                  rows={[
                    { label: 'Avg score', value: point.avgScore.toFixed(1), color: 'var(--chart-1)' },
                    { label: 'Checks', value: point.checks },
                  ]}
                />
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="avgScore"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
