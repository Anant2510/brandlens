-- ===========================================================================
-- BrandLens · row-level security
--
-- Shared-schema multi-tenancy enforced by Postgres, not by application code.
--   * every tenant table carries org_id
--   * every policy keys on current_setting('app.tenant_id')
--   * FORCE ROW LEVEL SECURITY is essential — the table OWNER bypasses RLS by
--     default, which is a classic silent hole
--   * app.bypass_rls is an explicit, auditable escape hatch for migrations,
--     the queue relay and cross-tenant admin jobs
-- ===========================================================================

CREATE OR REPLACE FUNCTION brandlens_current_tenant()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION brandlens_rls_bypassed()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true), 'off') = 'on';
$$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'brands', 'markets', 'design_tokens', 'logo_variants', 'type_styles',
    'forbidden_fonts', 'voice_attributes', 'lexicon_terms', 'claims',
    'disclaimers', 'image_style_profiles', 'rules', 'rulesets',
    'brand_documents', 'brand_document_chunks',
    'campaigns', 'variant_families', 'assets', 'asset_derivatives',
    'embeddings', 'asset_measurements',
    'check_runs', 'decision_traces', 'findings', 'reviews',
    'review_decisions', 'precedents', 'rule_calibrations',
    'briefs', 'assembly_plans', 'audience_panels', 'predictions',
    'webhook_endpoints', 'webhook_deliveries', 'outbox_events',
    'api_keys', 'cost_ledger', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'BrandLens RLS: skipping missing table %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        USING (
          brandlens_rls_bypassed()
          OR org_id = brandlens_current_tenant()
        )
        WITH CHECK (
          brandlens_rls_bypassed()
          OR org_id = brandlens_current_tenant()
        )
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- brand_document_chunks and channel_specs need bespoke handling ------------

-- Global channel-spec rows (org_id IS NULL) are readable by every tenant;
-- tenant overrides are private.
DO $$
BEGIN
  IF to_regclass('public.channel_specs') IS NOT NULL THEN
    ALTER TABLE public.channel_specs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.channel_specs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS channel_specs_tenant_isolation ON public.channel_specs;
    CREATE POLICY channel_specs_tenant_isolation ON public.channel_specs
      USING (
        brandlens_rls_bypassed()
        OR org_id IS NULL
        OR org_id = brandlens_current_tenant()
      )
      WITH CHECK (
        brandlens_rls_bypassed()
        OR org_id = brandlens_current_tenant()
      );
  END IF;

  IF to_regclass('public.result_cache') IS NOT NULL THEN
    ALTER TABLE public.result_cache ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.result_cache FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS result_cache_tenant_isolation ON public.result_cache;
    CREATE POLICY result_cache_tenant_isolation ON public.result_cache
      USING (
        brandlens_rls_bypassed()
        OR org_id IS NULL
        OR org_id = brandlens_current_tenant()
      )
      WITH CHECK (
        brandlens_rls_bypassed()
        OR org_id IS NULL
        OR org_id = brandlens_current_tenant()
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Decision traces and the audit log are append-only. Revoking UPDATE/DELETE
-- at the grant level is what makes "immutable trail" a claim we can defend in
-- a compliance review rather than a promise in the UI.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.decision_traces') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON public.decision_traces FROM PUBLIC;
  END IF;
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON public.audit_log FROM PUBLIC;
  END IF;
END $$;
