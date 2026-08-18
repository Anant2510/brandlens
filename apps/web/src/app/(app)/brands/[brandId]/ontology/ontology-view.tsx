'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ImageOff, Palette } from 'lucide-react';
import type { Claim, Disclaimer, LexiconTerm, LogoVariant, TypeStyle, VoiceAttribute } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { BrandNav } from '@/components/brand-nav';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { SkeletonCards, SkeletonTable } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/data-table';
import { TokenSwatch } from '@/components/token-swatch';
import { ContrastMeter } from '@/components/contrast-meter';
import { SeverityBadge } from '@/components/severity-badge';
import { useBrandQuery } from '@/hooks/use-brands';
import {
  useClaimsQuery,
  useDisclaimersQuery,
  useLexiconQuery,
  useLogosQuery,
  useTokensQuery,
  useTypeStylesQuery,
  useVoiceQuery,
} from '@/hooks/use-ontology';
import { errorMessage } from '@/lib/api-client';
import { formatDate, formatMeasured } from '@/lib/format';

const TABS = ['tokens', 'logos', 'typography', 'voice', 'lexicon', 'claims', 'disclaimers'] as const;
type TabValue = (typeof TABS)[number];

function isTab(value: string | null): value is TabValue {
  return TABS.includes((value ?? '') as TabValue);
}

export function OntologyView({ brandId }: { brandId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const initial = isTab(params.get('tab')) ? (params.get('tab') as TabValue) : 'tokens';
  const [tab, setTab] = React.useState<TabValue>(initial);
  const { data: brand } = useBrandQuery(brandId);

  const tokens = useTokensQuery(brandId, tab === 'tokens');
  const logos = useLogosQuery(brandId, tab === 'logos');
  const typeStyles = useTypeStylesQuery(brandId, tab === 'typography');
  const voice = useVoiceQuery(brandId, tab === 'voice');
  const lexicon = useLexiconQuery(brandId, tab === 'lexicon');
  const claims = useClaimsQuery(brandId, tab === 'claims');
  const disclaimers = useDisclaimersQuery(brandId, tab === 'disclaimers');

  const select = (value: string) => {
    const next = isTab(value) ? value : 'tokens';
    setTab(next);
    router.replace(`/brands/${brandId}/ontology?tab=${next}`, { scroll: false });
  };

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Brands', href: '/brands' },
          { label: brand?.name ?? 'Brand', href: `/brands/${brandId}` },
          { label: 'Ontology' },
        ]}
        title="Brand ontology"
        description="The machine-readable brand: tokens, logos, type, voice, lexicon, claims and disclaimers. Rules measure against these."
      />
      <BrandNav brandId={brandId} />

      <div className="px-4 pt-3">
        <Tabs
          value={tab}
          onValueChange={select}
          panelId="ontology-panel"
          items={[
            { value: 'tokens', label: 'Tokens', count: tokens.data?.length },
            { value: 'logos', label: 'Logos', count: logos.data?.length },
            { value: 'typography', label: 'Typography', count: typeStyles.data?.length },
            { value: 'voice', label: 'Voice', count: voice.data?.length },
            { value: 'lexicon', label: 'Lexicon', count: lexicon.data?.length },
            { value: 'claims', label: 'Claims', count: claims.data?.length },
            { value: 'disclaimers', label: 'Disclaimers', count: disclaimers.data?.length },
          ]}
        />
      </div>

      <TabPanel id="ontology-panel" value={tab}>
        <PageBody>
          {tab === 'tokens' ? <TokensTab query={tokens} /> : null}
          {tab === 'logos' ? <LogosTab query={logos} /> : null}
          {tab === 'typography' ? <TypographyTab query={typeStyles} /> : null}
          {tab === 'voice' ? <VoiceTab query={voice} /> : null}
          {tab === 'lexicon' ? <LexiconTab query={lexicon} /> : null}
          {tab === 'claims' ? <ClaimsTab query={claims} /> : null}
          {tab === 'disclaimers' ? <DisclaimersTab query={disclaimers} /> : null}
        </PageBody>
      </TabPanel>
    </div>
  );
}

interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

function Guard<T>({
  query,
  children,
  loading,
  empty,
}: {
  query: QueryLike<T[]>;
  children: (rows: T[]) => React.ReactNode;
  loading?: React.ReactNode;
  empty: React.ReactNode;
}) {
  if (query.isPending) return <>{loading ?? <SkeletonCards count={6} className="sm:grid-cols-2 lg:grid-cols-3" />}</>;
  if (query.isError) {
    return <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />;
  }
  if (!query.data || query.data.length === 0) return <>{empty}</>;
  return <>{children(query.data)}</>;
}

