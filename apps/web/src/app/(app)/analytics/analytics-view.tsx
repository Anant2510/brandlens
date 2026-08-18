'use client';

import * as React from 'react';
import { AlertTriangle, DollarSign, Percent, Zap } from 'lucide-react';
import type { RuleHealthRow } from '@brandlens/contracts';
import { PageBody, PageHeader } from '@/components/app-shell';
import { StatTile } from '@/components/stat-tile';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/data-table';
import { ScoreTrendChart } from '@/components/charts/score-trend-chart';
import { DimensionPassChart } from '@/components/charts/dimension-pass-chart';
import { RuleHealthScatter } from '@/components/charts/rule-health-scatter';
import { CostAreaChart } from '@/components/charts/cost-area-chart';
import { CoverageGauge } from '@/components/charts/coverage-gauge';
import { SeverityBadge } from '@/components/severity-badge';
import {
  useCostReportQuery,
  useCoverageReportQuery,
  useDashboardSummaryQuery,
  useRuleHealthQuery,
} from '@/hooks/use-analytics';
import { useBrandsQuery } from '@/hooks/use-brands';
import { errorMessage } from '@/lib/api-client';
import { dimensionLabel } from '@/lib/domain';
import { formatPercent, formatUsd } from '@/lib/format';

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export function AnalyticsView() {
  const [days, setDays] = React.useState('30');
  const [brandId, setBrandId] = React.useState('');

  const filters = React.useMemo(
    () => ({ from: new Date(Date.now() - Number(days) * 86_400_000).toISOString(), brandId: brandId || undefined }),
    [days, brandId],
  );

  const { data: brands } = useBrandsQuery();
  const summary = useDashboardSummaryQuery(filters);
  const ruleHealth = useRuleHealthQuery(filters);
  const cost = useCostReportQuery(filters);
  const coverage = useCoverageReportQuery(filters);

  const unhealthy = React.useMemo(
    () => (ruleHealth.data ?? []).filter((r) => r.overrideRate > 0.2).length,
    [ruleHealth.data],
  );

  const ruleColumns: Array<Column<RuleHealthRow>> = [
    {
      id: 'rule',
      header: 'Rule',
      sortValue: (r) => r.ruleKey,
      cell: (r) => (
        <div className="min-w-0 max-w-lg">
          <p className="truncate text-fg">{r.statement}</p>
          <p className="num text-fg-subtle">{r.ruleKey}</p>
        </div>
      ),
    },
    {
      id: 'dimension',
      header: 'Dimension',
      sortValue: (r) => r.dimension,
      cell: (r) => <span className="text-fg-muted">{dimensionLabel(r.dimension)}</span>,
    },
    { id: 'severity', header: 'Severity', sortValue: (r) => r.severity, cell: (r) => <SeverityBadge severity={r.severity} /> },
    { id: 'tier', header: 'Tier', sortValue: (r) => r.tier, cell: (r) => <span className="num text-fg-muted">{r.tier}</span> },
    {
      id: 'evaluations',
      header: 'Evaluations',
      align: 'right',
      sortValue: (r) => r.evaluations,
      cell: (r) => <span className="num text-fg-muted">{r.evaluations}</span>,
    },
    {
      id: 'failRate',
      header: 'Fail rate',
      align: 'right',
      sortValue: (r) => r.failRate,
      cell: (r) => <span className="num text-fg-muted">{formatPercent(r.failRate, 0)}</span>,
    },
    {
      id: 'overrideRate',
      header: 'Override rate',
      align: 'right',
      sortValue: (r) => r.overrideRate,
      cell: (r) => (
        <span className={r.overrideRate > 0.2 ? 'num font-semibold text-blocker-fg' : 'num text-fg'}>
          {formatPercent(r.overrideRate, 0)}
        </span>
      ),
    },
    {
      id: 'agreement',
      header: 'Agreement',
      align: 'right',
      sortValue: (r) => r.agreementRate ?? -1,
      cell: (r) => <span className="num text-fg-muted">{r.agreementRate === null ? '—' : formatPercent(r.agreementRate, 0)}</span>,
    },
    {
      id: 'beta',
      header: 'Beta',
      align: 'right',
      sortValue: (r) => r.beta ?? -1,
      cell: (r) => (
        <span className={r.beta !== null && r.beta < 0.3 ? 'num text-[var(--sev-major-fg)]' : 'num text-fg-muted'}>
          {r.beta === null ? '—' : r.beta.toFixed(2)}
        </span>
      ),
    },
    {
      id: 'routing',
      header: 'Routing',
      cell: (r) =>
        r.autoRouteToHuman ? (
          <Badge tone="major">Human</Badge>
        ) : (
          <Badge tone="ok">Auto</Badge>
        ),
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortValue: (r) => r.costUsd,
      cell: (r) => <span className="num text-fg-muted">{formatUsd(r.costUsd)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Score trend, dimension pass rates, rule health, spend and coverage. Override rate is the metric that matters."
        actions={
          <>
            <Select
              className="w-44"
              value={brandId}
              placeholder="All brands"
              onChange={(event) => setBrandId(event.target.value)}
              aria-label="Filter by brand"
              options={(brands ?? []).map((b) => ({ value: b.id, label: b.name }))}
            />
            <Select
              className="w-36"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              aria-label="Time window"
              options={WINDOWS}
            />
          </>
        }
      />

      <PageBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Auto-cleared"
            value={coverage.data ? formatPercent(coverage.data.autoClearedRate, 0) : '—'}
            icon={Zap}
            hint="Share of criteria settled without a human. Rising means the system is earning trust."
            sub={
              coverage.data
                ? `${coverage.data.decidedCriteria} decided · ${coverage.data.abstainedCriteria} abstained`
                : undefined
            }
          />
          <StatTile
            label="Cost per asset"
            value={cost.data ? formatUsd(cost.data.costPerAsset) : '—'}
            icon={DollarSign}
            sub={cost.data ? `${formatUsd(cost.data.cacheSavingsUsd)} saved by cache` : undefined}
          />
          <StatTile
            label="Cache hit rate"
            value={cost.data ? formatPercent(cost.data.cacheHitRate, 0) : '—'}
            icon={Percent}
            hint="Identical (asset, rule@version, ruleset hash) results are reused rather than re-judged."
          />
          <StatTile
            label="Rules above 20% override"
            value={unhealthy}
            icon={AlertTriangle}
            tone={unhealthy > 0 ? 'danger' : 'ok'}
            hint="Above 20% the rule is broken, not the customer. Fix the rule before blaming the reviewer."
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {summary.isPending ? <Skeleton className="h-64 w-full" /> : <ScoreTrendChart data={summary.data?.scoreTrend ?? []} />}
          {summary.isPending ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <DimensionPassChart data={summary.data?.dimensionBreakdown ?? []} />
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {ruleHealth.isPending ? (
            <Skeleton className="h-72 w-full" />
          ) : ruleHealth.isError ? (
            <ErrorState message={errorMessage(ruleHealth.error)} onRetry={() => void ruleHealth.refetch()} />
          ) : (
            <RuleHealthScatter rows={ruleHealth.data ?? []} />
          )}

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Coverage</CardTitle>
                <p className="mt-0.5 text-xs text-fg-muted">Criteria settled without a human.</p>
              </div>
            </CardHeader>
            <CardContent>
              {coverage.isPending ? (
                <Skeleton className="h-40 w-full" />
              ) : coverage.data ? (
                <>
                  <CoverageGauge
                    value={coverage.data.autoClearedRate}
                    sub={`${coverage.data.decidedCriteria} of ${coverage.data.totalCriteria} criteria`}
                  />
                  <ul className="mt-3 space-y-1.5">
                    {coverage.data.byDimension.map((row) => (
                      <li key={row.dimension} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-2 text-[11px]">
                        <span className="truncate text-fg-muted">{dimensionLabel(row.dimension)}</span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                          <span
                            className="block h-full rounded-full bg-accent"
                            style={{ width: `${Math.max(0, Math.min(100, row.coverage * 100))}%` }}
                          />
                        </span>
                        <span className="num text-right text-fg">{formatPercent(row.coverage, 0)}</span>
                      </li>
                    ))}
                  </ul>
                  {coverage.data.autoRoutedRules.length > 0 ? (
                    <div className="mt-3 rounded-md bg-major-soft p-2">
                      <p className="text-[11px] font-medium text-major-fg">
                        {coverage.data.autoRoutedRules.length} rule(s) auto-routed to human review
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {coverage.data.autoRoutedRules.slice(0, 5).map((rule) => (
                          <li key={rule.ruleKey} className="num text-[10px] text-major-fg/90">
                            {rule.ruleKey} — {rule.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : (
                <EmptyState compact className="border-0" title="No coverage data" description="Run a check first." />
              )}
            </CardContent>
          </Card>
        </div>

        {cost.isPending ? <Skeleton className="h-64 w-full" /> : <CostAreaChart data={cost.data?.byDay ?? []} />}

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-fg">Rule health</h2>
          <DataTable
            columns={ruleColumns}
            rows={ruleHealth.data ?? []}
            rowKey={(r) => r.ruleKey}
            caption="Per-rule health metrics"
            loading={ruleHealth.isPending}
            error={ruleHealth.isError ? errorMessage(ruleHealth.error) : null}
            onRetry={() => void ruleHealth.refetch()}
            pageSize={20}
            dense
            initialSort={{ columnId: 'overrideRate', direction: 'desc' }}
            empty={
              <EmptyState
                title="No rule evaluations in this window"
                description="Rule health appears once checks have run against an active ruleset."
              />
            }
          />
        </section>

        {cost.data && cost.data.byProvider.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Spend by provider</CardTitle>
              <span className="num text-fg-subtle">{formatUsd(cost.data.totalUsd)} total</span>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {cost.data.byProvider.map((row) => (
                  <li key={`${row.provider}-${row.model}`} className="flex items-center gap-3 px-4 py-2">
                    <span className="num min-w-0 flex-1 truncate text-fg">
                      {row.provider} · {row.model}
                    </span>
                    <span className="num text-fg-subtle">{row.calls} calls</span>
                    <span className="num font-semibold text-fg">{formatUsd(row.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </PageBody>
    </div>
  );
}
