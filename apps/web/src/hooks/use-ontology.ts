'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from './query-keys';
import type {
  BrandDocument,
  Claim,
  DesignToken,
  Disclaimer,
  DocumentChunk,
  LexiconTerm,
  LogoVariant,
  TypeStyle,
  VoiceAttribute,
} from '@/lib/types';

function ontologyQuery<T>(brandId: string | undefined, resource: string, enabled = true) {
  return {
    queryKey: qk.ontology.resource(brandId ?? '', resource),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.get<T>(`/v1/brands/${brandId}/${resource}`, undefined, signal),
    enabled: Boolean(brandId) && enabled,
  };
}

export function useTokensQuery(brandId: string | undefined, enabled = true) {
  return useQuery(ontologyQuery<DesignToken[]>(brandId, 'tokens', enabled));
}

export function useLogosQuery(brandId: string | undefined, enabled = true) {
  return useQuery(ontologyQuery<LogoVariant[]>(brandId, 'logos', enabled));
}

export function useTypeStylesQuery(brandId: string | undefined, enabled = true) {
  return useQuery(ontologyQuery<TypeStyle[]>(brandId, 'type-styles', enabled));
}

export function useVoiceQuery(brandId: string | undefined, enabled = true) {
  return useQuery(ontologyQuery<VoiceAttribute[]>(brandId, 'voice', enabled));
}

export function useLexiconQuery(brandId: string | undefined, enabled = true) {
  return useQuery(ontologyQuery<LexiconTerm[]>(brandId, 'lexicon', enabled));
}

export function useClaimsQuery(brandId: string | undefined, enabled = true) {
  return useQuery(ontologyQuery<Claim[]>(brandId, 'claims', enabled));
}

export function useDisclaimersQuery(brandId: string | undefined, enabled = true) {
  return useQuery(ontologyQuery<Disclaimer[]>(brandId, 'disclaimers', enabled));
}

export function useDocumentsQuery(brandId: string | undefined) {
  return useQuery({
    ...ontologyQuery<BrandDocument[]>(brandId, 'documents'),
    // Extraction is a background job; keep the status column honest.
    refetchInterval: (query) => {
      const docs = query.state.data;
      const busy = docs?.some((d) => d.status === 'queued' || d.status === 'processing' || d.status === 'parsing');
      return busy ? 5000 : false;
    },
  });
}

export function useDocumentChunksQuery(brandId: string | undefined, docId: string | undefined) {
  return useQuery({
    queryKey: qk.ontology.documentChunks(brandId ?? '', docId ?? ''),
    queryFn: ({ signal }) =>
      api.get<DocumentChunk[]>(`/v1/brands/${brandId}/documents/${docId}/chunks`, undefined, signal),
    enabled: Boolean(brandId && docId),
  });
}

export function useUploadDocumentMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.post<BrandDocument>(`/v1/brands/${brandId}/documents`, form),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.ontology.resource(brandId, 'documents') });
    },
  });
}

export function useExtractDocumentMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) =>
      api.post<{ documentId: string; status: string; message: string }>(
        `/v1/brands/${brandId}/documents/${docId}/extract`,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.ontology.resource(brandId, 'documents') });
      void client.invalidateQueries({ queryKey: qk.rules.all(brandId) });
    },
  });
}

export interface InduceRulesBody {
  dimensions?: string[];
  minSampleSize?: number;
  percentile?: number;
}

export function useInduceRulesMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: InduceRulesBody = {}) =>
      api.post<{ brandId: string; status: string; message: string }>(`/v1/brands/${brandId}/induce-rules`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.rules.all(brandId) });
    },
  });
}

export interface UpsertTokenBody {
  path: string;
  type: string;
  value: unknown;
  description?: string;
  hex?: string;
  role?: string;
  allowedTints?: number[];
}

export function useUpsertTokenMutation(brandId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertTokenBody) => api.post<DesignToken>(`/v1/brands/${brandId}/tokens`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.ontology.resource(brandId, 'tokens') });
      void client.invalidateQueries({ queryKey: qk.brands.overview(brandId) });
    },
  });
}
