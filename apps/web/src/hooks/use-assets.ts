'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { Asset, AssetDerivative, AssetUploadResult, Paginated } from '@/lib/types';

export interface AssetFilters {
  brandId?: string;
  status?: string;
  kind?: string;
  variantFamilyId?: string;
  isApprovedExemplar?: boolean;
  page?: number;
  pageSize?: number;
}

export function useAssetsQuery(filters: AssetFilters = {}) {
  return useQuery({
    queryKey: qk.assets.list(filters),
    queryFn: ({ signal }) => api.get<Paginated<Asset>>('/v1/assets', { ...filters }, signal),
  });
}

export function useAssetQuery(assetId: string | undefined) {
  return useQuery({
    queryKey: qk.assets.detail(assetId ?? ''),
    queryFn: ({ signal }) => api.get<Asset>(`/v1/assets/${assetId}`, undefined, signal),
    enabled: Boolean(assetId),
    // Ingestion is asynchronous; poll until the asset leaves the pipeline.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && status !== 'ready' && status !== 'failed' ? 4000 : false;
    },
  });
}

export function useAssetDerivativesQuery(assetId: string | undefined) {
  return useQuery({
    queryKey: qk.assets.derivatives(assetId ?? ''),
    queryFn: ({ signal }) => api.get<AssetDerivative[]>(`/v1/assets/${assetId}/derivatives`, undefined, signal),
    enabled: Boolean(assetId),
  });
}

export function useUploadAssetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.post<AssetUploadResult>('/v1/assets', form),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.assets.all });
    },
  });
}

export function useDeleteAssetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => api.del<{ id: string; deleted: boolean }>(`/v1/assets/${assetId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.assets.all });
    },
  });
}
