'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type { Paginated, Review, ReviewDetail } from '@/lib/types';
import type { DecisionBody } from './use-findings';

export interface ReviewFilters {
  state?: string;
  stage?: string;
  assignedToUserId?: string;
  assetId?: string;
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

export function useReviewsQuery(filters: ReviewFilters = {}) {
  return useQuery({
    queryKey: qk.reviews.list(filters),
    queryFn: ({ signal }) => api.get<Paginated<Review>>('/v1/reviews', { ...filters }, signal),
  });
}

export function useReviewQuery(reviewId: string | undefined) {
  return useQuery({
    queryKey: qk.reviews.detail(reviewId ?? ''),
    queryFn: ({ signal }) => api.get<ReviewDetail>(`/v1/reviews/${reviewId}`, undefined, signal),
    enabled: Boolean(reviewId),
  });
}

export function useCreateReviewMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { assetId: string; checkRunId?: string; stage?: string; assignedToUserId?: string; dueAt?: string }) =>
      api.post<Review>('/v1/reviews', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.reviews.all });
    },
  });
}

export function useAssignReviewMutation(reviewId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (assigneeUserId: string) => api.post<Review>(`/v1/reviews/${reviewId}/assign`, { assigneeUserId }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.reviews.all });
    },
  });
}

export function useReviewDecisionMutation(reviewId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DecisionBody & { findingId?: string; traceId?: string }) =>
      api.post(`/v1/reviews/${reviewId}/decision`, body),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.reviews.detail(reviewId) });
      void client.invalidateQueries({ queryKey: qk.findings.all });
    },
  });
}

export function useSubmitReviewMutation(reviewId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { state: 'approved' | 'rejected' | 'changes_requested'; summary?: string }) =>
      api.post<Review>(`/v1/reviews/${reviewId}/submit`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.reviews.all });
    },
  });
}
