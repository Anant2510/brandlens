ALTER TABLE "asset_measurements" ALTER COLUMN "duration_ms" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "check_runs" ALTER COLUMN "duration_ms" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "decision_traces" ALTER COLUMN "latency_ms" SET DATA TYPE real;