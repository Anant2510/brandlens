CREATE TYPE "public"."rule_pack_category" AS ENUM('baseline', 'regulated', 'heuristic');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_rule_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reason" text,
	"decided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"key" varchar(120) NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"category" "rule_pack_category" DEFAULT 'baseline' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled_by_default" boolean DEFAULT false NOT NULL,
	"jurisdictions" text[] DEFAULT '{}' NOT NULL,
	"authority" varchar(200),
	"docs_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"pack_id" uuid NOT NULL,
	"key" varchar(160) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"statement" text NOT NULL,
	"rationale" text,
	"dimension" "rule_dimension" NOT NULL,
	"tier" "check_tier" DEFAULT 'deterministic' NOT NULL,
	"severity" "severity" DEFAULT 'major' NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"check" jsonb NOT NULL,
	"rubric" jsonb,
	"citation" jsonb,
	"default_status" varchar(20) DEFAULT 'active' NOT NULL,
	"guidance" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "forked_from_template_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "forked_from_version" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_rule_packs" ADD CONSTRAINT "brand_rule_packs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_rule_packs" ADD CONSTRAINT "brand_rule_packs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_rule_packs" ADD CONSTRAINT "brand_rule_packs_pack_id_rule_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."rule_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_rule_packs" ADD CONSTRAINT "brand_rule_packs_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_packs" ADD CONSTRAINT "rule_packs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_templates" ADD CONSTRAINT "rule_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_templates" ADD CONSTRAINT "rule_templates_pack_id_rule_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."rule_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brand_rule_packs_uq" ON "brand_rule_packs" USING btree ("brand_id","pack_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_rule_packs_brand_idx" ON "brand_rule_packs" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rule_packs_key_uq" ON "rule_packs" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_packs_category_idx" ON "rule_packs" USING btree ("category","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rule_templates_pack_key_uq" ON "rule_templates" USING btree ("pack_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_templates_pack_idx" ON "rule_templates" USING btree ("pack_id","is_active");