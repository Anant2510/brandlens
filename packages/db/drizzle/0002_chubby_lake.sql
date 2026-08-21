CREATE TYPE "public"."discovery_stage" AS ENUM('pending', 'harvesting', 'extracting', 'inducing', 'checking', 'reporting', 'done');--> statement-breakpoint
CREATE TYPE "public"."discovery_status" AS ENUM('queued', 'running', 'completed', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovered_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"discovery_run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"role" varchar(40) DEFAULT 'other' NOT NULL,
	"title" text,
	"http_status" integer,
	"viewport" varchar(20) DEFAULT 'desktop' NOT NULL,
	"asset_id" uuid,
	"extract_key" text,
	"extract_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"render_ms" real,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid,
	"ruleset_id" uuid,
	"seed_url" text NOT NULL,
	"origin_url" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovery_key" varchar(80) NOT NULL,
	"pipeline_version" varchar(40) NOT NULL,
	"status" "discovery_status" DEFAULT 'queued' NOT NULL,
	"stage" "discovery_stage" DEFAULT 'pending' NOT NULL,
	"stage_progress" real DEFAULT 0 NOT NULL,
	"pages_discovered" integer DEFAULT 0 NOT NULL,
	"pages_harvested" integer DEFAULT 0 NOT NULL,
	"pages_failed" integer DEFAULT 0 NOT NULL,
	"tokens_proposed" integer DEFAULT 0 NOT NULL,
	"rules_proposed" integer DEFAULT 0 NOT NULL,
	"consistency_score" real,
	"findings_total" integer DEFAULT 0 NOT NULL,
	"blockers_total" integer DEFAULT 0 NOT NULL,
	"report" jsonb,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"duration_ms" real,
	"stage_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"triggered_by_user_id" uuid,
	"triggered_by" varchar(40) DEFAULT 'ui' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovered_pages" ADD CONSTRAINT "discovered_pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovered_pages" ADD CONSTRAINT "discovered_pages_discovery_run_id_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovered_pages" ADD CONSTRAINT "discovered_pages_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_ruleset_id_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."rulesets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovered_pages_run_url_viewport_uq" ON "discovered_pages" USING btree ("discovery_run_id","url","viewport");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovered_pages_run_idx" ON "discovered_pages" USING btree ("discovery_run_id","depth");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovered_pages_asset_idx" ON "discovered_pages" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_runs_org_key_uq" ON "discovery_runs" USING btree ("org_id","discovery_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_runs_org_idx" ON "discovery_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_runs_brand_idx" ON "discovery_runs" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_runs_status_idx" ON "discovery_runs" USING btree ("org_id","status");