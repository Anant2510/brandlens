'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useOrganizationQuery, useUpdateOrganizationMutation } from '@/hooks/use-platform';
import { useSession } from '@/providers/session-provider';
import { hasRole } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import { formatUsd } from '@/lib/format';

interface FormValues {
  name: string;
  dailyUsdLimit: string;
}

export function OrganizationSettingsView() {
  const user = useSession();
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useOrganizationQuery();
  const update = useUpdateOrganizationMutation();
  const canManage = hasRole(user.role, 'admin');

  const { register, handleSubmit, reset } = useForm<FormValues>({ defaultValues: { name: '', dailyUsdLimit: '' } });

  React.useEffect(() => {
    if (data) reset({ name: data.name, dailyUsdLimit: String(data.dailyUsdLimit ?? '') });
  }, [data, reset]);

  const submit = handleSubmit((values) => {
    const limit = Number(values.dailyUsdLimit);
    update.mutate(
      { name: values.name, dailyUsdLimit: Number.isFinite(limit) && limit > 0 ? limit : undefined },
      {
        onSuccess: () => toast({ title: 'Organization updated', tone: 'success' }),
        onError: (mutationError) =>
          toast({ title: 'Update failed', description: errorMessage(mutationError), tone: 'error' }),
      },
    );
  });

  return (
    <div>
      <PageHeader title="Organization" description="Identity and spend controls for this tenant." />
      <PageBody className="max-w-2xl space-y-4">
        {isPending ? <Skeleton className="h-48 w-full" /> : null}
        {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}

        {data ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
                <Badge tone="outline">{data.plan}</Badge>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="space-y-3">
                  <Field label="Name" htmlFor="org-name">
                    <Input id="org-name" disabled={!canManage} {...register('name')} />
                  </Field>
                  <Field label="Slug" htmlFor="org-slug" hint="Immutable — it appears in API paths and audit records.">
                    <Input id="org-slug" mono value={data.slug} readOnly disabled />
                  </Field>
                  <Field
                    label="Daily spend limit (USD)"
                    htmlFor="org-limit"
                    hint="When the tenant crosses this, the pipeline degrades gracefully instead of failing: deterministic tiers keep running and the run is labelled degraded."
                  >
                    <Input id="org-limit" type="number" step="0.5" min="0" mono disabled={!canManage} {...register('dailyUsdLimit')} />
                  </Field>
                  {canManage ? (
                    <Button type="submit" variant="primary" size="sm" loading={update.isPending}>
                      Save changes
                    </Button>
                  ) : (
                    <p className="text-[11px] text-fg-subtle">Only admins and owners can change these settings.</p>
                  )}
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Current configuration</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-fg-subtle">Organization ID</dt>
                    <dd className="num mt-0.5 break-all text-fg">{data.id}</dd>
                  </div>
                  <div>
                    <dt className="text-fg-subtle">Daily limit</dt>
                    <dd className="num mt-0.5 text-fg">{formatUsd(data.dailyUsdLimit)}</dd>
                  </div>
                </dl>
                {Object.keys(data.settings ?? {}).length > 0 ? (
                  <pre className="mt-3 max-h-64 overflow-auto scroll-thin rounded-md bg-surface-2 p-2 font-mono text-[11px] text-fg">
                    {JSON.stringify(data.settings, null, 2)}
                  </pre>
                ) : null}
              </CardContent>
            </Card>
          </>
        ) : null}
      </PageBody>
    </div>
  );
}
