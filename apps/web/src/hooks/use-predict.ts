'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { AudiencePanel, Prediction } from '@/lib/types';

export function usePanelsQuery(brandId?: string) {
  return useQuery({
    queryKey: qk.predict.panels(brandId),
    queryFn: ({ signal }) => api.get<AudiencePanel[]>('/v1/panels', { brandId }, signal),
  });
}

export interface CreatePanelBody {
  brandId?: string;
  name: string;
  personas: Array<Record<string, unknown>>;
}

export function useCreatePanelMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePanelBody) => api.post<AudiencePanel>('/v1/panels', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['panels'] });
    },
  });
}

export function usePredictionQuery(predictionId: string | undefined) {
  return useQuery({
    queryKey: qk.predict.prediction(predictionId ?? ''),
    queryFn: ({ signal }) => api.get<Prediction>(`/v1/predictions/${predictionId}`, undefined, signal),
    enabled: Boolean(predictionId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 3000 : false;
    },
  });
}

export function useCreatePredictionMutation() {
  return useMutation({
    mutationFn: (body: { assetId: string; panelId?: string; comparisonAssetIds?: string[] }) =>
      api.post<Prediction>('/v1/predictions', body),
  });
}
