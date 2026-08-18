'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { BulkRuleDecisionResult, Rule } from '@/lib/types';

export interface RuleFilters {
  status?: string;
  dimension?: string;
  tier?: string;
  provenance?: string;
  search?: string;
}

export function useRulesQuery(brandId: string | undefined, filters: RuleFilters = {}) {
  return useQuery({
    queryKey: qk.rules.list(brandId ?? '', filters),
    queryFn: ({ signal }) => api.get<Rule[]>(`/v1/brands/${brandId}/rules`, { ...filters }, signal),
    enabled: Boolean(brandId),
  });
}

export function useRuleHistoryQuery(brandId: string | undefined, ruleKey: string | undefined) {
  return useQuery({
    queryKey: qk.rules.history(brandId ?? '', ruleKey ?? ''),
    queryFn: ({ signal }) => api.get<Rule[]>(`/v1/brands/${brandId}/rules/history/${ruleKey}`, undefined, signal),
    enabled: Boolean(brandId && ruleKey),
  });
}

export interface UpdateRuleBody {
  statement?: string;
  rationale?: string;
  severity?: string;
  weight?: number;
  status?: string;
  check?: { fn: string; params: Record<string, unknown> };
  scope?: Record<string, unknown>;
}

export function useUpdateRuleMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, body }: { ruleId: string; body: UpdateRuleBody }) =>
      api.patch<Rule>(`/v1/brands/${brandId}/rules/${ruleId}`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.rules.all(brandId) });
      void client.invalidateQueries({ queryKey: qk.brands.overview(brandId) });
    },
  });
}

export function useCreateRuleMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Rule>(`/v1/brands/${brandId}/rules`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.rules.all(brandId) });
      void client.invalidateQueries({ queryKey: qk.brands.overview(brandId) });
    },
  });
}

export type BulkRuleAction = 'activate' | 'reject' | 'deprecate';

/**
 * Bulk activation is the human act that turns proposals into policy. It is
 * optimistically reflected so a 60-rule confirmation session stays fluid,
 * then reconciled against the server response.
 */
export function useBulkRuleDecisionMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleIds, action, note }: { ruleIds: string[]; action: BulkRuleAction; note?: string }) =>
      api.post<BulkRuleDecisionResult>(`/v1/brands/${brandId}/rules/bulk-decision`, { ruleIds, action, note }),
    onMutate: async ({ ruleIds, action }) => {
      await client.cancelQueries({ queryKey: qk.rules.all(brandId) });
      const snapshot = client.getQueriesData<Rule[]>({ queryKey: qk.rules.all(brandId) });
      const nextStatus = action === 'activate' ? 'active' : action === 'reject' ? 'rejected' : 'deprecated';
      const targets = new Set(ruleIds);
      snapshot.forEach(([key, rules]) => {
        if (!rules) return;
        client.setQueryData<Rule[]>(
          key,
          rules.map((rule) => (targets.has(rule.id) ? { ...rule, status: nextStatus as Rule['status'] } : rule)),
        );
      });
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      context?.snapshot.forEach(([key, rules]) => client.setQueryData(key, rules));
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.rules.all(brandId) });
      void client.invalidateQueries({ queryKey: qk.brands.overview(brandId) });
    },
  });
}
