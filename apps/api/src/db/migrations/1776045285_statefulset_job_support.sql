-- Add StatefulSet tracking columns to repo_pods
ALTER TABLE "repo_pods" ADD COLUMN "statefulset_name" text;
ALTER TABLE "repo_pods" ADD COLUMN "managed_by" text NOT NULL DEFAULT 'bare-pod';
CREATE INDEX "repo_pods_statefulset_name_idx" ON "repo_pods" USING btree ("statefulset_name");

-- Add Job tracking columns to workflow_pods
ALTER TABLE "workflow_pods" ADD COLUMN "job_name" text;
ALTER TABLE "workflow_pods" ADD COLUMN "managed_by" text NOT NULL DEFAULT 'bare-pod';
