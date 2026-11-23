CREATE TABLE "slack_code_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_installation_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"session_id" text NOT NULL,
	"anchor_ts" text NOT NULL,
	"origin_channel_id" text NOT NULL,
	"origin_message_ts" text NOT NULL,
	"task_id" text,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_code_channels_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "slack_code_channels_team_channel_unique" UNIQUE("team_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "slack_code_channels" ADD CONSTRAINT "slack_code_channels_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_code_channels" ADD CONSTRAINT "slack_code_channels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_code_channels_channel_id_idx" ON "slack_code_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "slack_code_channels_task_id_idx" ON "slack_code_channels" USING btree ("task_id");