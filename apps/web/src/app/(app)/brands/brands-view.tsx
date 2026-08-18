'use client';

import * as React from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { Layers, Plus } from 'lucide-react';
import { CreateBrandInput } from '@brandlens/contracts';
import type { Brand } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable, type Column } from '@/components/data-table';
import { useToast } from '@/components/ui/toast';
import { useBrandsQuery, useCreateBrandMutation } from '@/hooks/use-brands';
import { useSession } from '@/providers/session-provider';
import { hasRole } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import { formatDate } from '@/lib/format';

interface FormValues {
  name: string;
  slug: string;
  description: string;
  positioning: string;
}

export function BrandsView() {
  const user = useSession();
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useBrandsQuery();
  const create = useCreateBrandMutation();
  const [open, setOpen] = React.useState(false);
  const canManage = hasRole(user.role, 'brand_manager');

  const columns: Array<Column<Brand>> = [
    {
      id: 'name',
      header: 'Brand',
      sortValue: (b) => b.name,
      cell: (b) => (
        <div className="min-w-0">
          <Link href={`/brands/${b.id}`} className="font-medium text-fg hover:text-accent">
            {b.name}
          </Link>
          <p className="num text-fg-subtle">{b.slug}</p>
        </div>
      ),
    },
    {
      id: 'description',
      header: 'Description',
      cell: (b) => <span className="line-clamp-2 text-fg-muted">{b.description ?? '—'}</span>,
    },
    {
      id: 'ruleset',
      header: 'Active ruleset',
      cell: (b) =>
        b.activeRulesetId ? (
          <Badge tone="ok">Published</Badge>
        ) : (
          <Badge tone="major">Not compiled</Badge>
        ),
    },
    {
      id: 'parent',
      header: 'Type',
      cell: (b) => <span className="text-fg-muted">{b.parentBrandId ? 'Sub-brand' : 'Top-level'}</span>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      align: 'right',
      sortValue: (b) => b.createdAt,
      cell: (b) => <span className="num text-fg-muted">{formatDate(b.createdAt)}</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      srOnlyHeader: true,
      cell: (b) => (
        <div className="flex justify-end gap-1">
          <Link href={`/brands/${b.id}/rules/review`} className="text-xs text-accent hover:underline">
            Confirm rules
          </Link>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Brands"
        description="Each brand owns its own ontology, rule lattice and compiled rulesets."
        actions={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              New brand
            </Button>
          ) : null
        }
      />

      <PageBody>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(b) => b.id}
          caption="Brands in this organization"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          pageSize={25}
          initialSort={{ columnId: 'name', direction: 'asc' }}
          empty={
            <EmptyState
              icon={Layers}
              title="No brands yet"
              description="A brand is the unit everything else hangs off: tokens, logos, rules, assets and checks."
              actionLabel={canManage ? 'Create your first brand' : undefined}
              onAction={() => setOpen(true)}
            />
          }
        />
      </PageBody>

      <CreateBrandDialog
        open={open}
        onClose={() => setOpen(false)}
        pending={create.isPending}
        onSubmit={async (values) => {
          const parsed = CreateBrandInput.safeParse({
            name: values.name,
            slug: values.slug,
            description: values.description || undefined,
            positioning: values.positioning || undefined,
          });
          if (!parsed.success) {
            toast({ title: 'Check the form', description: parsed.error.issues[0]?.message, tone: 'error' });
            return;
          }
          try {
            const brand = await create.mutateAsync(parsed.data);
            setOpen(false);
            toast({
              title: `${brand.name} created`,
              description: 'Next: upload a brand book, or induce rules from approved assets.',
              tone: 'success',
            });
          } catch (mutationError) {
            toast({ title: 'Could not create the brand', description: errorMessage(mutationError), tone: 'error' });
          }
        }}
      />
    </div>
  );
}

function CreateBrandDialog({
  open,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: FormValues) => void | Promise<void>;
  pending: boolean;
}) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: { name: '', slug: '', description: '', positioning: '' } });

  const name = watch('name');
  React.useEffect(() => {
    setValue('slug', name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }, [name, setValue]);

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
      title="Create a brand"
      description="You can add tokens, logos and rules afterwards."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={pending} onClick={() => void submit()}>
            Create brand
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name" htmlFor="brand-name" required error={errors.name?.message}>
          <Input id="brand-name" autoFocus {...register('name', { required: 'Name is required' })} />
        </Field>
        <Field
          label="Slug"
          htmlFor="brand-slug"
          required
          error={errors.slug?.message}
          hint="Lowercase letters, digits and hyphens. Used in API paths."
        >
          <Input
            id="brand-slug"
            mono
            {...register('slug', {
              required: 'Slug is required',
              pattern: { value: /^[a-z0-9-]+$/, message: 'Lowercase letters, digits and hyphens only' },
            })}
          />
        </Field>
        <Field label="Description" htmlFor="brand-description">
          <Textarea id="brand-description" rows={2} {...register('description')} />
        </Field>
        <Field
          label="Positioning"
          htmlFor="brand-positioning"
          hint="Used as grounding context when a vision judge needs brand intent."
        >
          <Textarea id="brand-positioning" rows={2} {...register('positioning')} />
        </Field>
      </form>
    </Dialog>
  );
}
