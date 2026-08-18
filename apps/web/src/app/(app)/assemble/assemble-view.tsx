'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm } from 'react-hook-form';
import { FileStack, Plus, Trash2 } from 'lucide-react';
import type { Brief } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Label } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { useBriefsQuery, useCreateBriefMutation } from '@/hooks/use-assemble';
import { useBrandsQuery } from '@/hooks/use-brands';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

interface TargetRow {
  platform: string;
  placement: string;
  assetType: string;
  count: number;
  market: string;
}

interface FormValues {
  brandId: string;
  title: string;
  objective: string;
  keyMessage: string;
  mandatories: string;
  targets: TargetRow[];
}

export function AssembleView() {
  const router = useRouter();
  const { toast } = useToast();
  const [brandId, setBrandId] = React.useState('');
  const [open, setOpen] = React.useState(false);

  const { data: brands } = useBrandsQuery();
  const { data, isPending, isError, error, refetch } = useBriefsQuery(brandId || undefined);
  const create = useCreateBriefMutation();

  const columns: Array<Column<Brief>> = [
    {
      id: 'title',
      header: 'Brief',
      sortValue: (b) => b.title,
      cell: (b) => (
        <div className="min-w-0">
          <Link href={`/assemble/${b.id}`} className="block truncate font-medium text-fg hover:text-accent">
            {b.title}
          </Link>
          {b.objective ? <p className="truncate text-[11px] text-fg-muted">{b.objective}</p> : null}
        </div>
      ),
    },
    {
      id: 'targets',
      header: 'Targets',
      align: 'right',
      sortValue: (b) => b.targets?.length ?? 0,
      cell: (b) => <span className="num text-fg-muted">{b.targets?.length ?? 0}</span>,
    },
    {
      id: 'mandatories',
      header: 'Mandatories',
      align: 'right',
      cell: (b) => <span className="num text-fg-muted">{b.mandatories?.length ?? 0}</span>,
    },
    { id: 'status', header: 'Status', sortValue: (b) => b.status, cell: (b) => <Badge tone="outline">{b.status}</Badge> },
    {
      id: 'created',
      header: 'Created',
      align: 'right',
      sortValue: (b) => b.createdAt,
      cell: (b) => <span className="num text-fg-muted">{formatDateTime(b.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Assemble"
        description="Turn a brief into a constraint-satisfying plan: every item is resolved against the brand's active ruleset before anything is produced."
        actions={
          <>
            <Select
              className="w-44"
              value={brandId}
              placeholder="All brands"
              onChange={(event) => setBrandId(event.target.value)}
              aria-label="Filter by brand"
              options={(brands ?? []).map((b) => ({ value: b.id, label: b.name }))}
            />
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              New brief
            </Button>
          </>
        }
      />

      <PageBody>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(b) => b.id}
          caption="Briefs"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          onRowClick={(brief) => router.push(`/assemble/${brief.id}`)}
          pageSize={25}
          initialSort={{ columnId: 'created', direction: 'desc' }}
          empty={
            <EmptyState
              icon={FileStack}
              title="No briefs"
              description="A brief carries the objective, key message, mandatories and the placements you need. Assembly resolves it against the brand's rules."
              actionLabel="Create a brief"
              onAction={() => setOpen(true)}
            />
          }
        />
      </PageBody>

      <CreateBriefDialog
        open={open}
        brands={(brands ?? []).map((b) => ({ value: b.id, label: b.name }))}
        pending={create.isPending}
        onClose={() => setOpen(false)}
        onSubmit={async (values) => {
          try {
            const brief = await create.mutateAsync({
              brandId: values.brandId,
              title: values.title,
              objective: values.objective || undefined,
              keyMessage: values.keyMessage || undefined,
              mandatories: values.mandatories
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
              targets: values.targets.map((target) => ({
                platform: target.platform,
                placement: target.placement,
                assetType: target.assetType,
                count: Number(target.count) || 1,
                market: target.market || undefined,
              })),
            });
            setOpen(false);
            router.push(`/assemble/${brief.id}`);
          } catch (mutationError) {
            toast({ title: 'Could not create the brief', description: errorMessage(mutationError), tone: 'error' });
          }
        }}
      />
    </div>
  );
}

function CreateBriefDialog({
  open,
  brands,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  brands: Array<{ value: string; label: string }>;
  pending: boolean;
  onClose: () => void;
  onSubmit: (values: FormValues) => void | Promise<void>;
}) {
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: {
      brandId: '',
      title: '',
      objective: '',
      keyMessage: '',
      mandatories: '',
      targets: [{ platform: 'meta', placement: 'feed', assetType: 'image', count: 1, market: '' }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'targets' });

  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(values);
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a brief"
      description="Assembly resolves each target against the brand's active ruleset and channel specs."
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={pending} onClick={() => void submit()}>
            Create brief
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Brand" htmlFor="brief-brand" required error={errors.brandId?.message}>
          <Select
            id="brief-brand"
            placeholder="Select a brand"
            options={brands}
            invalid={Boolean(errors.brandId)}
            {...register('brandId', { required: 'Choose a brand' })}
          />
        </Field>

        <Field label="Title" htmlFor="brief-title" required error={errors.title?.message}>
          <Input id="brief-title" {...register('title', { required: 'Title is required' })} />
        </Field>

        <Field label="Objective" htmlFor="brief-objective">
          <Textarea id="brief-objective" rows={2} {...register('objective')} />
        </Field>

        <Field label="Key message" htmlFor="brief-message">
          <Textarea id="brief-message" rows={2} {...register('keyMessage')} />
        </Field>

        <Field
          label="Mandatories"
          htmlFor="brief-mandatories"
          hint="One per line. These become hard constraints on the plan."
        >
          <Textarea id="brief-mandatories" rows={3} {...register('mandatories')} />
        </Field>

        <div>
          <Label>Targets</Label>
          <div className="space-y-2">
            {fields.map((field, index) => (
              <div key={field.id} className="grid grid-cols-[1fr_1fr_1fr_4rem_5rem_2rem] gap-1.5">
                <Input aria-label="Platform" placeholder="meta" {...register(`targets.${index}.platform` as const)} />
                <Input aria-label="Placement" placeholder="feed" {...register(`targets.${index}.placement` as const)} />
                <Input aria-label="Asset type" placeholder="image" {...register(`targets.${index}.assetType` as const)} />
                <Input aria-label="Count" type="number" min="1" mono {...register(`targets.${index}.count` as const)} />
                <Input aria-label="Market" placeholder="de-DE" {...register(`targets.${index}.market` as const)} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove target ${index + 1}`}
                  onClick={() => remove(index)}
                  disabled={fields.length <= 1}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => append({ platform: '', placement: '', assetType: 'image', count: 1, market: '' })}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add target
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
