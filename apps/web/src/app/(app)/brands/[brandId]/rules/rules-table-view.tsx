'use client';

import * as React from 'react';
import Link from 'next/link';
import { Archive, CheckCheck, ClipboardList, Rocket, X } from 'lucide-react';
import type { Rule } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { BrandNav } from '@/components/brand-nav';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Drawer, ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { SeverityBadge } from '@/components/severity-badge';
import { TierBadge } from '@/components/tier-badge';
import { RuleEditor } from '@/components/rule-editor';
import { useBrandQuery } from '@/hooks/use-brands';
import {
  useBulkRuleDecisionMutation,
  useRuleHistoryQuery,
  useRulesQuery,
  useUpdateRuleMutation,
  type BulkRuleAction,
} from '@/hooks/use-rules';
import { useSession } from '@/providers/session-provider';
import { hasRole } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import {
  DIMENSIONS,
  DIMENSION_LABEL,
  PROVENANCE_LABEL,
  RULE_STATUS_LABEL,
  TIERS,
  TIER_LABEL,
} from '@/lib/domain';
import { formatDateTime, formatMeasured, formatPercent } from '@/lib/format';

const STATUS_TONE: Record<string, 'ok' | 'accent' | 'advisory' | 'blocker'> = {
  active: 'ok',
  proposed: 'accent',
  deprecated: 'advisory',
  rejected: 'blocker',
};

