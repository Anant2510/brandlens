'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  ClipboardCheck,
  DollarSign,
  Gauge,
  Layers,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { PageBody, PageHeader } from '@/components/app-shell';
import { StatTile } from '@/components/stat-tile';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonCards } from '@/components/ui/skeleton';
import { ScoreTrendChart } from '@/components/charts/score-trend-chart';
import { DimensionPassChart } from '@/components/charts/dimension-pass-chart';
import { useDashboardSummaryQuery } from '@/hooks/use-analytics';
import { useBrandsQuery } from '@/hooks/use-brands';
import { useSession } from '@/providers/session-provider';
import { errorMessage } from '@/lib/api-client';
import { formatPercent, formatScore, formatUsd } from '@/lib/format';

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export function DashboardView() {
  const user = useSession();
  const [days, setDays] = React.useState('30');
  const [brandId, setBrandId] = React.useState('');

  const from = React.useMemo(
    () => new Date(Date.now() - Number(days) * 86_400_000).toISOString(),
    [days],
  );

  const { data: brands } = useBrandsQuery();
  const { data, isPending, isError, error, refetch } = useDashboardSummaryQuery({
    from,
    brandId: brandId || undefined,
  });

  return (
    <div>
      <PageHeader
        title={`${user.orgName || 'Organization'} overview`}
        description="Verification throughput, trust signals and spend across every brand you govern."
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
        {isError ? (
          <ErrorState
            title="Dashboard unavailable"
            message={errorMessage(error)}
            onRetry={() => void refetch()}
          />
        ) : null}

        {isPending ? (
          <>
            <SkeletonCards count={4} className="sm:grid-cols-2 lg:grid-cols-4" />
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          </>
        ) : null}

        {data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Auto-cleared"
                value={formatPercent(data.autoClearedRate, 0)}
                icon={Zap}
                tone={data.autoClearedRate >= 0.7 ? 'ok' : 'warn'}
                hint="Share of criteria settled without a human. The number the whole product exists to move."
                sub={`${data.checksRun} check(s) run in this window`}
                href="/analytics"
              />
              <StatTile
                label="Pass rate"
                value={formatPercent(data.passRate, 0)}
                icon={ShieldCheck}
                hint="Share of check runs that landed in the pass band."
                sub={`Avg score ${formatScore(data.avgScore)}`}
                href="/checks?scoreBand=pass"
              />
              <StatTile
                label="Blocker rate"
                value={formatPercent(data.blockerRate, 0)}
                icon={ShieldAlert}
                tone={data.blockerRate > 0.15 ? 'danger' : 'default'}
                hint="Runs containing at least one blocker. A blocker fails the asset regardless of score."
                sub={`${data.openFindings} open finding(s)`}
                href="/checks?scoreBand=fail"
              />
              <StatTile
                label="Cost per asset"
                value={formatUsd(data.costPerAsset)}
                icon={DollarSign}
                hint="Total model spend divided by assets analyzed. Cache hits cost nothing."
                sub={`${formatUsd(data.costUsd)} total · ${formatPercent(data.cacheHitRate, 0)} cache hits`}
                href="/analytics"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <ScoreTrendChart data={data.scoreTrend} />
              <DimensionPassChart data={data.dimensionBreakdown} />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <div>
                    <CardTitle>Top failing rules</CardTitle>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      Where the corpus and the ruleset disagree most. Check the override rate before tightening a rule.
                    </p>
                  </div>
                  <Link href="/analytics" className="text-xs text-accent hover:underline">
                    Rule health
                  </Link>
                </CardHeader>
                <CardContent className="p-0">
                  {data.topFailingRules.length === 0 ? (
                    <EmptyState
                      compact
                      className="m-3 border-0"
                      title="No failures recorded"
                      description="Either nothing has been checked, or everything passed."
                    />
                  ) : (
                    <ul className="divide-y divide-border">
                      {data.topFailingRules.map((rule) => (
                        <li key={rule.ruleKey} className="flex items-start gap-3 px-4 py-2.5">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] text-fg">{rule.statement}</p>
                            <p className="num text-fg-subtle">{rule.ruleKey}</p>
                          </div>
                          <span className="num shrink-0 font-semibold text-blocker-fg">{rule.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-3">
                <StatTile
                  label="Pending reviews"
                  value={data.pendingReviews}
                  icon={ClipboardCheck}
                  href="/review"
                  sub="Items waiting on a human decision"
                />
                <StatTile
                  label="Assets analyzed"
                  value={data.assetsAnalyzed}
                  icon={Layers}
                  href="/assets"
                  sub="Distinct assets with at least one run"
                />
                <StatTile
                  label="Checks run"
                  value={data.checksRun}
                  icon={Activity}
                  href="/checks"
                  sub="Every run is backed by an immutable trace"
                />
              </div>
            </div>

            {data.checksRun === 0 ? (
              <EmptyState
                icon={Gauge}
                title="Nothing has been verified yet"
                description="Create a brand, confirm its proposed rules, compile a ruleset, then upload an asset and run a check."
                actionLabel="Set up a brand"
                actionHref="/brands"
                secondary={
                  <Link href="/assets" className="text-xs text-accent hover:underline">
                    or upload an asset
                  </Link>
                }
              />
            ) : null}
          </>
        ) : null}
      </PageBody>
    </div>
  );
}
