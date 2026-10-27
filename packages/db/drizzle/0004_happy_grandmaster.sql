CREATE TYPE "public"."github_event_kind" AS ENUM('pull_request', 'release');--> statement-breakpoint
ALTER TYPE "public"."run_mode" ADD VALUE 'suite';--> statement-breakpoint
ALTER TYPE "public"."run_mode" ADD VALUE 'release';--> statement-breakpoint
CREATE TABLE "github_connections" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"token_env" text DEFAULT 'GITHUB_TOKEN' NOT NULL,
	"pr_environment_id" uuid,
	"pr_url_template" text,
	"release_environment_id" uuid,
	"health_path" text,
	"poll_seconds" integer DEFAULT 60 NOT NULL,
	"on_pull_requests" boolean DEFAULT true NOT NULL,
	"on_releases" boolean DEFAULT true NOT NULL,
	"pr_comments" boolean DEFAULT false NOT NULL,
	"release_missions" integer DEFAULT 3 NOT NULL,
	"last_poll_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "github_event_kind" NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid,
	"job_id" text,
	"result" text DEFAULT 'queued' NOT NULL,
	CONSTRAINT "github_events_project_id_kind_ref_sha_unique" UNIQUE("project_id","kind","ref","sha")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_pr_environment_id_environments_id_fk" FOREIGN KEY ("pr_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_release_environment_id_environments_id_fk" FOREIGN KEY ("release_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_events" ADD CONSTRAINT "github_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_events" ADD CONSTRAINT "github_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_events_release_tag" ON "github_events" USING btree ("project_id","ref") WHERE "github_events"."kind" = 'release';