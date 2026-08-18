'use client';

import * as React from 'react';
import Link from 'next/link';
import { BookMarked, ChevronDown, Cpu, Lightbulb, Percent } from 'lucide-react';
import type { DecisionTraceDTO, FindingDTO } from '@brandlens/contracts';
import { cn } from '@/lib/utils';
import { SeverityBadge, SeverityRail } from '@/components/severity-badge';
import { TierBadge } from '@/components/tier-badge';
import { MeasuredVsThreshold } from '@/components/measured-value';
import { EvidenceCrop } from '@/components/evidence-crop';
import { PrecedentStrip } from '@/components/precedent-strip';
import { DecisionControls } from '@/components/decision-controls';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { dimensionLabel, FINDING_STATUS_LABEL, VERDICT_LABEL } from '@/lib/domain';
import { formatPercent, formatUsd } from '@/lib/format';
import type { DecisionAction } from '@/hooks/use-findings';

export interface FindingCardProps {
  finding: FindingDTO;
  trace?: DecisionTraceDTO;
  /** The rule statement, when the compiled ruleset is available. */
  statement?: string;
  previewUrl?: string | null;
  selected?: boolean;
  expanded?: boolean;
  onSelect?: () => void;
  onToggleExpand?: () => void;
  onDecide?: (action: DecisionAction, rationale?: string) => void | Promise<void>;
  decisionPending?: boolean;
  brandId?: string;
  className?: string;
}

/**
 * A finding, argued in the order a reviewer actually needs it:
 *
 *   rule statement → measured value vs threshold → evidence crop → citation
 *   → precedent → suggested fix → tier (and, for T2, model + confidence +
 *   vote entropy).
 *
 * Anything that arrives out of that order makes the reviewer re-derive the
 * argument themselves, which is how a report stops being read.
 */
