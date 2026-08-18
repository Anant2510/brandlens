-- ===========================================================================
-- BrandLens · vector acceleration (optional)
--
-- Runs only when pgvector is present. Adds a `vec_p vector(N)` shadow column
-- to `embeddings`, keeps it in sync with the portable real[] column via
-- trigger, and builds an HNSW index. When pgvector is absent this file is a
-- no-op and the fallback cosine path is used instead — same schema either way.
-- ===========================================================================

DO $$
DECLARE
  has_vector boolean;
  dim int := COALESCE(NULLIF(current_setting('brandlens.embedding_dim', true), '')::int, 1024);
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO has_vector;

  IF NOT has_vector THEN
    RAISE NOTICE 'BrandLens: pgvector not installed — skipping ANN index setup.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'embeddings' AND column_name = 'vec_p'
  ) THEN
    EXECUTE format('ALTER TABLE public.embeddings ADD COLUMN vec_p vector(%s)', dim);
  END IF;

  -- Keep the accelerated column in lockstep with the portable one.
  CREATE OR REPLACE FUNCTION brandlens_sync_vec_p()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF NEW.vec IS NOT NULL THEN
      BEGIN
        NEW.vec_p := NEW.vec::text::vector;
      EXCEPTION WHEN OTHERS THEN
        -- Dimension mismatch (e.g. mid-migration between embedding models):
        -- leave vec_p null and let the fallback path serve the query.
        NEW.vec_p := NULL;
      END;
    END IF;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS embeddings_sync_vec_p ON public.embeddings;
  CREATE TRIGGER embeddings_sync_vec_p
    BEFORE INSERT OR UPDATE OF vec ON public.embeddings
    FOR EACH ROW EXECUTE FUNCTION brandlens_sync_vec_p();

  -- Index leads with tenant filtering in the query plan via the partial
  -- predicate on space; org_id filtering comes from RLS + the btree below.
  EXECUTE 'CREATE INDEX IF NOT EXISTS embeddings_vec_p_hnsw
           ON public.embeddings USING hnsw (vec_p vector_cosine_ops)
           WITH (m = 16, ef_construction = 64)';

  RAISE NOTICE 'BrandLens: pgvector HNSW index ready (dim=%).', dim;
END $$;

-- Always useful, with or without pgvector: tenant-leading btree so the
-- pre-filter is cheap before any distance computation.
CREATE INDEX IF NOT EXISTS embeddings_lookup_idx
  ON public.embeddings (org_id, space, owner_type, model_id);
