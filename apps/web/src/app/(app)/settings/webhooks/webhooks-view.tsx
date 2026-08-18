'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Check, Copy, Plus, Webhook } from 'lucide-react';
import { EVENT_TYPES } from '@brandlens/contracts';
import type { CreatedWebhook, WebhookEndpoint } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, ConfirmDialog, Drawer } from '@/components/ui/dialog';
import { Field, Input, Label } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import {
  useCreateWebhookMutation,
  useDeleteWebhookMutation,
  useWebhookDeliveriesQuery,
  useWebhooksQuery,
} from '@/hooks/use-platform';
import { useSession } from '@/providers/session-provider';
import { hasRole } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format';

export function WebhooksView() {
  const user = useSession();
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useWebhooksQuery();
  const create = useCreateWebhookMutation();
  const remove = useDeleteWebhookMutation();
  const canManage = hasRole(user.role, 'admin');

  const [open, setOpen] = React.useState(false);
  const [created, setCreated] = React.useState<CreatedWebhook | null>(null);
  const [deleting, setDeleting] = React.useState<WebhookEndpoint | null>(null);
  const [inspecting, setInspecting] = React.useState<WebhookEndpoint | null>(null);
  const [copied, setCopied] = React.useState(false);

  const { register, handleSubmit, reset, formState } = useForm<{ url: string; description: string; events: string[] }>({
    defaultValues: { url: '', description: '', events: ['check.completed'] },
  });

  const columns: Array<Column<WebhookEndpoint>> = [
    {
      id: 'url',
      header: 'Endpoint',
      sortValue: (w) => w.url,
      cell: (w) => (
        <div className="min-w-0">
          <p className="num truncate text-fg">{w.url}</p>
          {w.description ? <p className="truncate text-[11px] text-fg-muted">{w.description}</p> : null}
        </div>
      ),
    },
    {
      id: 'events',
      header: 'Events',
      cell: (w) => (
        <div className="flex flex-wrap gap-1">
          {w.events.slice(0, 3).map((event) => (
            <Badge key={event} tone="outline" mono>
              {event}
            </Badge>
          ))}
          {w.events.length > 3 ? <Badge tone="neutral">+{w.events.length - 3}</Badge> : null}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (w) => w.status,
      cell: (w) => (
        <Badge tone={w.status === 'active' ? 'ok' : w.failureCount > 0 ? 'major' : 'neutral'}>{w.status}</Badge>
      ),
    },
    {
      id: 'failures',
      header: 'Failures',
      align: 'right',
      sortValue: (w) => w.failureCount,
      cell: (w) => (
        <span className={w.failureCount > 0 ? 'num text-blocker-fg' : 'num text-fg-muted'}>{w.failureCount}</span>
      ),
    },
    {
      id: 'lastSuccess',
      header: 'Last success',
      align: 'right',
      cell: (w) => <span className="num text-fg-muted">{w.lastSuccessAt ? formatRelative(w.lastSuccessAt) : 'never'}</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      srOnlyHeader: true,
      cell: (w) => (
        <div className="flex justify-end gap-1">
          <Button size="xs" variant="outline" onClick={() => setInspecting(w)}>
            Deliveries
          </Button>
          {canManage ? (
            <Button size="xs" variant="ghost" onClick={() => setDeleting(w)}>
              Delete
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Webhooks"
        description="Delivered through a transactional outbox: never sent for a transaction that rolled back, never lost for one that committed."
        actions={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              Add endpoint
            </Button>
          ) : null
        }
      />

      <PageBody>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(w) => w.id}
          caption="Webhook endpoints"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          pageSize={25}
          empty={
            <EmptyState
              icon={Webhook}
              title="No webhook endpoints"
              description="Subscribe to check.completed to drive a generate → verify → fix loop without polling."
              actionLabel={canManage ? 'Add an endpoint' : undefined}
              onAction={() => setOpen(true)}
            />
          }
        />
      </PageBody>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Register a webhook"
        description="The signing secret is shown once. Verify X-BrandLens-Signature over timestamp.body."
        size="lg"
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
                void handleSubmit((values) =>
                  create.mutate(
                    { url: values.url, description: values.description || undefined, events: values.events },
                    {
                      onSuccess: (webhook) => {
                        setOpen(false);
                        reset();
                        setCreated(webhook);
                      },
                      onError: (mutationError) =>
                        toast({ title: 'Could not register', description: errorMessage(mutationError), tone: 'error' }),
                    },
                  ),
                )()
              }
            >
              Register
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="URL" htmlFor="hook-url" required error={formState.errors.url?.message}>
            <Input
              id="hook-url"
              type="url"
              mono
              autoFocus
              placeholder="https://example.com/hooks/brandlens"
              {...register('url', { required: 'A URL is required' })}
            />
          </Field>
          <Field label="Description" htmlFor="hook-desc">
            <Input id="hook-desc" {...register('description')} />
          </Field>
          <div>
            <Label required>Events</Label>
            <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto scroll-thin rounded-md border border-border p-2">
              {EVENT_TYPES.map((event) => (
                <label key={event} className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
                  <input type="checkbox" value={event} className="size-3.5 accent-[var(--accent)]" {...register('events')} />
                  <span className="num truncate">{event}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={created !== null}
        onClose={() => {
          setCreated(null);
          setCopied(false);
        }}
        title="Copy your signing secret"
        description="This is the only time it will be shown."
        dismissible={false}
        size="sm"
      >
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-fg">{created?.secret}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (!created?.secret) return;
              await navigator.clipboard.writeText(created.secret).catch(() => null);
              setCopied(true);
            }}
          >
            {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Dialog>

      {inspecting ? <DeliveriesDrawer endpoint={inspecting} onClose={() => setInspecting(null)} /> : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const endpoint = deleting;
          setDeleting(null);
          if (!endpoint) return;
          remove.mutate(endpoint.id, {
            onSuccess: () => toast({ title: 'Endpoint deleted', tone: 'success' }),
            onError: (mutationError) =>
              toast({ title: 'Delete failed', description: errorMessage(mutationError), tone: 'error' }),
          });
        }}
        title="Delete this endpoint?"
        description="Pending deliveries are dropped."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
      />
    </div>
  );
}

function DeliveriesDrawer({ endpoint, onClose }: { endpoint: WebhookEndpoint; onClose: () => void }) {
  const { data, isPending, isError, error, refetch } = useWebhookDeliveriesQuery(endpoint.id);

  return (
    <Drawer open onClose={onClose} title="Delivery attempts" description={endpoint.url}>
      {isPending ? (
        <p className="text-xs text-fg-muted">Loading deliveries…</p>
      ) : isError ? (
        <p className="text-xs text-blocker-fg">
          {errorMessage(error)}{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      ) : !data || data.length === 0 ? (
        <EmptyState compact title="No deliveries yet" description="Attempts appear once a subscribed event fires." />
      ) : (
        <ul className="space-y-1.5">
          {data.map((delivery) => (
            <li key={delivery.id} className="rounded-md border border-border p-2.5">
              <div className="flex items-center gap-2">
                <Badge tone={delivery.responseStatus && delivery.responseStatus < 300 ? 'ok' : 'blocker'} mono>
                  {delivery.responseStatus ?? 'error'}
                </Badge>
                <span className="num text-[11px] text-fg-muted">attempt {delivery.attempt}</span>
                <span className="num ml-auto text-[11px] text-fg-subtle">{formatDuration(delivery.durationMs)}</span>
              </div>
              {delivery.error ? <p className="mt-1 text-[11px] text-blocker-fg">{delivery.error}</p> : null}
              <p className="num mt-1 text-[10px] text-fg-subtle">{formatDateTime(delivery.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
