'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, GitFork, Hourglass, ShieldCheck } from 'lucide-react';
import type { InheritedRule } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { SeverityBadge } from '@/components/severity-badge';
import { TierBadge } from '@/components/tier-badge';
import { dimensionLabel } from '@/lib/domain';
import { formatMeasured } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ontologyAction, ontologyPhrase } from './ontology-labels';

/**
 * One inherited rule, and — the point of the screen — what state it is in.
 *
 * Four states matter and they are easy to confuse on a list that only shows
 * rule text:
 *
 *   waiting     the analyzer needs ontology this brand has not supplied, so it
 *               returns not_applicable and looks exactly like a pass
 *   overridden  a brand rule with the same key wins; this one does not run
 *   drifted     forked, and the standard has since been corrected
 *   inherited   running as shipped
 *
 * The first is the one this screen exists for. A brand can sit on a green
 * dashboard for months while a third of its rules quietly abstain.
 */
export function InheritedRuleRow({
  rule,
  brandId,
  onFork,
  forking,
  canManage,
}: {
  rule: InheritedRule;
  brandId: string;
  onFork: () => void;
  forking: boolean;
  canManage: boolean;
}) {
  const waiting = rule.missingOntology.length > 0;
  const overridden = rule.overriddenBy !== null;
  const drifted = rule.drift !== null;

  return (
    <article
      className={cn(
        'rounded-lg border bg-surface p-3',
        drifted ? 'border-[var(--major)]' : 'border-border hover:border-border-strong',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={rule.severity} />
            <Badge tone="outline">{dimensionLabel(rule.dimension)}</Badge>
            <TierBadge tier={rule.tier} />
            <span className="num text-fg-subtle">{rule.key}</span>
            {rule.status !== 'active' ? <Badge tone="accent">proposed</Badge> : null}
          </div>

          <p className={cn('mt-1.5 text-[13px] font-medium leading-5', overridden ? 'text-fg-muted' : 'text-fg')}>
            {rule.statement}
          </p>
          {rule.rationale ? <p className="mt-0.5 text-xs leading-5 text-fg-muted">{rule.rationale}</p> : null}

          <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-fg-subtle">
            <ShieldCheck className="size-3" aria-hidden="true" />
            <span>
              from <span className="text-fg-muted">{rule.packName}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="num">
              {rule.check.fn}
              {Object.entries(rule.check.params ?? {}).length > 0
                ? ` (${Object.entries(rule.check.params ?? {})
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${formatMeasured(v)}`)
                    .join(', ')})`
                : ''}
            </span>
          </p>

          {rule.guidance ? (
            <p className="mt-1.5 rounded border border-border bg-surface-2 px-2 py-1.5 text-[11px] leading-5 text-fg-muted">
              {rule.guidance}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StateChip rule={rule} brandId={brandId} />
          {!overridden && canManage ? (
            <Tooltip content="Creates your own copy of this rule. Nothing changes about what is enforced — you just own it and can edit it.">
              <Button size="sm" variant="outline" loading={forking} onClick={onFork}>
                <GitFork className="size-3.5" aria-hidden="true" />
                Fork to brand
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {waiting ? <WaitingNotice rule={rule} brandId={brandId} /> : null}
      {drifted ? <DriftNotice rule={rule} brandId={brandId} /> : null}
    </article>
  );
}

function StateChip({ rule, brandId }: { rule: InheritedRule; brandId: string }) {
  if (rule.drift) {
    return (
      <Badge tone="major">
        <AlertTriangle className="mr-1 inline size-3" aria-hidden="true" />
        baseline moved
      </Badge>
    );
  }
  if (rule.overriddenBy) {
    return (
      <Link
        href={`/brands/${brandId}/rules?search=${encodeURIComponent(rule.key)}`}
        className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
      >
        {rule.overriddenBy.forked ? 'your fork' : 'your rule'} v{rule.overriddenBy.version}
        <ArrowRight className="size-3" aria-hidden="true" />
      </Link>
    );
  }
  if (rule.missingOntology.length > 0) {
    return (
      <Badge tone="advisory">
        <Hourglass className="mr-1 inline size-3" aria-hidden="true" />
        waiting
      </Badge>
    );
  }
  return <Badge tone="ok">running</Badge>;
}

function WaitingNotice({ rule, brandId }: { rule: InheritedRule; brandId: string }) {
  const first = ontologyAction(rule.missingOntology[0]!, brandId);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1 rounded border border-[var(--advisory)] bg-advisory-soft px-2 py-1.5 text-[11px] leading-5 text-advisory-fg">
      <Hourglass className="size-3 shrink-0" aria-hidden="true" />
      <span>
        This rule cannot produce a verdict until you add {ontologyPhrase(rule.missingOntology, 5)}. Until then it
        abstains — it will not fail an asset, and it will not catch anything either.
      </span>
      {first.href ? (
        <Link href={first.href} className="font-medium underline underline-offset-2">
          {first.action}
        </Link>
      ) : null}
    </p>
  );
}

function DriftNotice({ rule, brandId }: { rule: InheritedRule; brandId: string }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1 rounded border border-[var(--major)] bg-major-soft px-2 py-1.5 text-[11px] leading-5 text-major-fg">
      <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
      <span>
        You forked this at v{rule.drift!.forkedFromVersion} and the shipped standard is now v
        {rule.drift!.currentVersion}. Your copy is unaffected — which is the point of forking — but the correction
        has not reached it.
      </span>
      <Link
        href={`/brands/${brandId}/rules?search=${encodeURIComponent(rule.key)}`}
        className="font-medium underline underline-offset-2"
      >
        Compare with your rule
      </Link>
    </p>
  );
}
