-- PR Review as a first-class primitive.
--
-- Lifts external PR review out of the `tasks` table into its own
-- (pr_reviews, pr_review_runs, pr_review_events) trio, paralleling how
-- Standalone Tasks live in (workflows, workflow_runs) alongside Repo
-- Tasks. Removes the old `review_drafts` / `review_chat_messages` tables
-- in favor of the new shape.
--
-- Destructive for existing pr_review tasks and review_drafts: any
-- in-flight external PR reviews are dropped. Polling will re-discover
-- open PRs on the next tick. Subtask reviews (tasks.task_type='review')
-- are untouched.

-- ── Drop old tables ─────────────────────────────────────────────────────
DROP TABLE IF EXISTS "review_chat_messages";
DROP TABLE IF EXISTS "review_drafts";
DROP TYPE IF EXISTS "review_draft_state";
DROP TYPE IF EXISTS "review_chat_message_role";

-- ── Drop old taskType='pr_review' tasks ────────────────────────────────
-- These will be re-created as pr_reviews by the poller. Leave 'review'
-- subtasks alone. task_events / task_logs reference tasks via FK with no
-- cascade policy, so we clear them explicitly before the delete.
DELETE FROM "task_logs" WHERE "task_id" IN (
  SELECT id FROM "tasks" WHERE "task_type" = 'pr_review'
);
DELETE FROM "task_events" WHERE "task_id" IN (
  SELECT id FROM "tasks" WHERE "task_type" = 'pr_review'
);
DELETE FROM "tasks" WHERE "task_type" = 'pr_review';

-- ── pr_reviews: the canonical review record ────────────────────────────
CREATE TYPE "pr_review_state" AS ENUM (
  'queued',
  'waiting_ci',
  'reviewing',
  'ready',
  'stale',
  'submitted',
  'cancelled',
  'failed'
);

CREATE TABLE "pr_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid,
  "pr_url" text NOT NULL,
  "pr_number" integer NOT NULL,
  "repo_owner" text NOT NULL,
  "repo_name" text NOT NULL,
  "repo_url" text NOT NULL,
  "head_sha" text NOT NULL,
  "state" "pr_review_state" NOT NULL DEFAULT 'queued',
  "verdict" text,
  "summary" text,
  "file_comments" jsonb,
  "origin" text NOT NULL DEFAULT 'manual',
  "user_engaged" boolean NOT NULL DEFAULT false,
  "auto_submitted" boolean NOT NULL DEFAULT false,
  "submitted_at" timestamptz,
  "error_message" text,
  "created_by" uuid,
  "control_intent" text,
  "reconcile_backoff_until" timestamptz,
  "reconcile_attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "pr_reviews_workspace_idx" ON "pr_reviews" ("workspace_id");
CREATE INDEX "pr_reviews_state_idx" ON "pr_reviews" ("state");
CREATE INDEX "pr_reviews_pr_url_idx" ON "pr_reviews" ("pr_url");
CREATE INDEX "pr_reviews_repo_url_idx" ON "pr_reviews" ("repo_url");
CREATE INDEX "pr_reviews_updated_idx" ON "pr_reviews" ("updated_at" DESC);

-- ── pr_review_runs: each agent execution ───────────────────────────────
CREATE TYPE "pr_review_run_state" AS ENUM (
  'queued',
  'provisioning',
  'running',
  'completed',
  'failed',
  'cancelled'
);

CREATE TABLE "pr_review_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pr_review_id" uuid NOT NULL REFERENCES "pr_reviews"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'initial',
  "state" "pr_review_run_state" NOT NULL DEFAULT 'queued',
  "prompt" text,
  "session_id" text,
  "resume_session_id" text,
  "container_id" text,
  "pod_id" uuid,
  "last_pod_id" uuid,
  "worktree_state" text,
  "result_summary" text,
  "error_message" text,
  "cost_usd" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "model_used" text,
  "metadata" jsonb,
  "last_activity_at" timestamptz,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "pr_review_runs_review_idx" ON "pr_review_runs" ("pr_review_id");
CREATE INDEX "pr_review_runs_state_idx" ON "pr_review_runs" ("state");
CREATE INDEX "pr_review_runs_created_idx" ON "pr_review_runs" ("created_at" DESC);

-- ── pr_review_events: transition log ───────────────────────────────────
CREATE TABLE "pr_review_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pr_review_id" uuid NOT NULL REFERENCES "pr_reviews"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "pr_review_runs"("id") ON DELETE SET NULL,
  "from_state" "pr_review_state",
  "to_state" "pr_review_state" NOT NULL,
  "trigger" text NOT NULL,
  "message" text,
  "user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "pr_review_events_review_idx" ON "pr_review_events" ("pr_review_id");
CREATE INDEX "pr_review_events_created_idx" ON "pr_review_events" ("created_at" DESC);

-- ── pr_review_chat_messages: user ↔ agent conversation ─────────────────
CREATE TYPE "pr_review_chat_role" AS ENUM ('user', 'assistant');

CREATE TABLE "pr_review_chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pr_review_id" uuid NOT NULL REFERENCES "pr_reviews"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "pr_review_runs"("id") ON DELETE SET NULL,
  "role" "pr_review_chat_role" NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "pr_review_chat_messages_review_idx"
  ON "pr_review_chat_messages" ("pr_review_id", "created_at");

-- ── task_logs: allow pr_review_run-owned log rows ──────────────────────
-- Drop the not-null on task_id and the FK so log rows can reference a
-- pr_review_run instead. The column stays for coding/subtask-review runs.
ALTER TABLE "task_logs" ALTER COLUMN "task_id" DROP NOT NULL;
ALTER TABLE "task_logs" DROP CONSTRAINT IF EXISTS "task_logs_task_id_tasks_id_fk";
ALTER TABLE "task_logs"
  ADD CONSTRAINT "task_logs_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;

ALTER TABLE "task_logs" ADD COLUMN "pr_review_run_id" uuid
  REFERENCES "pr_review_runs"("id") ON DELETE CASCADE;
CREATE INDEX "task_logs_pr_review_run_id_idx"
  ON "task_logs" ("pr_review_run_id", "timestamp");
