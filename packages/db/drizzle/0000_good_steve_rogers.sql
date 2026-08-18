CREATE TYPE "public"."asset_kind" AS ENUM('image', 'video', 'pdf', 'html', 'figma', 'pptx', 'psd', 'copy');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('uploading', 'ingested', 'analyzing', 'analyzed', 'failed', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."brief_status" AS ENUM('draft', 'planned', 'assembling', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."check_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled', 'degraded');--> statement-breakpoint
CREATE TYPE "public"."check_tier" AS ENUM('deterministic', 'cv', 'vlm', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'confirmed', 'overridden', 'waived', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."job_pool" AS ENUM('cpu_media', 'llm_io', 'default');--> statement-breakpoint
CREATE TYPE "public"."logo_variant_kind" AS ENUM('primary', 'horizontal_lockup', 'stacked_lockup', 'monochrome_black', 'monochrome_white', 'knockout', 'icon_only', 'wordmark_only', 'cobrand_lockup');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'brand_manager', 'reviewer', 'creator', 'viewer', 'service');--> statement-breakpoint
CREATE TYPE "public"."org_plan" AS ENUM('free', 'team', 'business', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'dispatched', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."prediction_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_action" AS ENUM('confirm', 'override_pass', 'override_fail', 'waive', 'escalate', 'comment');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('pending', 'in_review', 'changes_requested', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."rule_dimension" AS ENUM('logo', 'color', 'typography', 'layout', 'imagery', 'copy', 'accessibility', 'channel_spec', 'legal');--> statement-breakpoint
CREATE TYPE "public"."rule_provenance" AS ENUM('deductive', 'inductive', 'transfer', 'manual');--> statement-breakpoint
CREATE TYPE "public"."rule_status" AS ENUM('proposed', 'active', 'deprecated', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('blocker', 'major', 'minor', 'advisory');--> statement-breakpoint
CREATE TYPE "public"."source_fidelity" AS ENUM('structured', 'raster', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."token_type" AS ENUM('color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'number', 'shadow', 'typography', 'other');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('pass', 'fail', 'not_applicable', 'insufficient_evidence', 'abstained');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('active', 'paused', 'disabled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"prefix" varchar(24) NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"actor_user_id" uuid,
	"actor_api_key_id" uuid,
	"action" varchar(120) NOT NULL,
	"entity_type" varchar(80) NOT NULL,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"check_run_id" uuid,
	"provider" varchar(60) NOT NULL,
	"model" varchar(120) NOT NULL,
	"operation" varchar(60) NOT NULL,
	"input_tokens" text DEFAULT '0' NOT NULL,
	"cached_input_tokens" text DEFAULT '0' NOT NULL,
	"output_tokens" text DEFAULT '0' NOT NULL,
	"image_count" text DEFAULT '0' NOT NULL,
	"cost_usd" text DEFAULT '0' NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"latency_ms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"plan" "org_plan" DEFAULT 'free' NOT NULL,
	"daily_usd_limit" text DEFAULT '25' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(200),
	"password_hash" text,
	"avatar_url" text,
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text,
	"text" text NOT NULL,
	"bbox" real[],
	"image_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(300) NOT NULL,
	"kind" varchar(60) DEFAULT 'brandbook' NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"mime_type" varchar(100),
	"page_count" integer,
	"status" varchar(40) DEFAULT 'uploaded' NOT NULL,
	"extraction_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_brand_id" uuid,
	"name" varchar(200) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"description" text,
	"positioning" text,
	"active_ruleset_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"text" text NOT NULL,
	"variants" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"category" varchar(80),
	"substantiation_ref" text,
	"substantiation_url" text,
	"jurisdictions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"required_disclaimer_id" uuid,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"path" varchar(300) NOT NULL,
	"type" "token_type" NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"hex" varchar(9),
	"lab_l" real,
	"lab_a" real,
	"lab_b" real,
	"role" varchar(40),
	"allowed_tints" integer[],
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" varchar(40) DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disclaimers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"text" text NOT NULL,
	"market_codes" text[],
	"channels" text[],
	"min_font_size_pt" real DEFAULT 8,
	"min_contrast_ratio" real DEFAULT 4.5,
	"max_proximity_pct" real DEFAULT 0.25,
	"is_required" boolean DEFAULT true NOT NULL,
	"severity" "severity" DEFAULT 'blocker' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forbidden_fonts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"font_family" varchar(200) NOT NULL,
	"reason" text,
	"severity" "severity" DEFAULT 'major' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_style_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"feature_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"centroid" real[],
	"distance_p5" real,
	"distance_p50" real,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"allowed_mediums" text[],
	"prohibited_subjects" text[],
	"embedding_model" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lexicon_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"term" varchar(300) NOT NULL,
	"kind" varchar(30) DEFAULT 'banned' NOT NULL,
	"replacement" varchar(300),
	"case_sensitive" boolean DEFAULT false NOT NULL,
	"match_whole_word" boolean DEFAULT true NOT NULL,
	"allow_fuzzy" boolean DEFAULT true NOT NULL,
	"severity" "severity" DEFAULT 'minor' NOT NULL,
	"market_codes" text[],
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "logo_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"kind" "logo_variant_kind" DEFAULT 'primary' NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"mime_type" varchar(100),
	"width" integer,
	"height" integer,
	"aspect_ratio" real,
	"logomark_height_px" real,
	"palette" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(120) NOT NULL,
	"locale_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"key" varchar(160) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"statement" text NOT NULL,
	"rationale" text,
	"dimension" "rule_dimension" NOT NULL,
	"tier" "check_tier" NOT NULL,
	"severity" "severity" DEFAULT 'major' NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"specificity" integer DEFAULT 0 NOT NULL,
	"check" jsonb NOT NULL,
	"rubric" jsonb,
	"provenance" "rule_provenance" DEFAULT 'manual' NOT NULL,
	"citation" jsonb,
	"support" jsonb,
	"status" "rule_status" DEFAULT 'proposed' NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"calibration" jsonb,
	"optimized_prompt" text,
	"optimized_prompt_hash" varchar(80),
	"created_by_user_id" uuid,
	"activated_by_user_id" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rulesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" varchar(80) NOT NULL,
	"label" varchar(200),
	"compiled" jsonb NOT NULL,
	"rule_count" integer DEFAULT 0 NOT NULL,
	"scoring_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_by_user_id" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "type_styles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"role" varchar(60) DEFAULT 'body' NOT NULL,
	"font_family" varchar(200) NOT NULL,
	"font_aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"font_weight" integer DEFAULT 400 NOT NULL,
	"is_italic" boolean DEFAULT false NOT NULL,
	"min_size_px" real,
	"min_size_pt" real,
	"min_size_pct_of_canvas" real,
	"max_size_px" real,
	"line_height_ratio" real,
	"letter_spacing_em" real,
	"casing_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scale_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"we_are" text NOT NULL,
	"we_are_not" text NOT NULL,
	"positive_examples" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"negative_examples" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_derivatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" varchar(60) NOT NULL,
	"transform_hash" varchar(80) NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"analyzer" varchar(80) NOT NULL,
	"analyzer_version" varchar(40) NOT NULL,
	"result" jsonb NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"campaign_id" uuid,
	"variant_family_id" uuid,
	"name" varchar(400) NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"status" "asset_status" DEFAULT 'uploading' NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(120),
	"byte_size" integer,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"color_profile" varchar(80),
	"dpi" real,
	"source_fidelity" "source_fidelity" DEFAULT 'raster' NOT NULL,
	"structured_source" jsonb,
	"market" varchar(20),
	"channel" varchar(60),
	"asset_type" varchar(60),
	"locale" varchar(20),
	"copy_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"is_approved_exemplar" boolean DEFAULT false NOT NULL,
	"uploaded_by_user_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(300) NOT NULL,
	"code" varchar(80),
	"brief" text,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"rule_exceptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_type" varchar(40) NOT NULL,
	"owner_id" uuid NOT NULL,
	"space" varchar(20) NOT NULL,
	"model_id" varchar(120) NOT NULL,
	"preprocessing_version" varchar(40) DEFAULT 'v1' NOT NULL,
	"dim" integer NOT NULL,
	"vec" real[] NOT NULL,
	"norm" real,
	"content_hash" varchar(80),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "variant_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(300) NOT NULL,
	"master_asset_id" uuid,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"ruleset_id" uuid,
	"job_key" varchar(80) NOT NULL,
	"ruleset_hash" varchar(80) NOT NULL,
	"pipeline_version" varchar(40) NOT NULL,
	"status" "check_run_status" DEFAULT 'queued' NOT NULL,
	"score" real,
	"score_band" varchar(20),
	"has_blocker" boolean DEFAULT false NOT NULL,
	"dimension_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"criteria_total" integer DEFAULT 0 NOT NULL,
	"criteria_evaluated" integer DEFAULT 0 NOT NULL,
	"criteria_passed" integer DEFAULT 0 NOT NULL,
	"criteria_failed" integer DEFAULT 0 NOT NULL,
	"criteria_abstained" integer DEFAULT 0 NOT NULL,
	"coverage_rate" real,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"cache_misses" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"degraded_reason" text,
	"triggered_by_user_id" uuid,
	"triggered_by" varchar(40) DEFAULT 'api' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"check_run_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"trace_key" varchar(80) NOT NULL,
	"asset_content_hash" varchar(80) NOT NULL,
	"ruleset_hash" varchar(80) NOT NULL,
	"rule_id" uuid,
	"rule_key" varchar(160) NOT NULL,
	"rule_version" integer NOT NULL,
	"dimension" varchar(40) NOT NULL,
	"tier" "check_tier" NOT NULL,
	"verdict" "verdict" NOT NULL,
	"severity" "severity" NOT NULL,
	"confidence" real,
	"model" jsonb,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"precedent_asset_ids" uuid[],
	"citation" jsonb,
	"suggested_fix" text,
	"cached" boolean DEFAULT false NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"check_run_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"rule_key" varchar(160) NOT NULL,
	"dimension" varchar(40) NOT NULL,
	"severity" "severity" NOT NULL,
	"title" varchar(400) NOT NULL,
	"detail" text,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"display_confidence" real,
	"is_high_confidence" boolean DEFAULT true NOT NULL,
	"bbox" real[],
	"crop_key" text,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "precedents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"rule_key" varchar(160) NOT NULL,
	"rule_version" integer NOT NULL,
	"asset_id" uuid NOT NULL,
	"trace_id" uuid,
	"verdict" "verdict" NOT NULL,
	"rationale" text,
	"measured" jsonb,
	"crop_key" text,
	"embedding_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"review_id" uuid,
	"trace_id" uuid,
	"finding_id" uuid,
	"asset_id" uuid NOT NULL,
	"rule_key" varchar(160),
	"rule_version" integer,
	"action" "review_action" NOT NULL,
	"rationale" text,
	"annotation_bbox" real[],
	"reviewer_user_id" uuid NOT NULL,
	"is_calibration_label" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"check_run_id" uuid,
	"state" "review_state" DEFAULT 'pending' NOT NULL,
	"stage" varchar(60) DEFAULT 'brand' NOT NULL,
	"assigned_to_user_id" uuid,
	"due_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_calibrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"rule_key" varchar(160) NOT NULL,
	"rule_version" integer NOT NULL,
	"method" varchar(40) DEFAULT 'logistic' NOT NULL,
	"alpha" real,
	"beta" real,
	"threshold_before" real,
	"threshold_after" real,
	"agreement_rate" real,
	"precision" real,
	"recall" real,
	"cohens_kappa" real,
	"ece" real,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"coverage_at_target" real,
	"auto_route_to_human" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assembly_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"ruleset_hash" varchar(80) NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints_applied" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audience_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"personas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grounding_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"campaign_id" uuid,
	"title" varchar(300) NOT NULL,
	"objective" text,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"key_message" text,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mandatories" text[],
	"status" "brief_status" DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"platform" varchar(60) NOT NULL,
	"placement" varchar(120) NOT NULL,
	"asset_type" varchar(40) NOT NULL,
	"version" varchar(40) DEFAULT '2026.1' NOT NULL,
	"effective_from" timestamp with time zone,
	"spec" jsonb NOT NULL,
	"docs_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"aggregate_type" varchar(60) NOT NULL,
	"aggregate_id" uuid,
	"payload" jsonb NOT NULL,
	"idempotency_key" varchar(120),
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"panel_id" uuid,
	"status" "prediction_status" DEFAULT 'queued' NOT NULL,
	"percentile_vs_corpus" real,
	"dimension_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interval_low" real,
	"interval_high" real,
	"panel_responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comparison_asset_ids" uuid[],
	"recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "result_cache" (
	"cache_key" varchar(100) PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"kind" varchar(60) NOT NULL,
	"value" jsonb NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"cost_saved_usd" real DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_hit_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_state" (
	"key" varchar(120) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"outbox_event_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"response_status" integer,
	"response_body" text,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" varchar(300),
	"events" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"secret" text NOT NULL,
	"status" "webhook_status" DEFAULT 'active' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_api_key_id_api_keys_id_fk" FOREIGN KEY ("actor_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_document_chunks" ADD CONSTRAINT "brand_document_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_document_chunks" ADD CONSTRAINT "brand_document_chunks_document_id_brand_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."brand_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_documents" ADD CONSTRAINT "brand_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_documents" ADD CONSTRAINT "brand_documents_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brands" ADD CONSTRAINT "brands_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "design_tokens" ADD CONSTRAINT "design_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "design_tokens" ADD CONSTRAINT "design_tokens_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disclaimers" ADD CONSTRAINT "disclaimers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disclaimers" ADD CONSTRAINT "disclaimers_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "forbidden_fonts" ADD CONSTRAINT "forbidden_fonts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "forbidden_fonts" ADD CONSTRAINT "forbidden_fonts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "image_style_profiles" ADD CONSTRAINT "image_style_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "image_style_profiles" ADD CONSTRAINT "image_style_profiles_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lexicon_terms" ADD CONSTRAINT "lexicon_terms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lexicon_terms" ADD CONSTRAINT "lexicon_terms_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "logo_variants" ADD CONSTRAINT "logo_variants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "logo_variants" ADD CONSTRAINT "logo_variants_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "markets" ADD CONSTRAINT "markets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "markets" ADD CONSTRAINT "markets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rules" ADD CONSTRAINT "rules_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rules" ADD CONSTRAINT "rules_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "type_styles" ADD CONSTRAINT "type_styles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "type_styles" ADD CONSTRAINT "type_styles_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_attributes" ADD CONSTRAINT "voice_attributes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_attributes" ADD CONSTRAINT "voice_attributes_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_measurements" ADD CONSTRAINT "asset_measurements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_measurements" ADD CONSTRAINT "asset_measurements_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_variant_family_id_variant_families_id_fk" FOREIGN KEY ("variant_family_id") REFERENCES "public"."variant_families"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variant_families" ADD CONSTRAINT "variant_families_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variant_families" ADD CONSTRAINT "variant_families_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_ruleset_id_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."rulesets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "decision_traces" ADD CONSTRAINT "decision_traces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "decision_traces" ADD CONSTRAINT "decision_traces_check_run_id_check_runs_id_fk" FOREIGN KEY ("check_run_id") REFERENCES "public"."check_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "decision_traces" ADD CONSTRAINT "decision_traces_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "decision_traces" ADD CONSTRAINT "decision_traces_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "findings" ADD CONSTRAINT "findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "findings" ADD CONSTRAINT "findings_check_run_id_check_runs_id_fk" FOREIGN KEY ("check_run_id") REFERENCES "public"."check_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "findings" ADD CONSTRAINT "findings_trace_id_decision_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."decision_traces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "findings" ADD CONSTRAINT "findings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "findings" ADD CONSTRAINT "findings_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "precedents" ADD CONSTRAINT "precedents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "precedents" ADD CONSTRAINT "precedents_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "precedents" ADD CONSTRAINT "precedents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "precedents" ADD CONSTRAINT "precedents_trace_id_decision_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."decision_traces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_trace_id_decision_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."decision_traces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_check_run_id_check_runs_id_fk" FOREIGN KEY ("check_run_id") REFERENCES "public"."check_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_calibrations" ADD CONSTRAINT "rule_calibrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_calibrations" ADD CONSTRAINT "rule_calibrations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_plans" ADD CONSTRAINT "assembly_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assembly_plans" ADD CONSTRAINT "assembly_plans_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audience_panels" ADD CONSTRAINT "audience_panels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audience_panels" ADD CONSTRAINT "audience_panels_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "briefs" ADD CONSTRAINT "briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "briefs" ADD CONSTRAINT "briefs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "briefs" ADD CONSTRAINT "briefs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_specs" ADD CONSTRAINT "channel_specs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "predictions" ADD CONSTRAINT "predictions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "predictions" ADD CONSTRAINT "predictions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "predictions" ADD CONSTRAINT "predictions_panel_id_audience_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."audience_panels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "result_cache" ADD CONSTRAINT "result_cache_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_outbox_event_id_outbox_events_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."outbox_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_org_time_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_ledger_org_time_idx" ON "cost_ledger" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_ledger_run_idx" ON "cost_ledger" USING btree ("check_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_org_user_uq" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_document_chunks_doc_idx" ON "brand_document_chunks" USING btree ("document_id","page","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_documents_brand_idx" ON "brand_documents" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brands_org_slug_uq" ON "brands" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brands_org_idx" ON "brands" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brands_parent_idx" ON "brands" USING btree ("parent_brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_brand_idx" ON "claims" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_expiry_idx" ON "claims" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "design_tokens_brand_path_uq" ON "design_tokens" USING btree ("brand_id","path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_tokens_org_brand_idx" ON "design_tokens" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_tokens_type_idx" ON "design_tokens" USING btree ("brand_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disclaimers_brand_idx" ON "disclaimers" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forbidden_fonts_brand_idx" ON "forbidden_fonts" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_style_profiles_brand_idx" ON "image_style_profiles" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lexicon_terms_brand_idx" ON "lexicon_terms" USING btree ("org_id","brand_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "logo_variants_brand_idx" ON "logo_variants" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "logo_variants_hash_idx" ON "logo_variants" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "markets_brand_code_uq" ON "markets" USING btree ("brand_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "markets_org_idx" ON "markets" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rules_brand_key_version_uq" ON "rules" USING btree ("brand_id","key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rules_brand_status_idx" ON "rules" USING btree ("org_id","brand_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rules_dimension_idx" ON "rules" USING btree ("brand_id","dimension");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rules_tier_idx" ON "rules" USING btree ("brand_id","tier");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rulesets_brand_hash_uq" ON "rulesets" USING btree ("brand_id","hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rulesets_brand_version_idx" ON "rulesets" USING btree ("org_id","brand_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "type_styles_brand_idx" ON "type_styles" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "type_styles_brand_name_uq" ON "type_styles" USING btree ("brand_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_attributes_brand_idx" ON "voice_attributes" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "asset_derivatives_uq" ON "asset_derivatives" USING btree ("asset_id","kind","transform_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_derivatives_asset_idx" ON "asset_derivatives" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "asset_measurements_uq" ON "asset_measurements" USING btree ("asset_id","analyzer","analyzer_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_measurements_asset_idx" ON "asset_measurements" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_org_brand_idx" ON "assets" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_hash_idx" ON "assets" USING btree ("org_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_family_idx" ON "assets" USING btree ("variant_family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_exemplar_idx" ON "assets" USING btree ("brand_id","is_approved_exemplar");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_status_idx" ON "assets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_brand_idx" ON "campaigns" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "embeddings_owner_model_uq" ON "embeddings" USING btree ("owner_type","owner_id","space","model_id","preprocessing_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_org_space_idx" ON "embeddings" USING btree ("org_id","space","owner_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_content_idx" ON "embeddings" USING btree ("content_hash","model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variant_families_brand_idx" ON "variant_families" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "check_runs_job_key_uq" ON "check_runs" USING btree ("org_id","job_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "check_runs_asset_idx" ON "check_runs" USING btree ("asset_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "check_runs_org_status_idx" ON "check_runs" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "check_runs_brand_idx" ON "check_runs" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_traces_key_idx" ON "decision_traces" USING btree ("org_id","trace_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_traces_run_idx" ON "decision_traces" USING btree ("check_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_traces_rule_idx" ON "decision_traces" USING btree ("org_id","rule_key","verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_traces_asset_idx" ON "decision_traces" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_run_idx" ON "findings" USING btree ("check_run_id","severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_org_status_idx" ON "findings" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_rule_idx" ON "findings" USING btree ("org_id","rule_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "precedents_rule_idx" ON "precedents" USING btree ("org_id","brand_id","rule_key","verdict");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "precedents_rule_asset_uq" ON "precedents" USING btree ("brand_id","rule_key","rule_version","asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_decisions_org_rule_idx" ON "review_decisions" USING btree ("org_id","rule_key","action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_decisions_trace_idx" ON "review_decisions" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_decisions_asset_idx" ON "review_decisions" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_decisions_reviewer_idx" ON "review_decisions" USING btree ("reviewer_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_org_state_idx" ON "reviews" USING btree ("org_id","state","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_assignee_idx" ON "reviews" USING btree ("assigned_to_user_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_calibrations_rule_idx" ON "rule_calibrations" USING btree ("org_id","brand_id","rule_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assembly_plans_brief_idx" ON "assembly_plans" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audience_panels_brand_idx" ON "audience_panels" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_brand_idx" ON "briefs" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_specs_uq" ON "channel_specs" USING btree ("platform","placement","asset_type","version","org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_specs_platform_idx" ON "channel_specs" USING btree ("platform","placement");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_pending_idx" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_org_idx" ON "outbox_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_idempotency_uq" ON "outbox_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "predictions_asset_idx" ON "predictions" USING btree ("asset_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_cache_kind_idx" ON "result_cache" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_cache_expiry_idx" ON "result_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("org_id","status");