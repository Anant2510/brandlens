-- ===========================================================================
-- BrandLens · bootstrap extensions
--
-- Written to run on a plain PostgreSQL install (including the EnterpriseDB
-- Windows installer) with no Docker and no compiler toolchain. pgvector is
-- attempted but never required: the vector layer falls back to real[] plus an
-- in-SQL cosine implementation when the extension is unavailable.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
    RAISE NOTICE 'BrandLens: pgvector enabled — ANN indexes will be used.';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'BrandLens: pgvector unavailable (%). Falling back to real[] cosine similarity.', SQLERRM;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Portable cosine similarity over real[]. Used by the fallback vector driver.
-- IMMUTABLE + PARALLEL SAFE so the planner can push it into parallel scans.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brandlens_cosine_similarity(a real[], b real[])
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  dot   double precision := 0;
  norm_a double precision := 0;
  norm_b double precision := 0;
  n int;
  i int;
BEGIN
  IF a IS NULL OR b IS NULL THEN
    RETURN NULL;
  END IF;

  n := least(array_length(a, 1), array_length(b, 1));
  IF n IS NULL OR n = 0 THEN
    RETURN NULL;
  END IF;

  FOR i IN 1..n LOOP
    dot    := dot + (a[i]::double precision * b[i]::double precision);
    norm_a := norm_a + (a[i]::double precision * a[i]::double precision);
    norm_b := norm_b + (b[i]::double precision * b[i]::double precision);
  END LOOP;

  IF norm_a = 0 OR norm_b = 0 THEN
    RETURN 0;
  END IF;

  RETURN dot / (sqrt(norm_a) * sqrt(norm_b));
END;
$$;

CREATE OR REPLACE FUNCTION brandlens_cosine_distance(a real[], b real[])
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 1 - brandlens_cosine_similarity(a, b);
$$;

-- Touch trigger shared by every table with updated_at.
CREATE OR REPLACE FUNCTION brandlens_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
