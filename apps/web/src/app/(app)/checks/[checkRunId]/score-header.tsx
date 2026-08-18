'use client';

import * as React from 'react';
import { AlertOctagon, Info, TriangleAlert } from 'lucide-react';
import type { CheckRunDetail } from '@brandlens/contracts';
import { ScoreGauge } from '@/components/score-gauge';
import { DimensionBars } from '@/components/dimension-bars';
import { Badge } from '@/components/ui/badge';
import { InfoHint } from '@/components/ui/tooltip';
import { formatDuration, formatPercent, formatUsd, shortHash } from '@/lib/format';
import { RUN_STATUS_LABEL } from '@/lib/domain';

/**
 * The score header.
 *
 * The number is a deterministic aggregation over atomic criteria — the note
 * saying so is not decoration. A reviewer who believes they are looking at a
 * model's opinion discounts everything below it.
 */
export function ScoreHeader({ run }: { run: CheckRunDetail }) {
  const cacheTotal = run.cacheHits + run.cacheMisses;
  const cacheRate = cacheTotal > 0 ? run.cacheHits / cacheTotal : null;

  return (
    <section className="space-y-3 border-b border-border p-3">
      {run.hasBlocker ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-blocker/50 bg-blocker-soft px-3 py-2"
        >
          <AlertOctagon className="mt-px size-4 shrink-0 text-blocker" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-semibold text-blocker-fg">Blocker present — the asset fails regardless of score</p>
            <p className="mt-0.5 text-[11px] leading-4 text-blocker-fg/90">
              A blocker overrides the aggregate. Resolve or override it before this asset can clear.
            </p>
          </div>
        </div>
      ) : null}

      {run.status === 'degraded' ? (
        <div role="status" className="flex items-start gap-2 rounded-md border border-major/50 bg-major-soft px-3 py-2">
          <TriangleAlert className="mt-px size-4 shrink-0 text-major" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-semibold text-major-fg">Partial result</p>
            <p className="mt-0.5 text-[11px] leading-4 text-major-fg/90">
              {run.degradedReason ?? 'Some criteria could not be evaluated in this run.'} Coverage below is the honest
              denominator: treat the score as provisional.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        <ScoreGauge score={run.score} band={run.scoreBand} hasBlocker={run.hasBlocker} size={104} />

        <div className="min-w-[13rem] flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={run.status === 'completed' ? 'ok' : run.status === 'degraded' ? 'major' : 'neutral'}>
              {RUN_STATUS_LABEL[run.status] ?? run.status}
            </Badge>
            <Badge tone="outline" mono title={run.rulesetHash}>
              ruleset {shortHash(run.rulesetHash, 12)}
            </Badge>
            {run.durationMs ? (
              <Badge tone="neutral" mono>
                {formatDuration(run.durationMs)}
              </Badge>
            ) : null}
          </div>

          <p className="mt-2 flex items-start gap-1 text-[11px] leading-4 text-fg-muted">
            <Info className="mt-px size-3 shrink-0" aria-hidden="true" />
            <span>
              This score is a <strong className="font-medium text-fg">deterministic aggregation over atomic criteria</strong>,
              weighted per dimension. No raw model score is ever surfaced — judges rank well and score badly.
            </span>
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3">
            <Metric label="Criteria passed" value={run.criteriaPassed} tone="ok" />
            <Metric label="Failed" value={run.criteriaFailed} tone={run.criteriaFailed > 0 ? 'danger' : 'default'} />
            <Metric
              label="Abstained"
              value={run.criteriaAbstained}
              hint="The judge declined rather than inventing a verdict. Abstentions route to a human instead of becoming false positives."
            />
            <Metric
              label="Coverage"
              value={formatPercent(run.coverageRate)}
              hint="Share of the ruleset that produced a decision. A high score over low coverage is not a pass."
            />
            <Metric
              label="Cache hits"
              value={cacheRate === null ? `${run.cacheHits}` : `${run.cacheHits} · ${formatPercent(cacheRate, 0)}`}
              hint="Identical (asset, rule@version, ruleset hash) results are reused. Cache hits cost nothing."
            />
            <Metric label="Cost" value={formatUsd(run.costUsd)} />
          </dl>
        </div>

        <div className="min-w-[15rem] flex-1">
          <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
            Dimension scores
            <InfoHint content="Analytic sub-scores per dimension, each an aggregation of that dimension's criteria." />
          </p>
          <DimensionBars scores={run.dimensionScores} emptyLabel="No dimension produced a score in this run." />
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'ok' | 'danger';
}) {
  const color = tone === 'ok' ? 'text-[var(--ok-fg)]' : tone === 'danger' ? 'text-blocker-fg' : 'text-fg';
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-fg-subtle">
        {label}
        {hint ? <InfoHint content={hint} /> : null}
      </dt>
      <dd className={`num font-semibold ${color}`}>{value}</dd>
    </div>
  );
}
