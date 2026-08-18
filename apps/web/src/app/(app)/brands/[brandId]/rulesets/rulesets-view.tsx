'use client';

import * as React from 'react';
import { ArrowRight, GitCompareArrows, Minus, Plus, Rocket } from 'lucide-react';
import type { Ruleset } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { BrandNav } from '@/components/brand-nav';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { SeverityBadge } from '@/components/severity-badge';
import { useBrandQuery } from '@/hooks/use-brands';
import { usePublishRulesetMutation, useRulesetQuery, useRulesetsQuery } from '@/hooks/use-rulesets';
import { useSession } from '@/providers/session-provider';
import { hasRole } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, shortHash } from '@/lib/format';
import type { Severity } from '@brandlens/contracts';
import { cn } from '@/lib/utils';

interface CompiledRule {
  key: string;
  version: number;
  statement: string;
  severity: Severity;
  dimension: string;
  tier: string;
  weight?: number;
}

export function RulesetsView({ brandId }: { brandId: string }) {
  const user = useSession();
  const { toast } = useToast();
  const { data: brand } = useBrandQuery(brandId);
  const { data, isPending, isError, error, refetch } = useRulesetsQuery(brandId);
  const publish = usePublishRulesetMutation(brandId);
  const canManage = hasRole(user.role, 'brand_manager');

  const [leftId, setLeftId] = React.useState('');
  const [rightId, setRightId] = React.useState('');

  React.useEffect(() => {
    if (!data || data.length < 2) return;
    setRightId((current) => current || data[0].id);
    setLeftId((current) => current || data[1].id);
  }, [data]);

  const columns: Array<Column<Ruleset>> = [
    {
      id: 'version',
      header: 'Version',
      sortValue: (r) => r.version,
      cell: (r) => (
        <span className="num font-semibold text-fg">
          v{r.version}
          {r.id === brand?.activeRulesetId ? (
            <Badge tone="ok" className="ml-2">
              Active
            </Badge>
          ) : null}
        </span>
      ),
    },
    { id: 'label', header: 'Label', cell: (r) => <span className="text-fg-muted">{r.label ?? '—'}</span> },
    {
      id: 'hash',
      header: 'Hash',
      cell: (r) => (
        <span className="num text-fg-muted" title={r.hash}>
          {shortHash(r.hash, 16)}
        </span>
      ),
    },
    {
      id: 'ruleCount',
      header: 'Rules',
      align: 'right',
      sortValue: (r) => r.ruleCount,
      cell: (r) => <span className="num text-fg">{r.ruleCount}</span>,
    },
    {
      id: 'publishedAt',
      header: 'Published',
      align: 'right',
      sortValue: (r) => r.publishedAt,
      cell: (r) => <span className="num text-fg-muted">{formatDateTime(r.publishedAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Brands', href: '/brands' },
          { label: brand?.name ?? 'Brand', href: `/brands/${brandId}` },
          { label: 'Rulesets' },
        ]}
        title="Rulesets"
        description="Brand compile: every active rule frozen into a hashed snapshot. The hash is the cache key, the audit anchor and the reproducibility guarantee."
        actions={
          canManage ? (
            <Button
              variant="primary"
              size="sm"
              loading={publish.isPending}
              onClick={() =>
                publish.mutate(
                  {},
                  {
                    onSuccess: (ruleset) =>
                      toast({
                        title: `Ruleset v${ruleset.version} published`,
                        description: `${ruleset.ruleCount} rules · ${shortHash(ruleset.hash)}`,
                        tone: 'success',
                      }),
                    onError: (mutationError) =>
                      toast({ title: 'Compile failed', description: errorMessage(mutationError), tone: 'error' }),
                  },
                )
              }
            >
              <Rocket className="size-3.5" aria-hidden="true" />
              Compile new version
            </Button>
          ) : null
        }
      />
      <BrandNav brandId={brandId} />

      <PageBody className="space-y-4">
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(r) => r.id}
          caption="Published rulesets"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          pageSize={20}
          initialSort={{ columnId: 'version', direction: 'desc' }}
          empty={
            <EmptyState
              icon={Rocket}
              title="No ruleset published"
              description="Confirm proposed rules, then compile to freeze them. Checks cannot run without an active ruleset."
              actionLabel="Confirm rules"
              actionHref={`/brands/${brandId}/rules/review`}
            />
          }
        />

        {data && data.length >= 2 ? (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Compare versions</CardTitle>
                <p className="mt-0.5 text-xs text-fg-muted">
                  What changed between two frozen snapshots, keyed on rule key and version.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Select
                  className="w-32"
                  value={leftId}
                  onChange={(event) => setLeftId(event.target.value)}
                  aria-label="Base version"
                  options={data.map((r) => ({ value: r.id, label: `v${r.version}` }))}
                />
                <ArrowRight className="size-3.5 text-fg-subtle" aria-hidden="true" />
                <Select
                  className="w-32"
                  value={rightId}
                  onChange={(event) => setRightId(event.target.value)}
                  aria-label="Compare version"
                  options={data.map((r) => ({ value: r.id, label: `v${r.version}` }))}
                />
              </div>
            </CardHeader>
            <CardContent>
              <RulesetDiff brandId={brandId} leftId={leftId} rightId={rightId} />
            </CardContent>
          </Card>
        ) : null}
      </PageBody>
    </div>
  );
}

