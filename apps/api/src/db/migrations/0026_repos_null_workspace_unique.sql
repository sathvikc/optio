-- Fix: duplicate repos allowed when workspace_id is NULL
-- PostgreSQL treats NULLs as distinct in unique constraints, so the existing
-- repos_url_workspace_key constraint on (repo_url, workspace_id) does not
-- prevent duplicate repos when workspace_id IS NULL.

-- Step 1: Deduplicate any existing repos with NULL workspace_id.
-- Keep the oldest entry (smallest created_at), delete newer duplicates.
DELETE FROM repos
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY repo_url ORDER BY created_at ASC) AS rn
    FROM repos
    WHERE workspace_id IS NULL
  ) dupes
  WHERE rn > 1
);
--> statement-breakpoint
-- Step 2: Assign remaining NULL workspace_id repos to the default workspace.
-- The default workspace was created in migration 0022 with slug 'default'.
UPDATE repos
SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default' LIMIT 1),
    updated_at = NOW()
WHERE workspace_id IS NULL
  AND EXISTS (SELECT 1 FROM workspaces WHERE slug = 'default');
--> statement-breakpoint
-- Step 3: Create a partial unique index as a safety net.
-- Even though we assign default workspaces above, this prevents future NULLs
-- from creating duplicates if application code regresses.
CREATE UNIQUE INDEX IF NOT EXISTS "repos_url_null_ws_idx"
  ON repos (repo_url)
  WHERE workspace_id IS NULL;