/* ---------------------------------------------------------------- tokens */
function TokensTab({ query }: { query: QueryLike<import('@/lib/types').DesignToken[]> }) {
  const [search, setSearch] = React.useState('');

  return (
    <Guard
      query={query}
      empty={
        <EmptyState
          icon={Palette}
          title="No design tokens"
          description="Import tokens from DTCG, Style Dictionary, Figma Variables or a Tailwind config through POST /v1/brands/:id/tokens/import."
        />
      }
    >
      {(tokens) => {
        const filtered = tokens.filter((t) => t.path.toLowerCase().includes(search.toLowerCase()));
        const colors = filtered.filter((t) => t.type === 'color' && t.hex);
        const primary = colors[0];
        const background = colors.find((t) => t.role?.toLowerCase().includes('background')) ?? colors[1];

        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="w-56"
                placeholder="Filter by path"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Filter tokens"
              />
              <span className="num text-fg-subtle">
                {filtered.length}/{tokens.length}
              </span>
            </div>

            {primary && background ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <ContrastMeter
                  foreground={primary.hex ?? '#000000'}
                  background={background.hex ?? '#ffffff'}
                  label={`${primary.path} on ${background.path}`}
                />
              </div>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((token) => (
                <TokenSwatch key={token.id} token={token} />
              ))}
            </div>
          </div>
        );
      }}
    </Guard>
  );
}

