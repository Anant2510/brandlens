'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Check, Copy, KeyRound, Plus, TriangleAlert } from 'lucide-react';
import type { ApiKey, CreatedApiKey } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, Label } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { useApiKeysQuery, useCreateApiKeyMutation, useRevokeApiKeyMutation } from '@/hooks/use-platform';
import { useSession } from '@/providers/session-provider';
import { hasRole } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import { formatDate, formatRelative } from '@/lib/format';

const SCOPES = [
  'checks:write',
  'checks:read',
  'assets:write',
  'assets:read',
  'brands:read',
  'rules:read',
  'rules:write',
];

export function ApiKeysView() {
  const user = useSession();
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useApiKeysQuery();
  const create = useCreateApiKeyMutation();
  const revoke = useRevokeApiKeyMutation();
  const canManage = hasRole(user.role, 'admin');

  const [open, setOpen] = React.useState(false);
  const [minted, setMinted] = React.useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = React.useState<ApiKey | null>(null);
  const [copied, setCopied] = React.useState(false);

  const { register, handleSubmit, reset, formState } = useForm<{ name: string; expiresInDays: string; scopes: string[] }>(
    { defaultValues: { name: '', expiresInDays: '', scopes: ['checks:write', 'checks:read', 'assets:write', 'brands:read'] } },
  );

  const columns: Array<Column<ApiKey>> = [
    {
      id: 'name',
      header: 'Key',
      sortValue: (k) => k.name,
      cell: (k) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{k.name}</p>
          <p className="num text-fg-subtle">{k.prefix}…</p>
        </div>
      ),
    },
    {
      id: 'scopes',
      header: 'Scopes',
      cell: (k) => (
        <div className="flex flex-wrap gap-1">
          {k.scopes.map((scope) => (
            <Badge key={scope} tone="outline" mono>
              {scope}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      align: 'right',
      sortValue: (k) => k.lastUsedAt ?? '',
      cell: (k) => <span className="num text-fg-muted">{k.lastUsedAt ? formatRelative(k.lastUsedAt) : 'never'}</span>,
    },
    {
      id: 'expires',
      header: 'Expires',
      align: 'right',
      sortValue: (k) => k.expiresAt ?? '',
      cell: (k) => <span className="num text-fg-muted">{k.expiresAt ? formatDate(k.expiresAt) : 'never'}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (k) => (k.revokedAt ? <Badge tone="blocker">Revoked</Badge> : <Badge tone="ok">Active</Badge>),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      srOnlyHeader: true,
      cell: (k) =>
        canManage && !k.revokedAt ? (
          <Button size="xs" variant="ghost" onClick={() => setRevoking(k)}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="API keys"
        description="Machine identities for the verification API. Only a peppered digest is stored, so a database dump yields no working credentials."
        actions={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              Mint key
            </Button>
          ) : null
        }
      />

      <PageBody>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(k) => k.id}
          caption="API keys"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          pageSize={25}
          empty={
            <EmptyState
              icon={KeyRound}
              title="No API keys"
              description="An API key is how an agent in a generate → verify → fix loop calls POST /v1/checks without a browser session."
              actionLabel={canManage ? 'Mint your first key' : undefined}
              onAction={() => setOpen(true)}
            />
          }
        />
      </PageBody>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Mint an API key"
        description="The secret is shown exactly once. There is no way to retrieve it afterwards."
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={create.isPending}
              onClick={() =>
                void handleSubmit((values) => {
                  const expires = Number(values.expiresInDays);
                  create.mutate(
                    {
                      name: values.name,
                      scopes: values.scopes,
                      expiresInDays: Number.isFinite(expires) && expires > 0 ? expires : undefined,
                    },
                    {
                      onSuccess: (key) => {
                        setOpen(false);
                        reset();
                        setMinted(key);
                      },
                      onError: (mutationError) =>
                        toast({ title: 'Could not mint the key', description: errorMessage(mutationError), tone: 'error' }),
                    },
                  );
                })()
              }
            >
              Mint key
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" htmlFor="key-name" required error={formState.errors.name?.message}>
            <Input id="key-name" autoFocus placeholder="CI pipeline" {...register('name', { required: 'Name is required' })} />
          </Field>
          <Field label="Expires in (days)" htmlFor="key-expiry" hint="Leave blank for a non-expiring key.">
            <Input id="key-expiry" type="number" min="1" mono {...register('expiresInDays')} />
          </Field>
          <div>
            <Label>Scopes</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {SCOPES.map((scope) => (
                <label key={scope} className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
                  <input type="checkbox" value={scope} className="size-3.5 accent-[var(--accent)]" {...register('scopes')} />
                  <span className="num">{scope}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={minted !== null}
        onClose={() => {
          setMinted(null);
          setCopied(false);
        }}
        title="Copy your key now"
        description="This is the only time it will be shown."
        dismissible={false}
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-major/50 bg-major-soft p-2.5">
            <TriangleAlert className="mt-px size-4 shrink-0 text-major" aria-hidden="true" />
            <p className="text-[11px] leading-4 text-major-fg">
              BrandLens stores only a peppered digest. If you lose this value you must mint a new key.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-fg">{minted?.key}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (!minted?.key) return;
                await navigator.clipboard.writeText(minted.key).catch(() => null);
                setCopied(true);
              }}
            >
              {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-[11px] text-fg-subtle">
            Send it as <span className="num">Authorization: Bearer {minted?.prefix}…</span>
          </p>
        </div>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          const key = revoking;
          setRevoking(null);
          if (!key) return;
          revoke.mutate(key.id, {
            onSuccess: () => toast({ title: 'Key revoked', tone: 'success' }),
            onError: (mutationError) =>
              toast({ title: 'Revoke failed', description: errorMessage(mutationError), tone: 'error' }),
          });
        }}
        title={`Revoke ${revoking?.name ?? 'this key'}?`}
        description="Any integration using it stops working immediately. The key's history is retained."
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
      />
    </div>
  );
}
