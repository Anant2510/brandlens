'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, ExternalLink, Eye, EyeOff, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { DecisionTraceDTO, FindingDTO, Severity } from '@brandlens/contracts';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { FindingCard } from '@/components/finding-card';
import { SeverityBadge } from '@/components/severity-badge';
import { useCheckRunQuery, useRerunCheckMutation } from '@/hooks/use-checks';
import { useFindingDecisionMutation, type DecisionAction } from '@/hooks/use-findings';
import { useRulesQuery } from '@/hooks/use-rules';
import { errorMessage } from '@/lib/api-client';
import { dimensionLabel, SEVERITIES, SEVERITY_RANK } from '@/lib/domain';
import { formatDateTime } from '@/lib/format';
import { AssetCanvas } from './asset-canvas';
import { ScoreHeader } from './score-header';
import { TraceTable } from './trace-table';

type TabValue = 'findings' | 'traces';

export function CheckRunViewer({ checkRunId }: { checkRunId: string }) {
  const { toast } = useToast();
  const { data: run, isPending, isError, error, refetch, isFetching } = useCheckRunQuery(checkRunId);
  const rerun = useRerunCheckMutation();
  const decide = useFindingDecisionMutation(checkRunId);

  const [tab, setTab] = React.useState<TabValue>('findings');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [showAdvisories, setShowAdvisories] = React.useState(false);
  const [showLowConfidence, setShowLowConfidence] = React.useState(false);

  // Rule statements come from the brand's rules; the run itself carries keys.
  const { data: rules } = useRulesQuery(run?.brandId, {});
  const statements = React.useMemo(() => {
    const map = new Map<string, string>();
    rules?.forEach((rule) => {
      if (!map.has(rule.key)) map.set(rule.key, rule.statement);
    });
    return map;
  }, [rules]);

  const tracesByFinding = React.useMemo(() => {
    const map = new Map<string, DecisionTraceDTO>();
    run?.traces.forEach((trace) => map.set(trace.id, trace));
    return map;
  }, [run?.traces]);

  // High-confidence findings are the report. Low-confidence ones live behind
  // the "Possible issues" disclosure and never leak into the main list.
  const visibleFindings = React.useMemo(() => {
    if (!run) return [];
    return run.findings.filter((f) => (showAdvisories || f.severity !== 'advisory') && f.isHighConfidence);
  }, [run, showAdvisories]);

  const overlayFindings = React.useMemo(() => {
    if (!run) return [];
    return run.findings.filter((f) => showAdvisories || f.severity !== 'advisory');
  }, [run, showAdvisories]);

  const lowConfidence = React.useMemo(
    () => (run?.findings ?? []).filter((f) => !f.isHighConfidence && (showAdvisories || f.severity !== 'advisory')),
    [run?.findings, showAdvisories],
  );

  const advisoryCount = React.useMemo(() => (run?.findings ?? []).filter((f) => f.severity === 'advisory').length, [run?.findings]);

  const onDecide = React.useCallback(
    async (findingId: string, action: DecisionAction, rationale?: string) => {
      try {
        await decide.mutateAsync({ findingId, body: { action, rationale } });
        toast({ title: 'Decision recorded', description: 'Added to the audit trail and the calibration signal.', tone: 'success' });
      } catch (mutationError) {
        toast({ title: 'Could not record the decision', description: errorMessage(mutationError), tone: 'error' });
      }
    },
    [decide, toast],
  );

  if (isPending) return <CheckRunSkeleton />;

  if (isError || !run) {
    return (
      <div className="p-4">
        <ErrorState
          title="Could not load this check run"
          message={errorMessage(error) || 'The run may have been removed, or the API is unreachable.'}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const grouped = groupFindings(visibleFindings);

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        breadcrumbs={[{ label: 'Checks', href: '/checks' }, { label: 'Decision trace' }]}
        title={run.asset?.name ?? 'Check run'}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="num">{run.id}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDateTime(run.createdAt)}</span>
            {run.asset ? (
              <>
                <span aria-hidden="true">·</span>
                <Link href={`/assets/${run.asset.id}`} className="text-accent hover:underline">
                  Open asset
                </Link>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {run.status === 'queued' || run.status === 'running' ? (
              <Badge tone="accent">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                Live
              </Badge>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void refetch()} loading={isFetching}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={rerun.isPending}
              onClick={() => {
                rerun.mutate(run.id, {
                  onSuccess: () =>
                    toast({ title: 'Re-run queued', description: 'The result cache is bypassed for this run.', tone: 'info' }),
                  onError: (mutationError) =>
                    toast({ title: 'Re-run failed', description: errorMessage(mutationError), tone: 'error' }),
                });
              }}
            >
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Re-run
            </Button>
            {run.asset ? (
              <Link href={`/review?assetId=${run.asset.id}`} className={buttonClasses('outline', 'sm')}>
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Review queue
              </Link>
            ) : null}
          </>
        }
      />

      {/* Split layout. At 1280px the canvas keeps 55% and the findings rail
          stays wide enough to read a measurement without wrapping. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(30rem,1fr)]">
        <div className="min-h-[22rem] border-b border-border xl:sticky xl:top-0 xl:h-screen xl:border-b-0 xl:border-r">
          <AssetCanvas
            asset={run.asset}
            findings={overlayFindings}
            selectedId={selectedId}
            onSelect={setSelectedId}
            showAdvisories={showAdvisories}
            onToggleAdvisories={setShowAdvisories}
            advisoryCount={advisoryCount}
          />
        </div>

        <div className="min-w-0">
          <ScoreHeader run={run} />

          <Tabs
            className="px-3"
            panelId="check-tab-panel"
            value={tab}
            onValueChange={(value) => setTab(value as TabValue)}
            items={[
              { value: 'findings', label: 'Findings', count: visibleFindings.length },
              { value: 'traces', label: 'Trace', count: run.traces.length },
            ]}
          />

          <TabPanel id="check-tab-panel" value={tab}>
            {tab === 'findings' ? (
              <div className="space-y-4 p-3">
                {run.findings.length === 0 ? (
                  <EmptyState
                    icon={ShieldCheck}
                    title="No findings"
                    description={
                      run.criteriaEvaluated > 0
                        ? `All ${run.criteriaEvaluated} evaluated criteria passed. Nothing to review.`
                        : 'No criteria were evaluated in this run. Check the ruleset scope for this asset.'
                    }
                    compact
                  />
                ) : null}

                {grouped.map(({ severity, byDimension, total }) => (
                  <section key={severity} aria-labelledby={`sev-${severity}`}>
                    <h2 id={`sev-${severity}`} className="mb-2 flex items-center gap-2">
                      <SeverityBadge severity={severity} />
                      <span className="text-[11px] text-fg-subtle">
                        {total} finding{total === 1 ? '' : 's'}
                      </span>
                    </h2>

                    <div className="space-y-3">
                      {byDimension.map(({ dimension, findings }) => (
                        <div key={dimension}>
                          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
                            {dimensionLabel(dimension)}
                          </p>
                          <div className="space-y-1.5">
                            {findings.map((finding) => (
                              <FindingCard
                                key={finding.id}
                                finding={finding}
                                trace={tracesByFinding.get(finding.traceId)}
                                statement={statements.get(finding.ruleKey)}
                                previewUrl={run.asset?.previewUrl}
                                brandId={run.brandId}
                                selected={selectedId === finding.id}
                                expanded={expandedId === finding.id}
                                onSelect={() => setSelectedId(finding.id)}
                                onToggleExpand={() =>
                                  setExpandedId((current) => (current === finding.id ? null : finding.id))
                                }
                                onDecide={(action, rationale) => onDecide(finding.id, action, rationale)}
                                decisionPending={decide.isPending}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}

                {/* Low-confidence findings live behind a disclosure. Three bogus
                    flags and a reviewer stops reading the report permanently. */}
                {lowConfidence.length > 0 ? (
                  <section className="rounded-md border border-dashed border-border">
                    <button
                      type="button"
                      onClick={() => setShowLowConfidence((v) => !v)}
                      aria-expanded={showLowConfidence}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left"
                    >
                      {showLowConfidence ? (
                        <EyeOff className="size-3.5 text-fg-subtle" aria-hidden="true" />
                      ) : (
                        <Eye className="size-3.5 text-fg-subtle" aria-hidden="true" />
                      )}
                      <span className="text-[13px] font-medium text-fg">Possible issues</span>
                      <Badge tone="neutral">{lowConfidence.length}</Badge>
                      <span className="ml-auto flex items-center gap-1 text-[11px] text-fg-subtle">
                        {showLowConfidence ? 'Hide' : 'Show'}
                        <ChevronDown
                          className={`size-3.5 transition-transform ${showLowConfidence ? 'rotate-180' : ''}`}
                          aria-hidden="true"
                        />
                      </span>
                    </button>
                    <p className="px-3 pb-2 text-[11px] leading-4 text-fg-subtle">
                      Below the confidence bar for this rule. Kept out of the main report on purpose — a reviewer who sees
                      three bogus flags stops reading the report permanently.
                    </p>
                    {showLowConfidence ? (
                      <div className="space-y-1.5 border-t border-border p-3">
                        {lowConfidence.map((finding) => (
                          <FindingCard
                            key={finding.id}
                            finding={finding}
                            trace={tracesByFinding.get(finding.traceId)}
                            statement={statements.get(finding.ruleKey)}
                            previewUrl={run.asset?.previewUrl}
                            brandId={run.brandId}
                            selected={selectedId === finding.id}
                            expanded={expandedId === finding.id}
                            onSelect={() => setSelectedId(finding.id)}
                            onToggleExpand={() => setExpandedId((current) => (current === finding.id ? null : finding.id))}
                            onDecide={(action, rationale) => onDecide(finding.id, action, rationale)}
                            decisionPending={decide.isPending}
                          />
                        ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </div>
            ) : (
              <TraceTable traces={run.traces} runId={run.id} />
            )}
          </TabPanel>
        </div>
      </div>
    </div>
  );
}

interface DimensionGroup {
  dimension: string;
  findings: FindingDTO[];
}

interface SeverityGroup {
  severity: Severity;
  total: number;
  byDimension: DimensionGroup[];
}

/** Severity first (it drives triage), dimension second (it drives the fix). */
function groupFindings(findings: FindingDTO[]): SeverityGroup[] {
  const bySeverity = new Map<Severity, FindingDTO[]>();
  for (const finding of findings) {
    const list = bySeverity.get(finding.severity) ?? [];
    list.push(finding);
    bySeverity.set(finding.severity, list);
  }

  return SEVERITIES.filter((severity) => bySeverity.has(severity))
    .sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])
    .map((severity) => {
      const items = bySeverity.get(severity) ?? [];
      const byDimension = new Map<string, FindingDTO[]>();
      for (const finding of items) {
        const list = byDimension.get(finding.dimension) ?? [];
        list.push(finding);
        byDimension.set(finding.dimension, list);
      }
      return {
        severity,
        total: items.length,
        byDimension: Array.from(byDimension.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([dimension, list]) => ({ dimension, findings: list })),
      };
    });
}

function CheckRunSkeleton() {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-2 h-5 w-64" />
      </div>
      <div className="grid flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(30rem,1fr)]">
        <div className="border-b border-border p-4 xl:border-b-0 xl:border-r">
          <Skeleton className="h-[26rem] w-full" />
        </div>
        <div className="space-y-4 p-4">
          <div className="flex gap-4">
            <Skeleton className="size-24 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-40" />
              <SkeletonText lines={3} />
            </div>
          </div>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      <span className="sr-only">Loading check run</span>
    </div>
  );
}