export function RulesTableView({ brandId }: { brandId: string }) {
  const user = useSession();
  const { toast } = useToast();
  const { data: brand } = useBrandQuery(brandId);
  const canManage = hasRole(user.role, 'brand_manager');

  const [status, setStatus] = React.useState('');
  const [dimension, setDimension] = React.useState('');
  const [tier, setTier] = React.useState('');
  const [provenance, setProvenance] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [detail, setDetail] = React.useState<Rule | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<BulkRuleAction | null>(null);

  const filters = React.useMemo(
    () => ({ status: status || undefined, dimension: dimension || undefined, tier: tier || undefined, provenance: provenance || undefined }),
    [status, dimension, tier, provenance],
  );

  const { data, isPending, isError, error, refetch } = useRulesQuery(brandId, filters);
  const bulk = useBulkRuleDecisionMutation(brandId);
  const update = useUpdateRuleMutation(brandId);

  const rows = React.useMemo(() => {
    const list = data ?? [];
    if (!search) return list;
    const needle = search.toLowerCase();
    return list.filter((r) => r.statement.toLowerCase().includes(needle) || r.key.toLowerCase().includes(needle));
  }, [data, search]);

  const proposedCount = React.useMemo(() => (data ?? []).filter((r) => r.status === 'proposed').length, [data]);

  const runBulk = async (action: BulkRuleAction) => {
    const ruleIds = Array.from(selected);
    if (ruleIds.length === 0) return;
    try {
      await bulk.mutateAsync({ ruleIds, action });
      setSelected(new Set());
      toast({ title: `${ruleIds.length} rule(s) ${action}d`, tone: 'success' });
    } catch (mutationError) {
      toast({ title: 'Bulk action failed', description: errorMessage(mutationError), tone: 'error' });
    }
  };

  const columns: Array<Column<Rule>> = [
    {
      id: 'statement',
      header: 'Rule',
      sortValue: (r) => r.statement,
      cell: (r) => (
        <div className="min-w-0 max-w-xl">
          <p className="truncate text-fg">{r.statement}</p>
          <p className="num text-fg-subtle">
            {r.key}
            <span className="text-fg-subtle">@v{r.version}</span>
          </p>
        </div>
      ),
    },
    {
      id: 'dimension',
      header: 'Dimension',
      sortValue: (r) => r.dimension,
      cell: (r) => <span className="text-fg-muted">{DIMENSION_LABEL[r.dimension]}</span>,
    },
    { id: 'severity', header: 'Severity', sortValue: (r) => r.severity, cell: (r) => <SeverityBadge severity={r.severity} /> },
    { id: 'tier', header: 'Tier', sortValue: (r) => r.tier, cell: (r) => <TierBadge tier={r.tier} /> },
    {
      id: 'provenance',
      header: 'Provenance',
      sortValue: (r) => r.provenance,
      cell: (r) => <span className="text-[11px] text-fg-muted">{PROVENANCE_LABEL[r.provenance] ?? r.provenance}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{RULE_STATUS_LABEL[r.status] ?? r.status}</Badge>,
    },
    {
      id: 'override',
      header: 'Override rate',
      align: 'right',
      sortValue: (r) => r.calibration?.overrideRate ?? -1,
      cell: (r) => {
        const rate = r.calibration?.overrideRate;
        if (rate === undefined) return <span className="text-fg-subtle">—</span>;
        return (
          <span className={rate > 0.2 ? 'num font-semibold text-blocker-fg' : 'num text-fg-muted'}>
            {formatPercent(rate, 0)}
          </span>
        );
      },
    },
    {
      id: 'weight',
      header: 'Weight',
      align: 'right',
      sortValue: (r) => r.weight,
      cell: (r) => <span className="num text-fg-muted">{formatMeasured(r.weight)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Brands', href: '/brands' },
          { label: brand?.name ?? 'Brand', href: `/brands/${brandId}` },
          { label: 'Rules' },
        ]}
        title="Rules"
        description="Typed, versioned, scoped and cited. Editing an active rule creates a new version so past traces stay reproducible."
        actions={
          <>
            {proposedCount > 0 ? (
              <Link href={`/brands/${brandId}/rules/review`} className={buttonClasses('primary', 'sm')}>
                <ClipboardList className="size-3.5" aria-hidden="true" />
                Confirm {proposedCount} proposal{proposedCount === 1 ? '' : 's'}
              </Link>
            ) : null}
            <Link href={`/brands/${brandId}/rulesets`} className={buttonClasses('outline', 'sm')}>
              <Rocket className="size-3.5" aria-hidden="true" />
              Rulesets
            </Link>
          </>
        }
      />
      <BrandNav brandId={brandId} />

      <PageBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder="Filter by statement or key"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Filter rules"
          />
          <Select
            className="w-36"
            value={status}
            placeholder="All statuses"
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filter by status"
            options={Object.entries(RULE_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select
            className="w-40"
            value={dimension}
            placeholder="All dimensions"
            onChange={(event) => setDimension(event.target.value)}
            aria-label="Filter by dimension"
            options={DIMENSIONS.map((d) => ({ value: d, label: DIMENSION_LABEL[d] }))}
          />
          <Select
            className="w-40"
            value={tier}
            placeholder="All tiers"
            onChange={(event) => setTier(event.target.value)}
            aria-label="Filter by tier"
            options={TIERS.map((t) => ({ value: t, label: TIER_LABEL[t] }))}
          />
          <Select
            className="w-44"
            value={provenance}
            placeholder="All provenance"
            onChange={(event) => setProvenance(event.target.value)}
            aria-label="Filter by provenance"
            options={Object.entries(PROVENANCE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <span className="num text-fg-subtle">{rows.length} rule(s)</span>
        </div>

        {canManage && selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent-soft/40 px-3 py-2">
            <span className="text-xs font-medium text-fg">{selected.size} selected</span>
            <Button size="sm" variant="primary" onClick={() => setPendingAction('activate')}>
              <CheckCheck className="size-3.5" aria-hidden="true" />
              Activate
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPendingAction('deprecate')}>
              <Archive className="size-3.5" aria-hidden="true" />
              Deprecate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingAction('reject')}>
              <X className="size-3.5" aria-hidden="true" />
              Reject
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        ) : null}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          caption="Rules for this brand"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          selectable={canManage}
          selectedIds={selected}
          onSelectionChange={setSelected}
          onRowClick={(rule) => {
            setDetail(rule);
            setEditing(false);
          }}
          isRowActive={(rule) => rule.id === detail?.id}
          pageSize={40}
          dense
          empty={
            <EmptyState
              icon={ClipboardList}
              title="No rules match"
              description="Upload a brand book and extract, or induce rules by measuring your approved assets."
              actionLabel="Upload a document"
              actionHref={`/brands/${brandId}/documents`}
            />
          }
        />
      </PageBody>

      <RuleDrawer
        rule={detail}
        brandId={brandId}
        editing={editing}
        canManage={canManage}
        saving={update.isPending}
        onEdit={() => setEditing(true)}
        onClose={() => {
          setDetail(null);
          setEditing(false);
        }}
        onSave={async (values) => {
          if (!detail) return;
          try {
            await update.mutateAsync({
              ruleId: detail.id,
              body: {
                statement: values.statement,
                severity: values.severity,
                weight: values.weight,
                check: { fn: detail.check?.fn ?? '', params: values.params },
              },
            });
            setEditing(false);
            toast({ title: 'Rule updated', tone: 'success' });
          } catch (mutationError) {
            toast({ title: 'Update failed', description: errorMessage(mutationError), tone: 'error' });
          }
        }}
      />

      <ConfirmDialog
        open={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={async () => {
          const action = pendingAction;
          setPendingAction(null);
          if (action) await runBulk(action);
        }}
        title={`${pendingAction ? pendingAction[0].toUpperCase() + pendingAction.slice(1) : ''} ${selected.size} rule(s)?`}
        description="Recorded in the audit trail with your name."
        confirmLabel="Apply"
        destructive={pendingAction === 'reject'}
        loading={bulk.isPending}
      />
    </div>
  );
}

function RuleDrawer({
  rule,
  brandId,
  editing,
  canManage,
  saving,
  onEdit,
  onClose,
  onSave,
}: {
  rule: Rule | null;
  brandId: string;
  editing: boolean;
  canManage: boolean;
  saving: boolean;
  onEdit: () => void;
  onClose: () => void;
  onSave: (values: { statement: string; severity: string; weight: number; params: Record<string, unknown> }) => void | Promise<void>;
}) {
  const { data: history } = useRuleHistoryQuery(brandId, rule?.key);

  if (!rule) return null;

  return (
    <Drawer open onClose={onClose} title={rule.key} description={`Version ${rule.version} · ${RULE_STATUS_LABEL[rule.status]}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <SeverityBadge severity={rule.severity} />
          <TierBadge tier={rule.tier} withLabel />
          <Badge tone="outline">{DIMENSION_LABEL[rule.dimension]}</Badge>
          <Badge tone={STATUS_TONE[rule.status] ?? 'neutral'}>{RULE_STATUS_LABEL[rule.status]}</Badge>
        </div>

        {editing && canManage ? (
          <RuleEditor rule={rule} saving={saving} onCancel={onClose} onSave={onSave} />
        ) : (
          <>
            <div>
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Statement</h3>
              <p className="mt-1 text-[13px] leading-5 text-fg">{rule.statement}</p>
              {rule.rationale ? <p className="mt-1 text-xs leading-5 text-fg-muted">{rule.rationale}</p> : null}
            </div>

            <div>
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Check</h3>
              <p className="num mt-1 text-fg">{rule.check?.fn}</p>
              <pre className="mt-1 overflow-auto scroll-thin rounded-md bg-surface-2 p-2 font-mono text-[11px] text-fg">
                {JSON.stringify(rule.check?.params ?? {}, null, 2)}
              </pre>
            </div>

            {rule.rubric ? (
              <div>
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Rubric</h3>
                <pre className="mt-1 overflow-auto scroll-thin rounded-md bg-surface-2 p-2 font-mono text-[11px] text-fg">
                  {JSON.stringify(rule.rubric, null, 2)}
                </pre>
              </div>
            ) : null}

            {rule.calibration ? (
              <div>
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Calibration</h3>
                <dl className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
                  <Pair label="override rate" value={formatPercent(rule.calibration.overrideRate)} />
                  <Pair label="agreement" value={formatPercent(rule.calibration.agreementRate)} />
                  <Pair label="beta" value={formatMeasured(rule.calibration.beta)} />
                  <Pair label="samples" value={formatMeasured(rule.calibration.sampleSize)} />
                </dl>
                {rule.calibration.autoRouteToHuman ? (
                  <p className="mt-1.5 rounded-md bg-major-soft px-2 py-1.5 text-[11px] leading-4 text-major-fg">
                    beta below 0.3 — the judge does not track this tenant&apos;s humans on this rule, so it is auto-routed
                    to human review instead of being trusted.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div>
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Scope</h3>
              <pre className="mt-1 overflow-auto scroll-thin rounded-md bg-surface-2 p-2 font-mono text-[11px] text-fg">
                {JSON.stringify(rule.scope ?? {}, null, 2)}
              </pre>
              <p className="mt-1 text-[11px] text-fg-subtle">
                Specificity {rule.specificity} — resolution is most-specific-wins across the scope lattice.
              </p>
            </div>

            {history && history.length > 1 ? (
              <div>
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Version history</h3>
                <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                  {history.map((version) => (
                    <li key={version.id} className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                      <span className="num text-fg">v{version.version}</span>
                      <Badge tone={STATUS_TONE[version.status] ?? 'neutral'}>{RULE_STATUS_LABEL[version.status]}</Badge>
                      <span className="ml-auto num text-fg-subtle">{formatDateTime(version.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {canManage ? (
              <Button variant="primary" size="sm" onClick={onEdit}>
                Edit rule
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  );
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="num text-fg">{value}</dd>
    </div>
  );
}
