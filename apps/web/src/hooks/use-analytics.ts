'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardSummary, RuleHealthRow } from '@brandlens/contracts';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { CostReport, CoverageReport } from '@/lib/types';

export interface AnalyticsFilters {
  brandId?: string;
  from?: string;
  to?: string;
  granularity?: 'day' | 'week' | 'month';
}

export function useDashboardSummaryQuery(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: qk.analytics.summary(filters),
    queryFn: ({ signal }) => api.get<DashboardSummary>('/v1/analytics/summary', { ...filters }, signal),
  });
}

export function useRuleHealthQuery(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: qk.analytics.ruleHealth(filters),
    queryFn: ({ signal }) => api.get<RuleHealthRow[]>('/v1/analytics/rule-health', { ...filters }, signal),
  });
}

export function useCostReportQuery(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: qk.analytics.cost(filters),
    queryFn: ({ signal }) => api.get<CostReport>('/v1/analytics/cost', { ...filters }, signal),
  });
}

export function useCoverageReportQuery(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: qk.analytics.coverage(filters),
    queryFn: ({ signal }) => api.get<CoverageReport>('/v1/analytics/coverage', { ...filters }, signal),
  });
}
