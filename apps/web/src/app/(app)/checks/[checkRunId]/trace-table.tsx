'use client';

import * as React from 'react';
import { Braces, Check, Copy, Download, Table2 } from 'lucide-react';
import type { DecisionTraceDTO } from '@brandlens/contracts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/data-table';
import { TierBadge } from '@/components/tier-badge';
import { useToast } from '@/components/ui/toast';
import { dimensionLabel, TIERS, VERDICT_LABEL } from '@/lib/domain';
import { formatDuration, formatPercent, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

const VERDICT_TONE: Record<string, 'ok' | 'blocker' | 'neutral' | 'advisory'> = {
  pass: 'ok',
  fail: 'blocker',
  not_applicable: 'advisory',
  insufficient_evidence: 'neutral',
  abstained: 'neutral',
};

/**
 * The raw immutable decision traces.
 *
 * This is the audit view: nothing here is derived or prettified beyond
 * formatting. It is the artefact a compliance team hands to a regulator, so it
 * must also leave as JSON without any transformation.
 */
export function TraceTable({ traces, runId }: { traces: DecisionTraceDTO[]; runId: string }) {
  const { toast } = useToast();
  const [view, setView] = React.useState<'table' | 'json'>('table');
  const [search, setSearch] = React.useState('');
  const [tier, setTier] = React.useState('');
  const [verdict, setVerdict] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  const filtered = React.useMemo(
    () =>
      traces.filter((trace) => {
        if (tier && trace.tier !== tier) return false;
        if (verdict && trace.verdict !== verdict) return false;
        if (search) {
          const needle = search.toLowerCase();
          if (!trace.ruleKey.toLowerCase().includes(needle) && !trace.traceKey.toLowerCase().includes(needle)) {
            return false;
          }
        }
        return true;
      }),
    [traces, tier, verdict, search],
  );

  const json = React.useMemo(() => JSON.stringify(filtered, null, 2), [filtered]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      toast({ title: 'Traces copied as JSON', description: `${filtered.length} trace(s) on the clipboard.`, tone: 'success' });
    } catch {
      toast({ title: 'Copy failed', description: 'The clipboard is unavailable in this context.', tone: 'error' });
    }
  };

  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `brandlens-traces-${runId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const columns: Array<Column<DecisionTraceDTO>> = [
    {
      id: 'traceKey',
      header: 'Trace key',
      width: '11rem',
      sortValue: (t) => t.traceKey,
      cell: (t) => (
        <span className="num text-fg-muted" title={t.traceKey}>
          {t.traceKey.slice(0, 16)}…
        </span>
      ),
    },
    {
      id: 'rule',
      header: 'Rule @ version',
      sortValue: (t) => t.ruleKey,
      cell: (t) => (
        <span className="num text-fg">
          {t.ruleKey}
          <span className="text-fg-subtle">@v{t.ruleVersion}</span>
        </span>
      ),
    },
    {
      id: 'dimension',
      header: 'Dimension',
      sortValue: (t) => t.dimension,
      cell: (t) => <span className="text-fg-muted">{dimensionLabel(t.dimension)}</span>,
    },
    { id: 'tier', header: 'Tier', sortValue: (t) => t.tier, cell: (t) => <TierBadge tier={t.tier} /> },
    {
      id: 'verdict',
      header: 'Verdict',
      sortValue: (t) => t.verdict,
      cell: (t) => <Badge tone={VERDICT_TONE[t.verdict] ?? 'neutral'}>{VERDICT_LABEL[t.verdict] ?? t.verdict}</Badge>,
    },
    {
      id: 'confidence',
      header: 'Confidence',
      align: 'right',
      sortValue: (t) => t.confidence ?? -1,
      cell: (t) => <span className="num">{t.confidence === null ? '—' : formatPercent(t.confidence, 0)}</span>,
    },
    {
      id: 'cached',
      header: 'Cached',
      align: 'center',
      sortValue: (t) => (t.cached ? 1 : 0),
      cell: (t) =>
        t.cached ? <Check className="mx-auto size-3.5 text-[var(--ok)]" aria-label="cached" /> : <span className="text-fg-subtle">—</span>,
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortValue: (t) => t.costUsd,
      cell: (t) => <span className="num">{formatUsd(t.costUsd)}</span>,
    },
    {
      id: 'latency',
      header: 'Latency',
      align: 'right',
      sortValue: (t) => t.latencyMs ?? -1,
      cell: (t) => <span className="num text-fg-muted">{formatDuration(t.latencyMs)}</span>,
    },
  ];

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <Button
            size="sm"
            variant={view === 'table' ? 'subtle' : 'ghost'}
            onClick={() => setView('table')}
            aria-pressed={view === 'table'}
          >
            <Table2 className="size-3.5" aria-hidden="true" />
            Table
          </Button>
          <Button
            size="sm"
            variant={view === 'json' ? 'subtle' : 'ghost'}
            onClick={() => setView('json')}
            aria-pressed={view === 'json'}
          >
            <Braces className="size-3.5" aria-hidden="true" />
            JSON
          </Button>
        </div>

        <Input
          className="h-7 w-44"
          placeholder="Filter by rule or trace key"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Filter traces"
        />
        <Select
          className="h-7 w-36"
          value={tier}
          placeholder="All tiers"
          onChange={(event) => setTier(event.target.value)}
          aria-label="Filter by tier"
          options={TIERS.map((t) => ({ value: t, label: t }))}
        />
        <Select
          className="h-7 w-44"
          value={verdict}
          placeholder="All verdicts"
          onChange={(event) => setVerdict(event.target.value)}
          aria-label="Filter by verdict"
          options={Object.entries(VERDICT_LABEL).map(([value, label]) => ({ value, label }))}
        />

        <div className="ml-auto flex items-center gap-1.5">
          <span className="num text-fg-subtle">
            {filtered.length}/{traces.length}
          </span>
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            Copy as JSON
          </Button>
          <Button size="sm" variant="outline" onClick={download}>
            <Download className="size-3.5" aria-hidden="true" />
            Export
          </Button>
        </div>
      </div>

      {view === 'table' ? (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(t) => t.id}
          caption="Immutable decision traces for this check run"
          dense
          pageSize={25}
        />
      ) : (
        <pre
          className={cn(
            'max-h-[60vh] overflow-auto scroll-thin rounded-lg border border-border bg-surface-2 p-3',
            'font-mono text-[11px] leading-4 text-fg',
          )}
        >
          {json}
        </pre>
      )}
    </div>
  );
}
