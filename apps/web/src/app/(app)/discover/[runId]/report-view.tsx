'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Info, Type } from 'lucide-react';
import type { DiscoveryReport } from '@brandlens/contracts';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { buttonClasses } from '@/components/ui/button-variants';
import { DiscoveryProgress } from '@/components/discovery-progress';
import { useDiscoveryPagesQuery, useDiscoveryRunQuery } from '@/hooks/use-discovery';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

const SEVERITY_TONE: Record<string, 'blocker' | 'major' | 'minor' | 'advisory' | 'neutral'> = {
  blocker: 'blocker',
  major: 'major',
  minor: 'minor',
  advisory: 'advisory',
};

export function DiscoveryReportView({ runId }: { runId: string }) {
  const { data: run, isPending, isError, error, refetch } = useDiscoveryRunQuery(runId);
  const isFinished = run?.status === 'completed' || run?.status === 'partial';
  const { data: pages } = useDiscoveryPagesQuery(runId, isFinished);

  if (isPending) {
    return (
      <PageBody>
        <Skeleton className="h-40 w-full" />
      </PageBody>
    );
  }
  if (isError || !run) {
    return (
      <PageBody>
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      </PageBody>
    );
  }

  const report = run.report as DiscoveryReport | null;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Discover', href: '/discover' }, { label: hostOf(run.originUrl) }]}
        title={report?.brandName ?? hostOf(run.originUrl)}
        description={report?.tagline ?? run.originUrl}
        actions={
          <div className="flex items-center gap-2">
            <a
              href={run.originUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonClasses('outline', 'sm')}
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              Visit site
            </a>
            {run.brandId ? (
              <Link href={`/brands/${run.brandId}/rules/review`} className={buttonClasses('primary', 'sm')}>
                Review {run.rulesProposed} proposed rules
              </Link>
            ) : null}
          </div>
        }
      />

      <PageBody>
        {!isFinished ? <DiscoveryProgress runId={runId} /> : null}

        {report ? (
          <>
            <SummaryRow report={report} />
            <IdentitySection report={report} />
            <VoiceSection report={report} />
            <LegalSection report={report} />
            <SelfCheckSection report={report} />
            <PagesSection pages={pages ?? []} />
            <ProvenanceFooter run={run} report={report} />
          </>
        ) : isFinished ? (
          <EmptyState title="No report" description="This run finished without producing a report." />
        ) : null}
      </PageBody>
    </>
  );
}

/* ------------------------------------------------------------------ summary */

