'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { InheritedRule, Rule, RulePackSummary } from '@/lib/types';

export function useRulePacksQuery(brandId: string | undefined) {
  return useQuery({
    queryKey: qk.rulePacks.list(brandId ?? ''),
    queryFn: ({ signal }) => api.get<RulePackSummary[]>(`/v1/brands/${brandId}/rule-packs`, undefined, signal),
    enabled: Boolean(brandId),
  });
}

export function useInheritedRulesQuery(brandId: string | undefined) {
  return useQuery({
    queryKey: qk.rulePacks.inherited(brandId ?? ''),
    queryFn: ({ signal }) =>
      api.get<InheritedRule[]>(`/v1/brands/${brandId}/rule-packs/inherited-rules`, undefined, signal),
    enabled: Boolean(brandId),
  });
}

/**
 * Turning a pack on or off.
 *
 * Invalidates the rules and rulesets caches too, not just the pack list: a
 * pack going on or off changes which rules compile, so a stale rules table
 * beside a freshly-toggled pack would show two different answers to the same
 * question.
 */
export function useSetRulePackEnabledMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ packKey, enabled, reason }: { packKey: string; enabled: boolean; reason?: string }) =>
      api.put<RulePackSummary>(`/v1/brands/${brandId}/rule-packs/${packKey}`, { enabled, reason }),
    onSuccess: () => invalidateRuleSurfaces(client, brandId),
  });
}

export interface ForkTemplateBody {
  templateId: string;
  edits?: {
    statement?: string;
    rationale?: string;
    severity?: string;
    weight?: number;
    scope?: Record<string, unknown>;
    check?: { fn: string; params?: Record<string, unknown> };
    rubric?: Record<string, unknown> | null;
  };
}

export function useForkTemplateMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ForkTemplateBody) => api.post<Rule>(`/v1/brands/${brandId}/rule-packs/fork`, body),
    onSuccess: () => invalidateRuleSurfaces(client, brandId),
  });
}

function invalidateRuleSurfaces(client: ReturnType<typeof useQueryClient>, brandId: string): void {
  void client.invalidateQueries({ queryKey: qk.rulePacks.all(brandId) });
  void client.invalidateQueries({ queryKey: qk.rules.all(brandId) });
  void client.invalidateQueries({ queryKey: qk.rulesets.all(brandId) });
  void client.invalidateQueries({ queryKey: qk.brands.overview(brandId) });
}
