'use client';

import * as React from 'react';
import Link from 'next/link';
import { BookMarked, CheckCheck, ClipboardList, Rocket, Sparkles, X } from 'lucide-react';
import type { Rule } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { SkeletonCards } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { useBulkRuleDecisionMutation, useRulesQuery, useUpdateRuleMutation } from '@/hooks/use-rules';
import { useBrandQuery } from '@/hooks/use-brands';
import { useDocumentsQuery } from '@/hooks/use-ontology';
import { errorMessage } from '@/lib/api-client';
import { DIMENSIONS, DIMENSION_LABEL } from '@/lib/domain';
import { ProposedRuleCard } from './proposed-rule-card';
import type { RuleEditorValues } from '@/components/rule-editor';

type Group = 'deductive' | 'inductive' | 'other';

const GROUP_META: Record<Group, { title: string; description: string; icon: typeof BookMarked }> = {
  deductive: {
    title: 'From your brand book',
    description: 'Extracted from an uploaded guideline document. Each one carries the page it came from.',
    icon: BookMarked,
  },
  inductive: {
    title: 'Learned from your approved assets',
    description:
      'Induced by measuring the approved corpus — the rules your team actually enforces, as opposed to the ones they wrote down.',
    icon: Sparkles,
  },
  other: {
    title: 'External standards and hand-authored',
    description: 'Imported from WCAG, IAB or a platform spec, or written by someone in this organization.',
    icon: ClipboardList,
  },
};

/**
 * The onboarding moment.
 *
 * A proposed rule is never auto-activated. This screen is where a human turns
 * extraction output into policy, so it has to make each proposal defensible in
 * one glance: what it says, where it came from, and what the evidence is.
 */
