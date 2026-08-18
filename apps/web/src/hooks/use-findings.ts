'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CheckRunDetail, FindingDTO } from '@brandlens/contracts';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { DecisionResult, FindingExplain, Paginated } from '@/lib/types';

export interface FindingFilters {
  brandId?: string;
  assetId?: string;
  checkRunId?: string;
  ruleKey?: string;
  severity?: string;
  status?: string;
  highConfidenceOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export function useFindingsQuery(filters: FindingFilters = {}) {
  return useQuery({
    queryKey: qk.findings.list(filters),
    queryFn: ({ signal }) => api.get<Paginated<FindingDTO>>('/v1/findings', { ...filters }, signal),
  });
}

export function useFindingExplainQuery(findingId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.findings.explain(findingId ?? ''),
    queryFn: ({ signal }) => api.get<FindingExplain>(`/v1/findings/${findingId}/explain`, undefined, signal),
    enabled: Boolean(findingId) && enabled,
  });
}

export type DecisionAction = 'confirm' | 'override_pass' | 'override_fail' | 'waive' | 'escalate' | 'comment';

export interface DecisionBody {
  action: DecisionAction;
  rationale?: string;
  annotationBbox?: number[];
  isCalibrationLabel?: boolean;
}

const NEXT_STATUS: Record<DecisionAction, FindingDTO['status'] | null> = {
  confirm: 'confirmed',
  override_pass: 'overridden',
  override_fail: 'confirmed',
  waive: 'waived',
  escalate: null,
  comment: null,
};

/**
 * Records a human decision on a finding.
 *
 * Optimistic because a reviewer working a queue must not wait on a round trip
 * per verdict; rolled back verbatim on failure so the UI never lies about what
 * the audit trail contains.
 */
export function useFindingDecisionMutation(checkRunId?: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ findingId, body }: { findingId: string; body: DecisionBody }) =>
      api.post<DecisionResult>(`/v1/findings/${findingId}/decision`, body),

    onMutate: async ({ findingId, body }) => {
      if (!checkRunId) return { previous: undefined };
      const key = qk.checks.detail(checkRunId);
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<CheckRunDetail>(key);
      const status = NEXT_STATUS[body.action];
      if (previous && status) {
        client.setQueryData<CheckRunDetail>(key, {
          ...previous,
          findings: previous.findings.map((f) => (f.id === findingId ? { ...f, status } : f)),
        });
      }
      return { previous };
    },

    onError: (_error, _variables, context) => {
      if (checkRunId && context?.previous) client.setQueryData(qk.checks.detail(checkRunId), context.previous);
    },

    onSettled: (_data, _error, variables) => {
      if (checkRunId) void client.invalidateQueries({ queryKey: qk.checks.detail(checkRunId) });
      void client.invalidateQueries({ queryKey: qk.findings.all });
      void client.invalidateQueries({ queryKey: qk.findings.explain(variables.findingId) });
      void client.invalidateQueries({ queryKey: qk.analytics.all });
    },
  });
}
