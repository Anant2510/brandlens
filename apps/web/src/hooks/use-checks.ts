'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CheckRunDetail, CheckRunSummary } from '@brandlens/contracts';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { CreateCheckResult, Paginated, RawTrace } from '@/lib/types';

export interface CheckFilters {
  brandId?: string;
  assetId?: string;
  status?: string;
  scoreBand?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function useChecksQuery(filters: CheckFilters = {}) {
  return useQuery({
    queryKey: qk.checks.list(filters),
    queryFn: ({ signal }) => api.get<Paginated<CheckRunSummary>>('/v1/checks', { ...filters }, signal),
  });
}

/**
 * A queued or running check is polled until it settles. Once completed the
 * result is immutable, so polling stops rather than burning a request a second.
 */
export function useCheckRunQuery(checkRunId: string | undefined) {
  return useQuery({
    queryKey: qk.checks.detail(checkRunId ?? ''),
    queryFn: ({ signal }) => api.get<CheckRunDetail>(`/v1/checks/${checkRunId}`, undefined, signal),
    enabled: Boolean(checkRunId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 3000 : false;
    },
  });
}

export function useCheckTracesQuery(checkRunId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.checks.traces(checkRunId ?? ''),
    queryFn: ({ signal }) => api.get<RawTrace[]>(`/v1/checks/${checkRunId}/traces`, undefined, signal),
    enabled: Boolean(checkRunId) && enabled,
  });
}

export interface CreateCheckBody {
  assetId?: string;
  brandId?: string;
  rulesetId?: string;
  dimensions?: string[];
  deterministicOnly?: boolean;
  async?: boolean;
  force?: boolean;
}

export function useCreateCheckMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCheckBody) => api.post<CreateCheckResult>('/v1/checks', { async: true, ...body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.checks.all });
    },
  });
}

export function useRerunCheckMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (checkRunId: string) => api.post<CreateCheckResult>(`/v1/checks/${checkRunId}/rerun`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.checks.all });
    },
  });
}
