-- Add Gemini agent columns to repos table
ALTER TABLE "repos" ADD COLUMN "gemini_model" text DEFAULT 'gemini-2.5-pro';
ALTER TABLE "repos" ADD COLUMN "gemini_approval_mode" text DEFAULT 'yolo';