function SummaryRow({ report }: { report: DiscoveryReport }) {
  const stats = [
    { label: 'Pages harvested', value: String(report.coverage.pagesHarvested) },
    { label: 'Colours found', value: String(report.identity.colors.length) },
    { label: 'Type styles', value: String(report.identity.typeStyles.length) },
    { label: 'Rules proposed', value: String(report.ruleset.proposed) },
    { label: 'Voice axes', value: String(report.voice.axes.length) },
    { label: 'Claims to review', value: String(report.legal.claims.filter((c) => c.needsSubstantiation).length) },
    {
      label: 'Self-consistency',
      value: typeof report.selfCheck.consistencyScore === 'number' ? report.selfCheck.consistencyScore.toFixed(1) : '—',
    },
    { label: 'Findings', value: report.selfCheck.ran ? String(report.selfCheck.findingsTotal) : '—' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {stats.map((s) => (
        <Card key={s.label}>
          <CardContent className="p-3">
            <p className="text-[11px] text-fg-subtle">{s.label}</p>
            <p className="num mt-0.5 text-lg font-semibold text-fg">{s.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- identity */

function IdentitySection({ report }: { report: DiscoveryReport }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Palette</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {report.identity.colors.length === 0 ? (
            <p className="text-xs text-fg-subtle">No colours could be measured.</p>
          ) : (
            report.identity.colors.map((color) => (
              <div key={color.hex} className="flex items-center gap-2.5">
                <span
                  className="size-8 shrink-0 rounded border border-border"
                  style={{ backgroundColor: color.hex }}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="num text-xs font-medium text-fg">{color.hex}</span>
                    <Badge tone="outline">{color.role}</Badge>
                  </div>
                  <p className="num text-[11px] text-fg-subtle">
                    L* {color.lab[0].toFixed(1)} a* {color.lab[1].toFixed(1)} b* {color.lab[2].toFixed(1)} ·{' '}
                    {(color.coverage * 100).toFixed(1)}% of painted area · {color.pageCount} page
                    {color.pageCount === 1 ? '' : 's'}
                  </p>
                </div>
              </div>
            ))
          )}
          <p className="flex items-start gap-1.5 pt-1 text-[11px] leading-4 text-fg-subtle">
            <Info className="mt-px size-3 shrink-0" aria-hidden="true" />
            Weighted by painted area, not by how often the colour is declared in CSS. Lab coordinates are what ΔE
            conformance is measured in.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Type styles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {report.identity.typeStyles.length === 0 ? (
            <p className="text-xs text-fg-subtle">No type styles could be measured.</p>
          ) : (
            report.identity.typeStyles.map((style) => (
              <div key={style.name} className="flex items-baseline gap-2.5 border-b border-border pb-2 last:border-0">
                <Type className="size-3 shrink-0 text-fg-subtle" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-fg"
                    style={{
                      fontFamily: `${JSON.stringify(style.fontFamily)}, system-ui, sans-serif`,
                      fontSize: `${Math.min(style.fontSizePx, 22)}px`,
                      fontWeight: style.fontWeight ?? 400,
                    }}
                  >
                    {style.fontFamily}
                  </p>
                  <p className="num text-[11px] text-fg-subtle">
                    {style.role} · {style.fontSizePx}px / {style.fontWeight ?? 400}
                    {style.lineHeightPx ? ` · line-height ${style.lineHeightPx}px` : ''} · {style.occurrences} uses
                  </p>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------- voice */

function VoiceSection({ report }: { report: DiscoveryReport }) {
  const { axes, lexicon, readability, readabilityDegraded } = report.voice;
  if (axes.length === 0 && lexicon.length === 0 && Object.keys(readability).length === 0) return null;

  const grade = numberOf(readability, 'fleschKincaidGrade');
  const ease = numberOf(readability, 'fleschReadingEase');

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Voice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {axes.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              No voice axis survived verification — every supporting quotation had to appear verbatim in the
              brand&apos;s own copy, and none did.
            </p>
          ) : (
            axes.map((axis) => (
              <div key={axis.name}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-fg">{axis.name}</span>
                  <span className="num text-[11px] text-fg-subtle">{Math.round(axis.value * 100)}%</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="w-20 shrink-0 truncate text-right text-[11px] text-fg-subtle">{axis.lowLabel}</span>
                  <span className="relative h-1.5 flex-1 rounded-full bg-surface-2">
                    <span
                      className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                      style={{ left: `${Math.max(0, Math.min(100, axis.value * 100))}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 truncate text-[11px] text-fg-subtle">{axis.highLabel}</span>
                </div>
                {axis.rationale ? <p className="mt-1 text-[11px] leading-4 text-fg-muted">{axis.rationale}</p> : null}
                {axis.evidence.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {axis.evidence.slice(0, 2).map((quote) => (
                      <li key={quote} className="border-l-2 border-border pl-2 text-[11px] italic leading-4 text-fg-subtle">
                        “{quote}”
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))
          )}

          {grade !== null ? (
            <p className="flex items-start gap-1.5 border-t border-border pt-2 text-[11px] leading-4 text-fg-subtle">
              <Info className="mt-px size-3 shrink-0" aria-hidden="true" />
              Reads at US grade <span className="num">{grade.toFixed(1)}</span>
              {ease !== null ? <> · Flesch ease <span className="num">{ease.toFixed(0)}</span></> : null}
              {readabilityDegraded ? ' · measured with the fallback formula, treat as approximate' : ''}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lexicon</CardTitle>
        </CardHeader>
        <CardContent>
          {lexicon.length === 0 ? (
            <p className="text-xs text-fg-subtle">No distinctive vocabulary was identified.</p>
          ) : (
            <ul className="space-y-1.5">
              {lexicon.map((term) => (
                <li key={term.term} className="flex items-start gap-2">
                  <Badge tone={term.kind === 'banned' || term.kind === 'avoid' ? 'major' : 'outline'}>
                    {term.kind}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-medium text-fg">{term.term}</span>
                    <span className="num ml-1.5 text-[11px] text-fg-subtle">
                      {term.uses} use{term.uses === 1 ? '' : 's'} · {term.pageCount} page
                      {term.pageCount === 1 ? '' : 's'}
                    </span>
                    {term.note ? <p className="text-[11px] leading-4 text-fg-muted">{term.note}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------- legal */

function LegalSection({ report }: { report: DiscoveryReport }) {
  const { claims, disclaimers } = report.legal;
  if (claims.length === 0 && disclaimers.length === 0) return null;

  const needing = claims.filter((c) => c.needsSubstantiation);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Claims and disclaimers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-fg-muted">
          {needing.length} claim{needing.length === 1 ? '' : 's'} on this site would need substantiating. They have
          been added to the brand&apos;s register as <strong className="font-medium text-fg">unapproved</strong>, so a
          reviewer triages them rather than inheriting a compliance record nobody signed.
        </p>

        {needing.length > 0 ? (
          <ul className="space-y-1.5">
            {needing.slice(0, 12).map((claim) => (
              <li key={claim.text} className="rounded-md border border-border p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="major">{claim.claimType}</Badge>
                  {claim.judged ? null : <Badge tone="outline">unjudged</Badge>}
                  <span className="num text-[11px] text-fg-subtle">{shortPath(claim.url)}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-fg">“{claim.text}”</p>
                {claim.suggestedEvidence ? (
                  <p className="mt-0.5 text-[11px] leading-4 text-fg-muted">
                    Evidence needed: {claim.suggestedEvidence}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {disclaimers.length > 0 ? (
          <div className="border-t border-border pt-2">
            <p className="mb-1 text-[11px] font-medium text-fg">Disclaimers found</p>
            <ul className="space-y-1">
              {disclaimers.slice(0, 8).map((d) => (
                <li key={d.text} className="text-[11px] leading-4 text-fg-muted">
                  “{d.text}”
                  {d.triggerCondition ? (
                    <span className="text-fg-subtle"> — required when: {d.triggerCondition}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- self-check */

function SelfCheckSection({ report }: { report: DiscoveryReport }) {
  if (!report.selfCheck.ran) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Self-consistency</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-fg-subtle">
            The self-check was skipped for this run. Re-run with it enabled to see where the site breaks the rules it
            established.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where the site breaks its own rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-fg-muted">
          Each of the {report.selfCheck.pagesChecked} harvested pages was graded against the ruleset just inferred from
          them. {report.selfCheck.findingsTotal} finding{report.selfCheck.findingsTotal === 1 ? '' : 's'},{' '}
          {report.selfCheck.blockersTotal} blocker{report.selfCheck.blockersTotal === 1 ? '' : 's'}.
        </p>

        {report.selfCheck.topViolations.length === 0 ? (
          <p className="text-xs text-fg-subtle">No violations — the site is consistent with the rules inferred from it.</p>
        ) : (
          <ul className="space-y-2">
            {report.selfCheck.topViolations.map((v) => (
              <li key={v.ruleKey} className="rounded-md border border-border p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={SEVERITY_TONE[v.severity] ?? 'neutral'}>{v.severity}</Badge>
                  <Badge tone="outline">{v.dimension}</Badge>
                  <span className="text-xs font-medium text-fg">{v.title}</span>
                  <span className="ml-auto num text-[11px] text-fg-subtle">
                    {v.pageCount} page{v.pageCount === 1 ? '' : 's'}
                  </span>
                </div>
                {v.example ? (
                  <p className="mt-1 text-[11px] leading-4 text-fg-muted">
                    <span className="num">{shortPath(v.example.url)}</span> — {v.example.detail}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------------- pages */

function PagesSection({ pages }: { pages: Array<{ id: string; url: string; role: string; title?: string | null; previewUrl?: string | null; viewport: string }> }) {
  const desktop = pages.filter((p) => p.viewport === 'desktop');
  if (desktop.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pages harvested</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {desktop.map((page) => (
            <li key={page.id} className="min-w-0">
              <span className="block aspect-[4/3] overflow-hidden rounded border border-border bg-surface-2">
                {page.previewUrl ? (
                  <img src={page.previewUrl} alt="" className="size-full object-cover object-top" />
                ) : null}
              </span>
              <p className="mt-1 truncate text-[11px] font-medium text-fg">{page.title ?? shortPath(page.url)}</p>
              <p className="num truncate text-[11px] text-fg-subtle">
                {page.role} · {shortPath(page.url)}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- provenance */

/**
 * The part that makes the report defensible rather than merely impressive:
 * what it did not see, and what it is not claiming.
 */
function ProvenanceFooter({
  run,
  report,
}: {
  run: NonNullable<ReturnType<typeof useDiscoveryRunQuery>['data']>;
  report: DiscoveryReport;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>How this was produced</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-[11px] leading-5 text-fg-muted">
        <p>
          Crawled <span className="num">{run.originUrl}</span> on {formatDateTime(run.createdAt)}, honouring
          robots.txt, at most {run.options.maxPages} pages and depth {run.options.maxDepth}. Colour and type were
          measured from the browser&apos;s computed styles — exact values, not inferred from pixels.
        </p>
        <p>
          All {report.ruleset.proposed} rules are <strong className="font-medium text-fg">proposed</strong>. None is
          active. Ruleset hash <span className="num">{report.ruleset.hash?.slice(0, 12) ?? '—'}</span>.
        </p>
        {report.coverage.skipped.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-fg">
              {report.coverage.skipped.length} page{report.coverage.skipped.length === 1 ? '' : 's'} found but not
              crawled
            </summary>
            <ul className="mt-1 space-y-0.5">
              {report.coverage.skipped.slice(0, 20).map((s) => (
                <li key={s.url} className="num truncate text-fg-subtle">
                  {shortPath(s.url)} — {s.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {report.coverage.pagesFailed > 0 ? (
          <p>
            {report.coverage.pagesFailed} page{report.coverage.pagesFailed === 1 ? '' : 's'} failed to render and are
            not represented in any measurement above.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function numberOf(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function shortPath(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}
