'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { AssemblyPlan, Brief, BriefDetail } from '@/lib/types';

export function useBriefsQuery(brandId?: string) {
  return useQuery({
    queryKey: qk.assemble.list(brandId),
    queryFn: ({ signal }) => api.get<Brief[]>('/v1/briefs', { brandId }, signal),
  });
}

export function useBriefQuery(briefId: string | undefined) {
  return useQuery({
    queryKey: qk.assemble.detail(briefId ?? ''),
    queryFn: ({ signal }) => api.get<BriefDetail>(`/v1/briefs/${briefId}`, undefined, signal),
    enabled: Boolean(briefId),
  });
}

export interface CreateBriefBody {
  brandId: string;
  title: string;
  objective?: string;
  keyMessage?: string;
  mandatories?: string[];
  targets: Array<{ platform: string; placement: string; assetType: string; count: number; market?: string }>;
}

export function useCreateBriefMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBriefBody) => api.post<Brief>('/v1/briefs', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.assemble.all });
    },
  });
}

export function useAssembleBriefMutation(briefId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AssemblyPlan>(`/v1/briefs/${briefId}/assemble`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.assemble.detail(briefId) });
    },
  });
}
