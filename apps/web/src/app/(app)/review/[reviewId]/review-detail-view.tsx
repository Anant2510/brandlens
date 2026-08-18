'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, ImageOff, MessageSquare, XCircle } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { SeverityBadge } from '@/components/severity-badge';
import { DimensionBars } from '@/components/dimension-bars';
import { ScoreGauge } from '@/components/score-gauge';
import { DecisionControls } from '@/components/decision-controls';
import { useAssignReviewMutation, useReviewQuery, useSubmitReviewMutation } from '@/hooks/use-reviews';
import { useFindingDecisionMutation } from '@/hooks/use-findings';
import { useMembersQuery } from '@/hooks/use-platform';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatRelative } from '@/lib/format';
import { DECISION_ACTION_LABEL, dimensionLabel, FINDING_STATUS_LABEL, REVIEW_STATE_LABEL } from '@/lib/domain';

const STATE_TONE: Record<string, 'ok' | 'accent' | 'major' | 'blocker' | 'advisory' | 'neutral'> = {
  approved: 'ok',
  pending: 'accent',
  in_review: 'accent',
  changes_requested: 'major',
  rejected: 'blocker',
  withdrawn: 'advisory',
};

export function ReviewDetailView({ reviewId }: { reviewId: string }) {
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useReviewQuery(reviewId);
  const { data: members } = useMembersQuery();
  const assign = useAssignReviewMutation(reviewId);
  const submit = useSubmitReviewMutation(reviewId);
  const decide = useFindingDecisionMutation(data?.review.checkRunId ?? undefined);

  const [summary, setSummary] = React.useState('');
  const summaryId = React.useId();

  if (isPending) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-72 w-full" />
      </PageBody>
    );
  }

  if (isError || !data) {
    return (
      <PageBody>
        <ErrorState title="Could not load this review" message={errorMessage(error)} onRetry={() => void refetch()} />
      </PageBody>
    );
  }

  const { review, asset, checkRun, findings, decisions } = data;
  const closed = review.state === 'approved' || review.state === 'rejected';

  const submitReview = (state: 'approved' | 'rejected' | 'changes_requested') =>
    submit.mutate(
      { state, summary: summary.trim() || undefined },
      {
        onSuccess: () => toast({ title: `Review ${REVIEW_STATE_LABEL[state].toLowerCase()}`, tone: 'success' }),
        onError: (mutationError) =>
          toast({ title: 'Could not submit the review', description: errorMessage(mutationError), tone: 'error' }),
      },
    );

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: 'Review queue', href: '/review' }, { label: asset?.name ?? 'Review' }]}
        title={asset?.name ?? 'Review'}
        description={
          <span className="flex flex-wrap items-center gap-x-2">
            <Badge tone={STATE_TONE[review.state] ?? 'neutral'}>{REVIEW_STATE_LABEL[review.state] ?? review.state}</Badge>
            <span className="text-fg-muted">stage {review.stage}</span>
            {review.dueAt ? <span className="text-fg-muted">· due {formatRelative(review.dueAt)}</span> : null}
          </span>
        }
        actions={
          review.checkRunId ? (
            <Link href={`/checks/${review.checkRunId}`} className={buttonClasses('secondary', 'sm')}>
              Open decision trace
            </Link>
          ) : null
        }
      />

      <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Findings ({findings.length})</CardTitle>
              {checkRun ? (
                <Link href={`/checks/${checkRun.id}`} className="text-xs text-accent hover:underline">
                  Full trace viewer
                </Link>
              ) : null}
            </CardHeader>
            <CardContent className="p-0">
              {findings.length === 0 ? (
                <EmptyState
                  compact
                  className="m-3 border-0"
                  title="No findings on this run"
                  description="Nothing to adjudicate. Submit the review to close the gate."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {findings.map((finding) => (
                    <li key={finding.id} className="p-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SeverityBadge severity={finding.severity} />
                        <Badge tone="outline">{dimensionLabel(finding.dimension)}</Badge>
                        {finding.status !== 'open' ? (
                          <Badge tone={finding.status === 'overridden' ? 'major' : 'ok'}>
                            {FINDING_STATUS_LABEL[finding.status] ?? finding.status}
                          </Badge>
                        ) : null}
                        {!finding.isHighConfidence ? <Badge tone="neutral">low confidence</Badge> : null}
                      </div>
                      <p className="mt-1.5 text-[13px] font-medium leading-5 text-fg">{finding.title}</p>
                      {finding.detail ? <p className="mt-0.5 text-xs leading-5 text-fg-muted">{finding.detail}</p> : null}
                      <p className="num mt-0.5 text-[11px] text-fg-subtle">{finding.ruleKey}</p>

                      {!closed ? (
                        <DecisionControls
                          className="mt-2"
                          status={finding.status}
                          pending={decide.isPending}
                          compact
                          onDecide={async (action, rationale) => {
                            try {
                              await decide.mutateAsync({ findingId: finding.id, body: { action, rationale } });
                              await refetch();
                              toast({ title: 'Decision recorded', tone: 'success' });
                            } catch (mutationError) {
                              toast({
                                title: 'Could not record the decision',
                                description: errorMessage(mutationError),
                                tone: 'error',
                              });
                            }
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Decision history</CardTitle>
              <span className="num text-fg-subtle">{decisions.length}</span>
            </CardHeader>
            <CardContent className="p-0">
              {decisions.length === 0 ? (
                <p className="px-4 py-3 text-xs text-fg-muted">No decisions recorded on this review yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {decisions.map((decision) => (
                    <li key={decision.id} className="flex items-start gap-2.5 px-4 py-2.5">
                      <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-fg">
                          <span className="font-medium">{DECISION_ACTION_LABEL[decision.action] ?? decision.action}</span>
                          <span className="num ml-1.5 text-fg-subtle">{decision.ruleKey}</span>
                        </p>
                        {decision.rationale ? (
                          <p className="mt-0.5 text-[11px] leading-4 text-fg-muted">{decision.rationale}</p>
                        ) : null}
                      </div>
                      <span className="num shrink-0 text-[11px] text-fg-subtle">{formatDateTime(decision.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <Card>
            <CardContent className="flex h-40 items-center justify-center bg-surface-2">
              {asset?.previewUrl ? (
                <img src={asset.previewUrl} alt={asset.name} className="max-h-full max-w-full object-contain" />
              ) : (
                <ImageOff className="size-5 text-fg-subtle" aria-hidden="true" />
              )}
            </CardContent>
          </Card>

          {checkRun ? (
            <Card>
              <CardHeader>
                <CardTitle>Check result</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  <ScoreGauge score={checkRun.score} band={checkRun.scoreBand} hasBlocker={checkRun.hasBlocker} size={72} strokeWidth={6} />
                  <div className="min-w-0 flex-1">
                    {checkRun.hasBlocker ? (
                      <p className="rounded bg-blocker-soft px-2 py-1 text-[11px] font-medium text-blocker-fg">
                        Blocker present — overrides the score
                      </p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-fg-muted">Run {formatDateTime(checkRun.createdAt)}</p>
                  </div>
                </div>
                <DimensionBars scores={checkRun.dimensionScores} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Assignment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Select
                value={review.assignedToUserId ?? ''}
                placeholder="Unassigned"
                aria-label="Assign this review"
                disabled={closed}
                onChange={(event) => {
                  if (!event.target.value) return;
                  assign.mutate(event.target.value, {
                    onSuccess: () => toast({ title: 'Review assigned', tone: 'success' }),
                    onError: (mutationError) =>
                      toast({ title: 'Assignment failed', description: errorMessage(mutationError), tone: 'error' }),
                  });
                }}
                options={(members ?? []).map((m) => ({ value: m.userId, label: m.name ?? m.email }))}
              />
              {review.decidedAt ? (
                <p className="text-[11px] text-fg-subtle">Decided {formatDateTime(review.decidedAt)}</p>
              ) : null}
            </CardContent>
          </Card>

          {!closed ? (
            <Card>
              <CardHeader>
                <CardTitle>Close this gate</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor={summaryId}>Summary</Label>
                <Textarea
                  id={summaryId}
                  rows={3}
                  value={summary}
                  placeholder="What did you conclude, and why?"
                  onChange={(event) => setSummary(event.target.value)}
                />
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="primary" loading={submit.isPending} onClick={() => submitReview('approved')}>
                    <CheckCircle2 className="size-3.5" aria-hidden="true" />
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" loading={submit.isPending} onClick={() => submitReview('changes_requested')}>
                    Request changes
                  </Button>
                  <Button size="sm" variant="ghost" loading={submit.isPending} onClick={() => submitReview('rejected')}>
                    <XCircle className="size-3.5" aria-hidden="true" />
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent>
                <p className="text-xs text-fg-muted">
                  This review is closed as{' '}
                  <span className="font-medium text-fg">{REVIEW_STATE_LABEL[review.state] ?? review.state}</span>.
                </p>
                {review.summary ? <p className="mt-1.5 text-xs leading-5 text-fg">{review.summary}</p> : null}
              </CardContent>
            </Card>
          )}
        </div>
      </PageBody>
    </div>
  );
}
