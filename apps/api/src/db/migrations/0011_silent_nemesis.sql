ALTER TABLE "tasks" ADD COLUMN "subtask_order" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "blocks_parent" boolean DEFAULT false NOT NULL;