'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, FileText, Rocket, ShieldCheck, Sparkles } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/app-shell';
import { BrandNav } from '@/components/brand-nav';
import { StatTile } from '@/components/stat-tile';
import { ScorePill } from '@/components/score-gauge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { Progress } from '@/components/ui/progress';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonCards } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useBrandOverviewQuery } from '@/hooks/use-brands';
import { usePublishRulesetMutation } from '@/hooks/use-rulesets';
import { useInduceRulesMutation } from '@/hooks/use-ontology';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatPercent, shortHash } from '@/lib/format';

export function BrandOverviewView({ brandId }: { brandId: string }) {
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useBrandOverviewQuery(brandId);
  const publish = usePublishRulesetMutation(brandId);
  const induce = useInduceRulesMutation(brandId);

  if (isPending) {
    return (
      <div>
        <div className="border-b border-border px-4 py-3">
          <Skeleton className="h-5 w-48" />
        </div>
        <PageBody>
          <SkeletonCards count={4} className="sm:grid-cols-2 lg:grid-cols-4" />
        </PageBody>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <PageBody>
        <ErrorState title="Could not load this brand" message={errorMessage(error)} onRetry={() => void refetch()} />
      </PageBody>
    );
  }

  const readiness = data.readiness;
  const steps = [
    { done: readiness.hasTokens, label: 'Design tokens imported', href: `/brands/${brandId}/ontology` },
    { done: readiness.hasLogos, label: 'Logo variants uploaded', href: `/brands/${brandId}/ontology?tab=logos` },
    { done: readiness.hasRules, label: 'Rules confirmed', href: `/brands/${brandId}/rules/review` },
    { done: readiness.hasRuleset, label: 'Ruleset compiled', href: `/brands/${brandId}/rulesets` },
  ];

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: 'Brands', href: '/brands' }, { label: data.name }]}
        title={data.name}
        description={data.description ?? data.positioning ?? `Slug ${data.slug}`}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              loading={induce.isPending}
              onClick={() =>
                induce.mutate(
                  {},
                  {
                    onSuccess: () =>
                      toast({
                        title: 'Induction queued',
                        description: 'Rules will arrive as proposals once the corpus has been measured.',
                        tone: 'info',
                      }),
                    onError: (mutationError) =>
                      toast({ title: 'Induction failed', description: errorMessage(mutationError), tone: 'error' }),
                  },
                )
              }
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              Induce rules
            </Button>
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
                        description: `${ruleset.ruleCount} rules frozen at hash ${shortHash(ruleset.hash)}.`,
                        tone: 'success',
                      }),
                    onError: (mutationError) =>
                      toast({ title: 'Compile failed', description: errorMessage(mutationError), tone: 'error' }),
                  },
                )
              }
            >
              <Rocket className="size-3.5" aria-hidden="true" />
              Compile ruleset
            </Button>
          </>
        }
      />
      <BrandNav brandId={brandId} />

      <PageBody className="space-y-4">
        {readiness.percent < 100 ? (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Onboarding readiness</CardTitle>
                <p className="mt-0.5 text-xs text-fg-muted">
                  A brand can only be verified once it has rules and a compiled ruleset.
                </p>
              </div>
              <span className="num text-sm font-semibold text-fg">{readiness.percent}%</span>
            </CardHeader>
            <CardContent>
              <Progress value={readiness.percent} label="Brand readiness" size="md" />
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {steps.map((step) => (
                  <li key={step.label}>
                    <Link
                      href={step.href}
                      className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-xs transition-colors hover:border-border-strong hover:bg-surface-2"
                    >
                      {step.done ? (
                        <CheckCircle2 className="size-3.5 shrink-0 text-[var(--ok)]" aria-hidden="true" />
                      ) : (
                        <Circle className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                      )}
                      <span className={step.done ? 'text-fg-muted line-through' : 'text-fg'}>{step.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Active rules"
            value={data.counts.rulesActive}
            sub={
              data.counts.rulesProposed > 0 ? (
                <Link href={`/brands/${brandId}/rules/review`} className="text-accent hover:underline">
                  {data.counts.rulesProposed} awaiting confirmation
                </Link>
              ) : (
                'No proposals outstanding'
              )
            }
            icon={ShieldCheck}
          />
          <StatTile
            label="Open findings"
            value={data.openFindings}
            tone={data.openFindings > 0 ? 'warn' : 'default'}
            href="/review"
            sub="Findings without a human decision"
          />
          <StatTile label="Assets" value={data.counts.assets} href={`/assets?brandId=${brandId}`} sub="Registered for this brand" />
          <StatTile
            label="Ontology"
            value={data.counts.tokens + data.counts.logos + data.counts.typeStyles}
            href={`/brands/${brandId}/ontology`}
            sub={`${data.counts.tokens} tokens · ${data.counts.logos} logos · ${data.counts.typeStyles} type styles`}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Active ruleset</CardTitle>
              <Link href={`/brands/${brandId}/rulesets`} className="text-xs text-accent hover:underline">
                Version history
              </Link>
            </CardHeader>
            <CardContent>
              {data.activeRuleset ? (
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <Row label="Version" value={<span className="num">v{data.activeRuleset.version}</span>} />
                  <Row label="Rules" value={<span className="num">{data.activeRuleset.ruleCount}</span>} />
                  <Row
                    label="Hash"
                    value={
                      <span className="num" title={data.activeRuleset.hash}>
                        {shortHash(data.activeRuleset.hash, 16)}
                      </span>
                    }
                  />
                  <Row label="Published" value={formatDateTime(data.activeRuleset.publishedAt)} />
                  <div className="col-span-2 rounded-md bg-surface-2 p-2 text-[11px] leading-4 text-fg-muted">
                    The hash is the cache key, the audit anchor and the reproducibility guarantee. Every check run pins
                    the hash it was evaluated against, so a rule change never rewrites history.
                  </div>
                </dl>
              ) : (
                <EmptyState
                  compact
                  className="border-0"
                  title="No ruleset compiled"
                  description="Confirm proposed rules, then compile to freeze them into a hashed snapshot."
                  actionLabel="Confirm rules"
                  actionHref={`/brands/${brandId}/rules/review`}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent checks</CardTitle>
              <Link href={`/checks?brandId=${brandId}`} className="text-xs text-accent hover:underline">
                All runs
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {data.recentChecks.length === 0 ? (
                <EmptyState
                  compact
                  className="m-3 border-0"
                  title="No checks yet"
                  description="Upload an asset and run a verification."
                  actionLabel="Go to assets"
                  actionHref={`/assets?brandId=${brandId}`}
                />
              ) : (
                <ul className="divide-y divide-border">
                  {data.recentChecks.map((run) => (
                    <li key={run.id}>
                      <Link
                        href={`/checks/${run.id}`}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
                      >
                        <ScorePill score={run.score} band={run.scoreBand} />
                        <span className="num min-w-0 flex-1 truncate text-fg-muted">{run.id}</span>
                        <span className="num shrink-0 text-fg-subtle">{formatDateTime(run.createdAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Ontology coverage</CardTitle>
            <Link href={`/brands/${brandId}/ontology`} className="text-xs text-accent hover:underline">
              Manage
            </Link>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {[
                ['Tokens', data.counts.tokens],
                ['Logos', data.counts.logos],
                ['Type styles', data.counts.typeStyles],
                ['Voice', data.counts.voiceAttributes],
                ['Claims', data.counts.claims],
                ['Disclaimers', data.counts.disclaimers],
                ['Assets', data.counts.assets],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</dt>
                  <dd className="num text-base font-semibold text-fg">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
          <FileText className="size-4 text-fg-subtle" aria-hidden="true" />
          <p className="flex-1 text-xs text-fg-muted">
            Coverage so far: {formatPercent(readiness.percent / 100, 0)} of the onboarding path.
          </p>
          <Link href={`/brands/${brandId}/documents`} className={buttonClasses('outline', 'sm')}>
            Upload a brand book
          </Link>
        </div>
      </PageBody>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-fg">{value}</dd>
    </div>
  );
}