function RulesetDiff({ brandId, leftId, rightId }: { brandId: string; leftId: string; rightId: string }) {
  const left = useRulesetQuery(brandId, leftId || undefined);
  const right = useRulesetQuery(brandId, rightId || undefined);

  if (left.isPending || right.isPending) return <Skeleton className="h-40 w-full" />;
  if (left.isError || right.isError) {
    return <p className="text-xs text-blocker-fg">{errorMessage(left.error ?? right.error)}</p>;
  }
  if (!left.data || !right.data) return null;

  const before = extractRules(left.data);
  const after = extractRules(right.data);
  const beforeMap = new Map(before.map((r) => [r.key, r]));
  const afterMap = new Map(after.map((r) => [r.key, r]));

  const added = after.filter((r) => !beforeMap.has(r.key));
  const removed = before.filter((r) => !afterMap.has(r.key));
  const changed = after.filter((r) => {
    const previous = beforeMap.get(r.key);
    return previous && (previous.version !== r.version || previous.severity !== r.severity || previous.statement !== r.statement);
  });

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-fg-muted">
        <GitCompareArrows className="size-3.5" aria-hidden="true" />
        These two versions resolve to the same set of rules. Different hashes with identical rules mean the scoring config
        changed.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        <span className="num font-semibold text-[var(--ok-fg)]">+{added.length}</span> added ·{' '}
        <span className="num font-semibold text-blocker-fg">−{removed.length}</span> removed ·{' '}
        <span className="num font-semibold text-[var(--sev-major-fg)]">~{changed.length}</span> changed
      </p>

      <DiffGroup title="Added" tone="add" rules={added} />
      <DiffGroup title="Removed" tone="remove" rules={removed} />
      <DiffGroup
        title="Changed"
        tone="change"
        rules={changed}
        detail={(rule) => {
          const previous = beforeMap.get(rule.key);
          if (!previous) return null;
          return (
            <span className="num text-[11px] text-fg-subtle">
              v{previous.version} → v{rule.version}
              {previous.severity !== rule.severity ? ` · ${previous.severity} → ${rule.severity}` : ''}
            </span>
          );
        }}
      />
    </div>
  );
}

function DiffGroup({
  title,
  tone,
  rules,
  detail,
}: {
  title: string;
  tone: 'add' | 'remove' | 'change';
  rules: CompiledRule[];
  detail?: (rule: CompiledRule) => React.ReactNode;
}) {
  if (rules.length === 0) return null;
  const Icon = tone === 'add' ? Plus : tone === 'remove' ? Minus : GitCompareArrows;
  const color =
    tone === 'add'
      ? 'border-l-[var(--ok)] bg-[var(--ok-soft)]'
      : tone === 'remove'
        ? 'border-l-blocker bg-blocker-soft'
        : 'border-l-major bg-major-soft';

  return (
    <section>
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
        {title} ({rules.length})
      </h4>
      <ul className="space-y-1">
        {rules.map((rule) => (
          <li key={rule.key} className={cn('flex items-start gap-2 rounded border-l-2 px-2 py-1.5', color)}>
            <Icon className="mt-0.5 size-3 shrink-0 text-fg-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-fg">{rule.statement}</p>
              <p className="num text-[11px] text-fg-subtle">
                {rule.key}@v{rule.version}
              </p>
              {detail?.(rule)}
            </div>
            <SeverityBadge severity={rule.severity} showDot={false} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The compiled snapshot shape is intentionally loose; read defensively. */
function extractRules(ruleset: Ruleset): CompiledRule[] {
  const compiled = ruleset.compiled as Record<string, unknown> | undefined;
  const candidates = [compiled?.rules, compiled?.compiledRules, compiled?.items, compiled];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => ({
          key: String(entry.key ?? entry.ruleKey ?? ''),
          version: Number(entry.version ?? entry.ruleVersion ?? 1),
          statement: String(entry.statement ?? entry.key ?? 'Untitled rule'),
          severity: (entry.severity as Severity) ?? 'major',
          dimension: String(entry.dimension ?? 'unknown'),
          tier: String(entry.tier ?? 'deterministic'),
          weight: typeof entry.weight === 'number' ? entry.weight : undefined,
        }))
        .filter((rule) => rule.key.length > 0);
    }
  }
  return [];
}
