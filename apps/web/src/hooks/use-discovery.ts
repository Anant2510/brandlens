'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscoveredPageDTO, DiscoveryOptions, DiscoveryRunDTO } from '@brandlens/contracts';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';

export function useDiscoveryRunsQuery() {
  return useQuery({
    queryKey: qk.discovery.list,
    queryFn: ({ signal }) => api.get<DiscoveryRunDTO[]>('/v1/discovery', undefined, signal),
  });
}

/**
 * Polls while a run is in flight, then stops.
 *
 * Two seconds rather than the three used elsewhere: discovery moves through
 * five visible stages and a progress bar that updates twice a stage reads as
 * broken. It stops entirely on a terminal status, so a finished report costs
 * nothing to leave open on a second monitor.
 */
export function useDiscoveryRunQuery(id: string | undefined) {
  return useQuery({
    queryKey: qk.discovery.run(id ?? ''),
    queryFn: ({ signal }) => api.get<DiscoveryRunDTO>(`/v1/discovery/${id}`, undefined, signal),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 2000 : false;
    },
  });
}

export function useDiscoveryPagesQuery(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.discovery.pages(id ?? ''),
    queryFn: ({ signal }) => api.get<DiscoveredPageDTO[]>(`/v1/discovery/${id}/pages`, undefined, signal),
    enabled: Boolean(id) && enabled,
  });
}

export function useStartDiscoveryMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; options?: Partial<DiscoveryOptions> }) =>
      api.post<DiscoveryRunDTO>('/v1/discovery', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.discovery.list });
    },
  });
}

export function useCancelDiscoveryMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<DiscoveryRunDTO>(`/v1/discovery/${id}/cancel`),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: qk.discovery.run(run.id) });
      void client.invalidateQueries({ queryKey: qk.discovery.list });
    },
  });
}
