'use client';

import * as React from 'react';
import { AlertTriangle, Hourglass, Layers, ShieldCheck } from 'lucide-react';
import type { InheritedRule, RulePackSummary } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { BrandNav } from '@/components/brand-nav';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { useBrandQuery } from '@/hooks/use-brands';
import {
  useForkTemplateMutation,
  useInheritedRulesQuery,
  useRulePacksQuery,
  useSetRulePackEnabledMutation,
} from '@/hooks/use-rule-packs';
import { useSession } from '@/providers/session-provider';
import { hasRole } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import { DIMENSIONS, DIMENSION_LABEL } from '@/lib/domain';
import { PackCard } from './pack-card';
import { InheritedRuleRow } from './inherited-rule-row';
import { ontologyPhrase } from './ontology-labels';
import { filterRules, summarise, type Summary } from './state';

const CATEGORY_ORDER = ['baseline', 'heuristic', 'regulated'] as const;
const CATEGORY_HEADING: Record<string, string> = {
  baseline: 'Baseline',
  heuristic: 'Brand consistency',
  regulated: 'Regulated industries',
};

export function RulePacksView({ brandId }: { brandId: string }) {
  const user = useSession();
  const { toast } = useToast();
  const canManage = hasRole(user.role, 'brand_manager');
  const { data: brand } = useBrandQuery(brandId);

  const packs = useRulePacksQuery(brandId);
  const inherited = useInheritedRulesQuery(brandId);
  const setEnabled = useSetRulePackEnabledMutation(brandId);
  const fork = useForkTemplateMutation(brandId);

  const [tab, setTab] = React.useState('packs');
  const [pendingOff, setPendingOff] = React.useState<RulePackSummary | null>(null);
  const [reason, setReason] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [dimension, setDimension] = React.useState('');
  const [state, setState] = React.useState('');

  const summary = React.useMemo(() => summarise(inherited.data ?? []), [inherited.data]);

  const filtered = React.useMemo(
    () => filterRules(inherited.data ?? [], { search, dimension, state }),
    [inherited.data, search, dimension, state],
  );

  const toggle = async (pack: RulePackSummary, next: boolean) => {
    // Switching a shipped default OFF is the one act that needs a written
    // reason, so it goes through a dialog rather than a toggle. Everything
    // else applies immediately.
    if (!next && pack.enabledByDefault) {
      setPendingOff(pack);
      setReason('');
      return;
    }
    try {
      await setEnabled.mutateAsync({ packKey: pack.key, enabled: next });
      toast({ title: next ? `${pack.name} is now checking this brand` : `${pack.name} turned off` });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'error' });
    }
  };

  const confirmOff = async () => {
    if (!pendingOff) return;
    try {
      await setEnabled.mutateAsync({ packKey: pendingOff.key, enabled: false, reason });
      toast({ title: `${pendingOff.name} turned off`, description: 'Recorded against your name in the audit log.' });
      setPendingOff(null);
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'error' });
    }
  };

  const forkRule = async (rule: InheritedRule) => {
    try {
      const created = await fork.mutateAsync({ templateId: rule.templateId });
      toast({
        title: `${rule.key} is now yours`,
        description:
          created.status === 'active'
            ? 'Still enforcing exactly what it did a moment ago — you can edit it from the Rules screen.'
            : 'Copied as a proposal, the same status it had in the pack.',
      });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'error' });
    }
  };

  const byCategory = groupByCategory(packs.data ?? []);

  return (
    <>
      <PageHeader
        title="Standards"
        breadcrumbs={[{ label: 'Brands', href: '/brands' }, { label: brand?.name ?? '…' }]}
        description={
          inherited.isPending ? (
            'Loading what checks this brand…'
          ) : (
            <SummaryLine summary={summary} packCount={(packs.data ?? []).filter((p) => p.enabled).length} />
          )
        }
      />
      <BrandNav brandId={brandId} />

      <PageBody className="space-y-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          panelId="standards-panel"
          items={[
            { value: 'packs', label: `Packs (${(packs.data ?? []).length})` },
            { value: 'rules', label: `Inherited rules (${(inherited.data ?? []).length})` },
          ]}
        />

        {tab === 'packs' ? (
          <TabPanel id="standards-panel" value={tab}>
          {packs.isError ? (
            <ErrorState title="Could not load the rule packs" message={errorMessage(packs.error)} />
          ) : packs.isPending ? (
            <CardSkeletons />
          ) : (
            <div className="space-y-5">
              {CATEGORY_ORDER.filter((c) => byCategory[c]?.length).map((category) => (
                <section key={category}>
                  <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                    {CATEGORY_HEADING[category]}
                  </h2>
                  <div className="grid gap-2 lg:grid-cols-2">
                    {byCategory[category]!.map((pack) => (
                      <PackCard
                        key={pack.key}
                        pack={pack}
                        canManage={canManage}
                        busy={setEnabled.isPending && setEnabled.variables?.packKey === pack.key}
                        onToggle={(next) => void toggle(pack, next)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          </TabPanel>
        ) : (
          <TabPanel id="standards-panel" value={tab}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search statements and keys"
              className="max-w-xs"
              aria-label="Search inherited rules"
            />
            <Select
              className="w-40"
              value={dimension}
              placeholder="All dimensions"
              onChange={(e) => setDimension(e.target.value)}
              aria-label="Filter by dimension"
              options={DIMENSIONS.map((d) => ({ value: d, label: DIMENSION_LABEL[d] }))}
            />
            <Select
              className="w-52"
              value={state}
              placeholder="Any state"
              onChange={(e) => setState(e.target.value)}
              aria-label="Filter by state"
              options={[
                { value: 'running', label: 'Running' },
                { value: 'waiting', label: 'Waiting on your ontology' },
                { value: 'overridden', label: 'Overridden by your rules' },
                { value: 'drifted', label: 'Baseline has moved' },
              ]}
            />
          </div>

          {inherited.isError ? (
            <ErrorState title="Could not load the inherited rules" message={errorMessage(inherited.error)} />
          ) : inherited.isPending ? (
            <CardSkeletons />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Layers}
              title={(inherited.data ?? []).length === 0 ? 'No packs apply to this brand' : 'Nothing matches'}
              description={
                (inherited.data ?? []).length === 0
                  ? 'Every baseline pack has been turned off, so nothing is inherited. Turn one back on from the Packs tab.'
                  : 'Try a broader filter.'
              }
            />
          ) : (
            <div className="space-y-2">
              {filtered.map((rule) => (
                <InheritedRuleRow
                  key={rule.templateId}
                  rule={rule}
                  brandId={brandId}
                  canManage={canManage}
                  forking={fork.isPending && fork.variables?.templateId === rule.templateId}
                  onFork={() => void forkRule(rule)}
                />
              ))}
            </div>
          )}
        </TabPanel>
        )}
      </PageBody>

      <ConfirmDialog
        open={pendingOff !== null}
        onClose={() => setPendingOff(null)}
        onConfirm={confirmOff}
        title={`Turn off ${pendingOff?.name ?? ''}?`}
        description={
          `This pack is on for every brand by default. ${pendingOff?.activeTemplateCount ?? 0} rules stop being ` +
          'enforced the moment you publish the next ruleset.'
        }
        confirmLabel="Turn it off"
        destructive
        loading={setEnabled.isPending}
        confirmDisabled={reason.trim().length === 0}
      >
        <label className="block text-xs font-medium text-fg" htmlFor="disable-reason">
          Why?
        </label>
        <Textarea
          id="disable-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. duplicates our design-system linter — reviewed with the design team"
          className="mt-1"
        />
        <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
          Required, and recorded against your name. A pack switched off without an explanation is indistinguishable
          six months later from one nobody noticed.
        </p>
      </ConfirmDialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The headline. `running` is deliberately first and stated as a count rather
 * than a proportion: "24 of 34" invites reading 70% as a score, when the other
 * ten are not failures — they are rules with nothing to compare against yet.
 */
function SummaryLine({ summary, packCount }: { summary: Summary; packCount: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1">
        <ShieldCheck className="size-3 text-fg-subtle" aria-hidden="true" />
        <span className="num text-fg">{summary.running}</span> rules checking this brand from {packCount} packs
      </span>
      {summary.waiting > 0 ? (
        <span className="inline-flex items-center gap-1 text-advisory-fg">
          <Hourglass className="size-3" aria-hidden="true" />
          <span className="num">{summary.waiting}</span> waiting on {ontologyPhrase(summary.missing)}
        </span>
      ) : null}
      {summary.overridden > 0 ? (
        <span>
          <span className="num text-fg">{summary.overridden}</span> overridden by your own rules
        </span>
      ) : null}
      {summary.drifted > 0 ? (
        <span className="inline-flex items-center gap-1 text-major-fg">
          <AlertTriangle className="size-3" aria-hidden="true" />
          <span className="num">{summary.drifted}</span> drifted from the baseline
        </span>
      ) : null}
    </span>
  );
}

function groupByCategory(packs: RulePackSummary[]): Record<string, RulePackSummary[]> {
  const out: Record<string, RulePackSummary[]> = {};
  for (const pack of packs) (out[pack.category] ??= []).push(pack);
  return out;
}

function CardSkeletons() {
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  );
}
