'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type {
  ApiKey,
  AuditEntry,
  ChannelSpec,
  CreatedApiKey,
  CreatedWebhook,
  Member,
  OrganizationSettings,
  Paginated,
  WebhookDelivery,
  WebhookEndpoint,
} from '@/lib/types';

/* --- members ------------------------------------------------------------- */
export function useMembersQuery() {
  return useQuery({
    queryKey: qk.platform.members,
    queryFn: ({ signal }) => api.get<Member[]>('/v1/members', undefined, signal),
  });
}

export function useInviteMemberMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: string }) => api.post<Member>('/v1/members/invite', body),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.members }),
  });
}

export function useChangeMemberRoleMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch<Member>(`/v1/members/${userId}/role`, { role }),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.members }),
  });
}

export function useRemoveMemberMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.del<{ removed: boolean }>(`/v1/members/${userId}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.members }),
  });
}

/* --- organization -------------------------------------------------------- */
export function useOrganizationQuery() {
  return useQuery({
    queryKey: qk.platform.organization,
    queryFn: ({ signal }) => api.get<OrganizationSettings>('/v1/organization', undefined, signal),
  });
}

export function useUpdateOrganizationMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; dailyUsdLimit?: number; settings?: Record<string, unknown> }) =>
      api.patch<OrganizationSettings>('/v1/organization', body),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.organization }),
  });
}

/* --- api keys ------------------------------------------------------------ */
export function useApiKeysQuery() {
  return useQuery({
    queryKey: qk.platform.apiKeys,
    queryFn: ({ signal }) => api.get<ApiKey[]>('/v1/api-keys', undefined, signal),
  });
}

export function useCreateApiKeyMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; scopes: string[]; expiresInDays?: number }) =>
      api.post<CreatedApiKey>('/v1/api-keys', body),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.apiKeys }),
  });
}

export function useRevokeApiKeyMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ id: string; revoked: boolean }>(`/v1/api-keys/${id}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.apiKeys }),
  });
}

/* --- webhooks ------------------------------------------------------------ */
export function useWebhooksQuery() {
  return useQuery({
    queryKey: qk.platform.webhooks,
    queryFn: ({ signal }) => api.get<WebhookEndpoint[]>('/v1/webhooks', undefined, signal),
  });
}

export function useCreateWebhookMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; description?: string; events: string[] }) =>
      api.post<CreatedWebhook>('/v1/webhooks', body),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.webhooks }),
  });
}

export function useDeleteWebhookMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ id: string; deleted: boolean }>(`/v1/webhooks/${id}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.platform.webhooks }),
  });
}

export function useWebhookDeliveriesQuery(endpointId: string | undefined) {
  return useQuery({
    queryKey: qk.platform.webhookDeliveries(endpointId ?? ''),
    queryFn: ({ signal }) => api.get<WebhookDelivery[]>(`/v1/webhooks/${endpointId}/deliveries`, undefined, signal),
    enabled: Boolean(endpointId),
  });
}

/* --- audit log ----------------------------------------------------------- */
export interface AuditFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function useAuditLogQuery(filters: AuditFilters = {}) {
  return useQuery({
    queryKey: qk.platform.auditLog(filters),
    queryFn: ({ signal }) => api.get<Paginated<AuditEntry>>('/v1/audit-log', { ...filters }, signal),
  });
}

/* --- channel specs ------------------------------------------------------- */
export function useChannelSpecsQuery(filters: { platform?: string; placement?: string; assetType?: string } = {}) {
  return useQuery({
    queryKey: qk.platform.channelSpecs(filters),
    queryFn: ({ signal }) => api.get<ChannelSpec[]>('/v1/channel-specs', { ...filters }, signal),
    staleTime: 5 * 60_000,
  });
}
