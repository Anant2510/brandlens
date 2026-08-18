'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { Brand, BrandOverview } from '@/lib/types';

export interface CreateBrandBody {
  name: string;
  slug: string;
  description?: string;
  positioning?: string;
  parentBrandId?: string;
}

export function useBrandsQuery() {
  return useQuery({
    queryKey: qk.brands.list(),
    queryFn: ({ signal }) => api.get<Brand[]>('/v1/brands', undefined, signal),
    staleTime: 60_000,
  });
}

export function useBrandQuery(brandId: string | undefined) {
  return useQuery({
    queryKey: qk.brands.detail(brandId ?? ''),
    queryFn: ({ signal }) => api.get<Brand>(`/v1/brands/${brandId}`, undefined, signal),
    enabled: Boolean(brandId),
  });
}

export function useBrandOverviewQuery(brandId: string | undefined) {
  return useQuery({
    queryKey: qk.brands.overview(brandId ?? ''),
    queryFn: ({ signal }) => api.get<BrandOverview>(`/v1/brands/${brandId}/overview`, undefined, signal),
    enabled: Boolean(brandId),
  });
}

export function useCreateBrandMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBrandBody) => api.post<Brand>('/v1/brands', body),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.brands.all }),
  });
}

export function useUpdateBrandMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Omit<CreateBrandBody, 'slug'>>) => api.patch<Brand>(`/v1/brands/${brandId}`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.brands.all });
    },
  });
}
