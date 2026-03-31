-- Encrypt webhook secrets and Slack webhook URLs at rest using AES-256-GCM
-- Replaces plaintext text columns with encrypted bytea columns

-- Webhooks: replace plaintext secret with encrypted columns
ALTER TABLE "webhooks" ADD COLUMN "encrypted_secret" bytea;
ALTER TABLE "webhooks" ADD COLUMN "secret_iv" bytea;
ALTER TABLE "webhooks" ADD COLUMN "secret_auth_tag" bytea;
ALTER TABLE "webhooks" DROP COLUMN IF EXISTS "secret";

-- Repos: replace plaintext slack_webhook_url with encrypted columns
ALTER TABLE "repos" ADD COLUMN "encrypted_slack_webhook_url" bytea;
ALTER TABLE "repos" ADD COLUMN "slack_webhook_url_iv" bytea;
ALTER TABLE "repos" ADD COLUMN "slack_webhook_url_auth_tag" bytea;
ALTER TABLE "repos" DROP COLUMN IF EXISTS "slack_webhook_url";