export function FindingCard({
  finding,
  trace,
  statement,
  previewUrl,
  selected = false,
  expanded = false,
  onSelect,
  onToggleExpand,
  onDecide,
  decisionPending = false,
  brandId,
  className,
}: FindingCardProps) {
  const contentId = React.useId();
  const citation = normalizeCitation(trace?.citation);
  const model = trace?.model ?? null;
  const isVlm = trace?.tier === 'vlm' || trace?.tier === 'hybrid';

  return (
    <article
      id={`finding-${finding.id}`}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex gap-2 rounded-md border bg-surface transition-colors',
        selected ? 'border-accent shadow-[0_0_0_1px_var(--accent)]' : 'border-border hover:border-border-strong',
        className,
      )}
      onMouseEnter={onSelect}
    >
      <SeverityRail severity={finding.severity} className="my-2 ml-2" />

      <div className="min-w-0 flex-1 py-2 pr-2">
        <button
          type="button"
          onClick={() => {
            onSelect?.();
            onToggleExpand?.();
          }}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="flex w-full items-start gap-2 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <SeverityBadge severity={finding.severity} />
              <Badge tone="outline">{dimensionLabel(finding.dimension)}</Badge>
              {trace ? <TierBadge tier={trace.tier} /> : null}
              {finding.status !== 'open' ? (
                <Badge tone={finding.status === 'overridden' ? 'major' : finding.status === 'waived' ? 'advisory' : 'ok'}>
                  {FINDING_STATUS_LABEL[finding.status] ?? finding.status}
                </Badge>
              ) : null}
              {!finding.isHighConfidence ? (
                <Tooltip content="Below the confidence bar. Shown under “Possible issues” so low-confidence flags do not erode trust in the report.">
                  <Badge tone="neutral" className="cursor-help">
                    low confidence
                  </Badge>
                </Tooltip>
              ) : null}
            </div>

            {/* 1. The rule statement — what was actually required. */}
            <p className="mt-1.5 text-[13px] font-medium leading-5 text-fg">{statement ?? finding.title}</p>
            {statement && statement !== finding.title ? (
              <p className="mt-0.5 text-xs leading-5 text-fg-muted">{finding.title}</p>
            ) : null}
            <p className="mt-0.5 font-mono text-[11px] text-fg-subtle">
              {finding.ruleKey}
              {trace ? `@v${trace.ruleVersion}` : ''}
            </p>
          </div>

          <ChevronDown
            className={cn('mt-1 size-4 shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-180')}
            aria-hidden="true"
          />
        </button>

        {/* 2. Measured vs threshold, always visible: it is the argument. */}
        {trace?.evidence ? <MeasuredVsThreshold evidence={trace.evidence} className="mt-2" dense={!expanded} /> : null}

        {expanded ? (
          <div id={contentId} className="mt-3 space-y-3 border-t border-border pt-3">
            {finding.detail ? <p className="text-xs leading-5 text-fg-muted">{finding.detail}</p> : null}

            {/* 3. The evidence crop. */}
            <div>
              <p className="mb-1 text-[11px] font-medium text-fg-muted">Evidence</p>
              <EvidenceCrop src={previewUrl} bbox={finding.bbox} severity={finding.severity} height={140} />
            </div>

            {/* 4. The citation. */}
            <div>
              <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-fg-muted">
                <BookMarked className="size-3" aria-hidden="true" />
                Citation
              </p>
              {citation ? (
                <p className="text-xs text-fg">
                  {citation.doc ?? 'Brand book'}
                  {citation.page !== undefined ? (
                    <span className="text-fg-muted"> · p.{citation.page}</span>
                  ) : null}
                  {citation.extractedBy ? (
                    <span className="ml-1 font-mono text-[11px] text-fg-subtle">({citation.extractedBy})</span>
                  ) : null}
                  {brandId && citation.documentId ? (
                    <Link
                      href={`/brands/${brandId}/documents?doc=${citation.documentId}`}
                      className="ml-2 text-accent hover:underline"
                    >
                      Open document
                    </Link>
                  ) : null}
                </p>
              ) : (
                <p className="text-[11px] text-fg-subtle">
                  No document citation — this rule was induced from approved assets or hand-authored.
                </p>
              )}
            </div>

            {/* 5. Precedent. */}
            <PrecedentStrip assetIds={trace?.precedentAssetIds ?? null} />

            {/* 6. Suggested fix. */}
            {trace?.suggestedFix ? (
              <div className="rounded-md border border-accent/30 bg-accent-soft/50 p-2">
                <p className="flex items-center gap-1 text-[11px] font-medium text-accent-soft-fg">
                  <Lightbulb className="size-3" aria-hidden="true" />
                  Suggested fix
                </p>
                <p className="mt-0.5 text-xs leading-5 text-fg">{trace.suggestedFix}</p>
              </div>
            ) : null}

            {/* 7. Tier provenance — and for T2, the model that judged it. */}
            {trace ? (
              <div className="rounded-md border border-border bg-surface-2 p-2">
                <p className="flex items-center gap-1 text-[11px] font-medium text-fg-muted">
                  <Cpu className="size-3" aria-hidden="true" />
                  How this was decided
                </p>
                <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3">
                  <Meta label="Tier" value={<TierBadge tier={trace.tier} withLabel />} />
                  <Meta label="Verdict" value={VERDICT_LABEL[trace.verdict] ?? trace.verdict} />
                  <Meta
                    label="Confidence"
                    value={
                      trace.confidence === null || trace.confidence === undefined ? (
                        <span className="text-fg-subtle">n/a</span>
                      ) : (
                        <span className="num">{formatPercent(trace.confidence, 0)}</span>
                      )
                    }
                  />
                  {isVlm && model ? (
                    <>
                      <Meta
                        label="Model"
                        value={<span className="num break-all">{model.id ?? model.provider ?? 'unknown'}</span>}
                      />
                      {model.selfConsistencyK && model.selfConsistencyK > 1 ? (
                        <Meta label="Self-consistency" value={<span className="num">k={model.selfConsistencyK}</span>} />
                      ) : null}
                      {model.voteEntropy !== undefined && model.voteEntropy !== null ? (
                        <Meta
                          label="Vote entropy"
                          value={
                            <Tooltip content="Disagreement across self-consistency samples. High entropy means the judge was not sure and the finding deserves a human.">
                              <span className="num inline-flex cursor-help items-center gap-1">
                                <Percent className="size-3" aria-hidden="true" />
                                {model.voteEntropy.toFixed(3)}
                              </span>
                            </Tooltip>
                          }
                        />
                      ) : null}
                      {model.promptHash ? (
                        <Meta label="Prompt" value={<span className="num">{model.promptHash.slice(0, 10)}…</span>} />
                      ) : null}
                    </>
                  ) : null}
                  <Meta label="Cached" value={trace.cached ? 'yes' : 'no'} />
                  <Meta label="Cost" value={<span className="num">{formatUsd(trace.costUsd)}</span>} />
                  <Meta label="Trace" value={<span className="num break-all">{trace.traceKey.slice(0, 14)}…</span>} />
                </dl>
              </div>
            ) : null}

            {onDecide ? (
              <DecisionControls status={finding.status} pending={decisionPending} onDecide={onDecide} compact />
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="text-fg">{value}</dd>
    </div>
  );
}

interface NormalizedCitation {
  doc?: string;
  documentId?: string;
  page?: number;
  extractedBy?: string;
}

function normalizeCitation(citation: unknown): NormalizedCitation | null {
  if (!citation || typeof citation !== 'object') return null;
  const record = citation as Record<string, unknown>;
  const doc = typeof record.doc === 'string' ? record.doc : undefined;
  const documentId = typeof record.documentId === 'string' ? record.documentId : undefined;
  const page = typeof record.page === 'number' ? record.page : undefined;
  const extractedBy = typeof record.extractedBy === 'string' ? record.extractedBy : undefined;
  if (!doc && !documentId && page === undefined && !extractedBy) return null;
  return { doc, documentId, page, extractedBy };
}
