'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { UserPlus, Users } from 'lucide-react';
import type { Member } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import {
  useChangeMemberRoleMutation,
  useInviteMemberMutation,
  useMembersQuery,
  useRemoveMemberMutation,
} from '@/hooks/use-platform';
import { useSession } from '@/providers/session-provider';
import { hasRole, ROLE_LABEL } from '@/lib/auth-types';
import { errorMessage } from '@/lib/api-client';
import { formatDate, formatRelative } from '@/lib/format';

const ASSIGNABLE_ROLES = ['admin', 'brand_manager', 'reviewer', 'creator', 'viewer'];
const ALL_ROLES = ['owner', ...ASSIGNABLE_ROLES];

export function MembersView() {
  const user = useSession();
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useMembersQuery();
  const invite = useInviteMemberMutation();
  const changeRole = useChangeMemberRoleMutation();
  const remove = useRemoveMemberMutation();
  const canManage = hasRole(user.role, 'admin');

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState<Member | null>(null);

  const { register, handleSubmit, reset, formState } = useForm<{ email: string; role: string }>({
    defaultValues: { email: '', role: 'reviewer' },
  });

  const columns: Array<Column<Member>> = [
    {
      id: 'user',
      header: 'Member',
      sortValue: (m) => m.email,
      cell: (m) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{m.name ?? m.email}</p>
          {m.name ? <p className="num truncate text-fg-subtle">{m.email}</p> : null}
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (m) => m.role,
      cell: (m) =>
        canManage && m.role !== 'owner' && m.userId !== user.id ? (
          <Select
            className="h-7 w-40"
            value={m.role}
            aria-label={`Role for ${m.email}`}
            onChange={(event) =>
              changeRole.mutate(
                { userId: m.userId, role: event.target.value },
                {
                  onSuccess: () => toast({ title: 'Role updated', tone: 'success' }),
                  onError: (mutationError) =>
                    toast({ title: 'Role change failed', description: errorMessage(mutationError), tone: 'error' }),
                },
              )
            }
            options={ALL_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] ?? role }))}
          />
        ) : (
          <Badge tone={m.role === 'owner' ? 'accent' : 'outline'}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
        ),
    },
    {
      id: 'joined',
      header: 'Joined',
      align: 'right',
      sortValue: (m) => m.joinedAt,
      cell: (m) => <span className="num text-fg-muted">{formatDate(m.joinedAt)}</span>,
    },
    {
      id: 'lastLogin',
      header: 'Last seen',
      align: 'right',
      sortValue: (m) => m.lastLoginAt ?? '',
      cell: (m) => <span className="num text-fg-muted">{m.lastLoginAt ? formatRelative(m.lastLoginAt) : 'never'}</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      srOnlyHeader: true,
      cell: (m) =>
        canManage && m.role !== 'owner' && m.userId !== user.id ? (
          <Button size="xs" variant="ghost" onClick={() => setRemoving(m)}>
            Remove
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Members"
        description="Roles are an ordered ladder: a brand manager can do everything a reviewer can, and an owner everything below."
        actions={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-3.5" aria-hidden="true" />
              Invite member
            </Button>
          ) : null
        }
      />

      <PageBody>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(m) => m.userId}
          caption="Organization members"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          pageSize={25}
          empty={<EmptyState icon={Users} title="No members" description="Invite the people who will review findings." />}
        />
      </PageBody>

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite a member"
        description="They receive access to this organization only."
        size="sm"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={invite.isPending}
              onClick={() =>
                void handleSubmit((values) =>
                  invite.mutate(values, {
                    onSuccess: () => {
                      setInviteOpen(false);
                      reset();
                      toast({ title: 'Invitation sent', tone: 'success' });
                    },
                    onError: (mutationError) =>
                      toast({ title: 'Invite failed', description: errorMessage(mutationError), tone: 'error' }),
                  }),
                )()
              }
            >
              Send invite
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Email" htmlFor="invite-email" required error={formState.errors.email?.message}>
            <Input
              id="invite-email"
              type="email"
              autoFocus
              {...register('email', { required: 'Email is required' })}
            />
          </Field>
          <Field label="Role" htmlFor="invite-role" required>
            <Select
              id="invite-role"
              options={ASSIGNABLE_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] ?? role }))}
              {...register('role')}
            />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const member = removing;
          setRemoving(null);
          if (!member) return;
          remove.mutate(member.userId, {
            onSuccess: () => toast({ title: 'Member removed', tone: 'success' }),
            onError: (mutationError) =>
              toast({ title: 'Removal failed', description: errorMessage(mutationError), tone: 'error' }),
          });
        }}
        title={`Remove ${removing?.email ?? 'this member'}?`}
        description="Their recorded decisions stay in the audit trail; only their access is revoked."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
      />
    </div>
  );
}