export function RuleReviewBoard({ brandId }: { brandId: string }) {
  const { toast } = useToast();
  const { data: brand } = useBrandQuery(brandId);
  const { data: documents } = useDocumentsQuery(brandId);
  const { data: allRules, isPending, isError, error, refetch } = useRulesQuery(brandId, {});
  const bulk = useBulkRuleDecisionMutation(brandId);
  const update = useUpdateRuleMutation(brandId);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [dimension, setDimension] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [confirmActivate, setConfirmActivate] = React.useState(false);

  const documentNames = React.useMemo(() => {
    const map = new Map<string, string>();
    documents?.forEach((doc) => map.set(doc.id, doc.name));
    return map;
  }, [documents]);

  const proposed = React.useMemo(() => (allRules ?? []).filter((r) => r.status === 'proposed'), [allRules]);
  const confirmed = React.useMemo(() => (allRules ?? []).filter((r) => r.status === 'active').length, [allRules]);
  const totalFound = proposed.length + confirmed;

  const filtered = React.useMemo(
    () =>
      proposed.filter((rule) => {
        if (dimension && rule.dimension !== dimension) return false;
        if (search) {
          const needle = search.toLowerCase();
          if (!rule.statement.toLowerCase().includes(needle) && !rule.key.toLowerCase().includes(needle)) return false;
        }
        return true;
      }),
    [proposed, dimension, search],
  );

  const groups = React.useMemo(() => {
    const map: Record<Group, Rule[]> = { deductive: [], inductive: [], other: [] };
    for (const rule of filtered) {
      if (rule.provenance === 'deductive') map.deductive.push(rule);
      else if (rule.provenance === 'inductive') map.inductive.push(rule);
      else map.other.push(rule);
    }
    return map;
  }, [filtered]);

  const decide = async (ruleIds: string[], action: 'activate' | 'reject') => {
    if (ruleIds.length === 0) return;
    try {
      await bulk.mutateAsync({ ruleIds, action });
      setSelected((current) => {
        const next = new Set(current);
        ruleIds.forEach((id) => next.delete(id));
        return next;
      });
      toast({
        title: action === 'activate' ? `${ruleIds.length} rule(s) activated` : `${ruleIds.length} rule(s) rejected`,
        description:
          action === 'activate'
            ? 'Compile a ruleset to put them into effect for new checks.'
            : 'Rejected rules stay in history and are never re-proposed.',
        tone: 'success',
      });
    } catch (mutationError) {
      toast({ title: 'Decision failed', description: errorMessage(mutationError), tone: 'error' });
    }
  };

  const saveRule = async (rule: Rule, values: RuleEditorValues) => {
    try {
      await update.mutateAsync({
        ruleId: rule.id,
        body: {
          statement: values.statement,
          severity: values.severity,
          weight: values.weight,
          check: { fn: rule.check?.fn ?? '', params: values.params },
        },
      });
      toast({ title: 'Rule updated', description: 'The proposal now reflects your parameters.', tone: 'success' });
    } catch (mutationError) {
      toast({ title: 'Could not save the rule', description: errorMessage(mutationError), tone: 'error' });
    }
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAllVisible = () => setSelected(new Set(filtered.map((r) => r.id)));

  const progressPct = totalFound > 0 ? (confirmed / totalFound) * 100 : 0;

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Brands', href: '/brands' },
          { label: brand?.name ?? 'Brand', href: `/brands/${brandId}` },
          { label: 'Rules', href: `/brands/${brandId}/rules` },
          { label: 'Confirm proposals' },
        ]}
        title="Confirm proposed rules"
        description="Nothing here is active yet. A proposed rule becomes policy only when a person says so."
        actions={
          <>
            <Link href={`/brands/${brandId}/rules`} className={buttonClasses('outline', 'sm')}>
              All rules
            </Link>
            <Link href={`/brands/${brandId}/rulesets`} className={buttonClasses('secondary', 'sm')}>
              <Rocket className="size-3.5" aria-hidden="true" />
              Compile ruleset
            </Link>
          </>
        }
      />

      <PageBody className="space-y-4">
        {/* The running counter. */}
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-fg">
              <span className="num font-semibold">{totalFound}</span> rules found ·{' '}
              <span className="num font-semibold text-[var(--ok-fg)]">{confirmed}</span> confirmed ·{' '}
              <span className="num font-semibold text-[var(--sev-major-fg)]">{proposed.length}</span> remaining
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={selectAllVisible} disabled={filtered.length === 0}>
                Select all visible ({filtered.length})
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Clear
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={selected.size === 0}
                loading={bulk.isPending}
                onClick={() => setConfirmActivate(true)}
              >
                <CheckCheck className="size-3.5" aria-hidden="true" />
                Activate selected ({selected.size})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={selected.size === 0}
                onClick={() => void decide(Array.from(selected), 'reject')}
              >
                <X className="size-3.5" aria-hidden="true" />
                Reject selected
              </Button>
            </div>
          </div>
          <Progress className="mt-2.5" value={progressPct} label="Rules confirmed" size="sm" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder="Filter by statement or key"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Filter proposed rules"
          />
          <Select
            className="w-44"
            value={dimension}
            placeholder="All dimensions"
            onChange={(event) => setDimension(event.target.value)}
            aria-label="Filter by dimension"
            options={DIMENSIONS.map((d) => ({ value: d, label: DIMENSION_LABEL[d] }))}
          />
          <span className="num text-fg-subtle">
            {filtered.length}/{proposed.length} shown
          </span>
        </div>

        {isPending ? <SkeletonCards count={4} /> : null}
        {isError ? (
          <ErrorState
            title="Could not load proposed rules"
            message={errorMessage(error)}
            onRetry={() => void refetch()}
          />
        ) : null}

        {!isPending && !isError && proposed.length === 0 ? (
          <EmptyState
            icon={CheckCheck}
            title="No rules awaiting confirmation"
            description={
              confirmed > 0
                ? `All ${confirmed} rule(s) for this brand are confirmed. Upload another guideline document or induce rules from approved assets to propose more.`
                : 'Upload a brand book and run extraction, or induce rules by measuring your approved assets.'
            }
            actionLabel="Go to documents"
            actionHref={`/brands/${brandId}/documents`}
          />
        ) : null}

        {(Object.keys(GROUP_META) as Group[]).map((group) => {
          const rules = groups[group];
          if (rules.length === 0) return null;
          const meta = GROUP_META[group];
          const Icon = meta.icon;
          const ids = rules.map((r) => r.id);

          return (
            <section key={group} aria-labelledby={`group-${group}`}>
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 id={`group-${group}`} className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                    <Icon className="size-3.5 text-accent" aria-hidden="true" />
                    {meta.title}
                    <Badge tone="neutral">{rules.length}</Badge>
                  </h2>
                  <p className="mt-0.5 max-w-2xl text-xs leading-5 text-fg-muted">{meta.description}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setSelected((s) => new Set([...s, ...ids]))}>
                  Select group
                </Button>
              </div>

              <div className="space-y-2">
                {rules.map((rule) => (
                  <ProposedRuleCard
                    key={rule.id}
                    rule={rule}
                    brandId={brandId}
                    selected={selected.has(rule.id)}
                    onToggleSelect={() => toggle(rule.id)}
                    onApprove={() => void decide([rule.id], 'activate')}
                    onReject={() => void decide([rule.id], 'reject')}
                    onSave={(values) => saveRule(rule, values)}
                    pending={bulk.isPending}
                    saving={update.isPending}
                    documentName={rule.citation?.documentId ? documentNames.get(rule.citation.documentId) : undefined}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </PageBody>

      <ConfirmDialog
        open={confirmActivate}
        onClose={() => setConfirmActivate(false)}
        onConfirm={async () => {
          setConfirmActivate(false);
          await decide(Array.from(selected), 'activate');
        }}
        title={`Activate ${selected.size} rule(s)?`}
        description="Activation is recorded with your name in the audit trail and emits rule.activated."
        confirmLabel="Activate"
        loading={bulk.isPending}
      >
        <p className="text-xs leading-5 text-fg-muted">
          Activated rules take effect for new checks once you compile a ruleset. Existing check runs stay pinned to the
          ruleset hash they were evaluated against, so history remains reproducible.
        </p>
      </ConfirmDialog>
    </div>
  );
}
