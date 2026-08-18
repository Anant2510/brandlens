'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { Ruleset } from '@/lib/types';

export function useRulesetsQuery(brandId: string | undefined) {
  return useQuery({
    queryKey: qk.rulesets.list(brandId ?? ''),
    queryFn: ({ signal }) => api.get<Ruleset[]>(`/v1/brands/${brandId}/rulesets`, undefined, signal),
    enabled: Boolean(brandId),
  });
}

export function useRulesetQuery(brandId: string | undefined, rulesetId: string | undefined) {
  return useQuery({
    queryKey: qk.rulesets.detail(brandId ?? '', rulesetId ?? ''),
    queryFn: ({ signal }) => api.get<Ruleset>(`/v1/brands/${brandId}/rulesets/${rulesetId}`, undefined, signal),
    enabled: Boolean(brandId && rulesetId),
    staleTime: Infinity, // A published ruleset is frozen by definition.
  });
}

export interface PublishRulesetBody {
  label?: string;
  scoringConfig?: {
    dimensionWeights?: Record<string, number>;
    passThreshold?: number;
    conditionalThreshold?: number;
  };
}

export function usePublishRulesetMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PublishRulesetBody) => api.post<Ruleset>(`/v1/brands/${brandId}/rulesets`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.rulesets.all(brandId) });
      void client.invalidateQueries({ queryKey: qk.brands.overview(brandId) });
      void client.invalidateQueries({ queryKey: qk.brands.detail(brandId) });
    },
  });
}