/* ----------------------------------------------------------------- logos */
function LogosTab({ query }: { query: QueryLike<LogoVariant[]> }) {
  return (
    <Guard
      query={query}
      empty={
        <EmptyState
          icon={ImageOff}
          title="No logo variants"
          description="Upload each approved lockup with its clearspace and minimum-size constraints so the logo analyzer has something to measure against."
        />
      }
    >
      {(logos) => (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {logos.map((logo) => (
            <figure key={logo.id} className="rounded-lg border border-border bg-surface">
              <div className="flex h-32 items-center justify-center rounded-t-lg bg-surface-2 p-3">
                {logo.previewUrl ? (
                  <img src={logo.previewUrl} alt={logo.name} className="max-h-full max-w-full object-contain" />
                ) : (
                  <ImageOff className="size-5 text-fg-subtle" aria-hidden="true" />
                )}
              </div>
              <figcaption className="border-t border-border p-2.5">
                <p className="truncate text-[13px] font-medium text-fg">{logo.name}</p>
                <p className="num text-[11px] text-fg-muted">{logo.kind}</p>
                <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                  {logo.width && logo.height ? (
                    <Pair label="size" value={`${logo.width}×${logo.height}`} />
                  ) : null}
                  {logo.aspectRatio ? <Pair label="aspect" value={logo.aspectRatio.toFixed(2)} /> : null}
                  {logo.logomarkHeightPx ? <Pair label="mark h" value={`${logo.logomarkHeightPx}px`} /> : null}
                </dl>
                {!logo.isActive ? (
                  <Badge tone="advisory" className="mt-1.5">
                    Inactive
                  </Badge>
                ) : null}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Guard>
  );
}

/* ------------------------------------------------------------ typography */
function TypographyTab({ query }: { query: QueryLike<TypeStyle[]> }) {
  const columns: Array<Column<TypeStyle>> = [
    { id: 'name', header: 'Style', sortValue: (t) => t.name, cell: (t) => <span className="font-medium text-fg">{t.name}</span> },
    { id: 'role', header: 'Role', cell: (t) => <span className="text-fg-muted">{t.role ?? '—'}</span> },
    {
      id: 'family',
      header: 'Family',
      sortValue: (t) => t.fontFamily,
      cell: (t) => (
        <span className="num text-fg">
          {t.fontFamily}
          {t.fontWeight ? <span className="text-fg-subtle"> {t.fontWeight}</span> : null}
          {t.isItalic ? <span className="text-fg-subtle"> italic</span> : null}
        </span>
      ),
    },
    {
      id: 'min',
      header: 'Min size',
      align: 'right',
      sortValue: (t) => t.minSizePx ?? t.minSizePt ?? 0,
      cell: (t) => (
        <span className="num text-fg-muted">
          {t.minSizePx ? `${t.minSizePx}px` : t.minSizePt ? `${t.minSizePt}pt` : '—'}
          {t.minSizePctOfCanvas ? ` · ${(t.minSizePctOfCanvas * 100).toFixed(1)}% canvas` : ''}
        </span>
      ),
    },
    {
      id: 'lineHeight',
      header: 'Line height',
      align: 'right',
      cell: (t) => <span className="num text-fg-muted">{t.lineHeightRatio?.toFixed(2) ?? '—'}</span>,
    },
    {
      id: 'tracking',
      header: 'Tracking',
      align: 'right',
      cell: (t) => <span className="num text-fg-muted">{t.letterSpacingEm?.toFixed(3) ?? '—'}em</span>,
    },
  ];

  return (
    <Guard
      query={query}
      loading={<SkeletonTable rows={5} cols={6} />}
      empty={
        <EmptyState
          title="No type styles"
          description="Type styles carry the minimum sizes and line-height ratios the typography analyzer enforces."
        />
      }
    >
      {(rows) => (
        <div className="space-y-4">
          <DataTable columns={columns} rows={rows} rowKey={(t) => t.id} caption="Type styles" pageSize={25} />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rows.slice(0, 6).map((style) => (
              <div key={style.id} className="rounded-md border border-border bg-surface p-3">
                <p
                  className="truncate text-fg"
                  style={{
                    fontFamily: style.fontFamily,
                    fontWeight: style.fontWeight ?? undefined,
                    fontStyle: style.isItalic ? 'italic' : undefined,
                    fontSize: Math.min(28, Math.max(13, style.minSizePx ?? 16)),
                    lineHeight: style.lineHeightRatio ?? undefined,
                    letterSpacing: style.letterSpacingEm ? `${style.letterSpacingEm}em` : undefined,
                  }}
                >
                  {style.name}
                </p>
                <p className="num mt-1 text-[11px] text-fg-subtle">{style.fontFamily}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </Guard>
  );
}

/* ----------------------------------------------------------------- voice */
function VoiceTab({ query }: { query: QueryLike<VoiceAttribute[]> }) {
  return (
    <Guard
      query={query}
      empty={
        <EmptyState
          title="No voice attributes"
          description="Voice is expressed as we-are / we-are-not pairs with exemplars — a contrastive definition a judge can actually apply."
        />
      }
    >
      {(rows) => (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((attribute) => (
            <article key={attribute.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold text-fg">{attribute.name}</h3>
                <Badge tone="outline" mono>
                  weight {attribute.weight}
                </Badge>
              </div>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                <div className="rounded-md bg-[var(--ok-soft)] p-2">
                  <dt className="text-[11px] font-medium text-[var(--ok-fg)]">We are</dt>
                  <dd className="mt-0.5 text-xs leading-5 text-fg">{attribute.weAre ?? '—'}</dd>
                </div>
                <div className="rounded-md bg-blocker-soft p-2">
                  <dt className="text-[11px] font-medium text-blocker-fg">We are not</dt>
                  <dd className="mt-0.5 text-xs leading-5 text-fg">{attribute.weAreNot ?? '—'}</dd>
                </div>
              </dl>
              {attribute.positiveExamples?.length ? (
                <p className="mt-2 text-[11px] leading-4 text-fg-muted">
                  <span className="font-medium text-fg-subtle">Exemplars: </span>
                  {attribute.positiveExamples.slice(0, 3).join(' · ')}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </Guard>
  );
}

/* --------------------------------------------------------------- lexicon */
function LexiconTab({ query }: { query: QueryLike<LexiconTerm[]> }) {
  const columns: Array<Column<LexiconTerm>> = [
    { id: 'term', header: 'Term', sortValue: (t) => t.term, cell: (t) => <span className="num text-fg">{t.term}</span> },
    { id: 'kind', header: 'Kind', sortValue: (t) => t.kind, cell: (t) => <Badge tone="outline">{t.kind}</Badge> },
    { id: 'replacement', header: 'Replacement', cell: (t) => <span className="num text-fg-muted">{t.replacement ?? '—'}</span> },
    { id: 'severity', header: 'Severity', cell: (t) => <SeverityBadge severity={t.severity} /> },
    {
      id: 'matching',
      header: 'Matching',
      cell: (t) => (
        <span className="text-[11px] text-fg-muted">
          {[t.caseSensitive ? 'case-sensitive' : null, t.matchWholeWord ? 'whole word' : null, t.allowFuzzy ? 'fuzzy' : null]
            .filter(Boolean)
            .join(' · ') || 'default'}
        </span>
      ),
    },
    { id: 'markets', header: 'Markets', cell: (t) => <span className="num text-fg-muted">{t.marketCodes?.join(', ') ?? 'all'}</span> },
  ];

  return (
    <Guard
      query={query}
      loading={<SkeletonTable rows={6} cols={6} />}
      empty={
        <EmptyState
          title="No lexicon terms"
          description="Banned, required, preferred and trademark terms. Deterministic, zero-cost, 100% precise."
        />
      }
    >
      {(rows) => <DataTable columns={columns} rows={rows} rowKey={(t) => t.id} caption="Lexicon terms" pageSize={25} />}
    </Guard>
  );
}

/* ---------------------------------------------------------------- claims */
function ClaimsTab({ query }: { query: QueryLike<Claim[]> }) {
  const columns: Array<Column<Claim>> = [
    { id: 'text', header: 'Claim', sortValue: (c) => c.text, cell: (c) => <span className="text-fg">{c.text}</span> },
    { id: 'category', header: 'Category', cell: (c) => <span className="text-fg-muted">{c.category ?? '—'}</span> },
    {
      id: 'substantiation',
      header: 'Substantiation',
      cell: (c) =>
        c.substantiationUrl ? (
          <a href={c.substantiationUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {c.substantiationRef ?? 'Reference'}
          </a>
        ) : (
          <span className="text-fg-muted">{c.substantiationRef ?? '—'}</span>
        ),
    },
    {
      id: 'jurisdictions',
      header: 'Jurisdictions',
      cell: (c) => <span className="num text-fg-muted">{c.jurisdictions?.join(', ') ?? 'all'}</span>,
    },
    {
      id: 'expiry',
      header: 'Expires',
      align: 'right',
      sortValue: (c) => c.expiresAt ?? '',
      cell: (c) => {
        if (!c.expiresAt) return <span className="text-fg-subtle">—</span>;
        const expired = new Date(c.expiresAt).getTime() < Date.now();
        return (
          <span className={expired ? 'num text-blocker-fg' : 'num text-fg-muted'}>
            {formatDate(c.expiresAt)}
            {expired ? ' (expired)' : ''}
          </span>
        );
      },
    },
    { id: 'active', header: 'Status', cell: (c) => (c.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="advisory">Inactive</Badge>) },
  ];

  return (
    <Guard
      query={query}
      loading={<SkeletonTable rows={6} cols={6} />}
      empty={
        <EmptyState
          title="No registered claims"
          description="A claims register with substantiation and expiry is what makes a legal check deterministic rather than a judgement call."
        />
      }
    >
      {(rows) => <DataTable columns={columns} rows={rows} rowKey={(c) => c.id} caption="Claims register" pageSize={25} />}
    </Guard>
  );
}

/* ----------------------------------------------------------- disclaimers */
function DisclaimersTab({ query }: { query: QueryLike<Disclaimer[]> }) {
  return (
    <Guard
      query={query}
      empty={
        <EmptyState
          title="No disclaimers"
          description="Disclaimers carry the size, contrast and proximity requirements that make them checkable rather than merely present."
        />
      }
    >
      {(rows) => (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((disclaimer) => (
            <article key={disclaimer.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-semibold text-fg">{disclaimer.name}</h3>
                <SeverityBadge severity={disclaimer.severity} />
                {disclaimer.isRequired ? <Badge tone="accent">Required</Badge> : null}
              </div>
              <p className="mt-1.5 text-xs leading-5 text-fg-muted">{disclaimer.text}</p>
              <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                <Pair label="min size" value={disclaimer.minFontSizePt ? `${disclaimer.minFontSizePt}pt` : '—'} />
                <Pair label="min contrast" value={formatMeasured(disclaimer.minContrastRatio)} />
                <Pair
                  label="max proximity"
                  value={disclaimer.maxProximityPct ? `${(disclaimer.maxProximityPct * 100).toFixed(0)}%` : '—'}
                />
                <Pair label="markets" value={disclaimer.marketCodes?.join(', ') ?? 'all'} />
              </dl>
            </article>
          ))}
        </div>
      )}
    </Guard>
  );
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="num text-fg">{value}</dd>
    </div>
  );
}
