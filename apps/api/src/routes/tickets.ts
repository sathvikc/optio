import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { syncAllTickets } from "../services/ticket-sync-service.js";
import { storeSecret, deleteSecret } from "../services/secret-service.js";
import { isSsrfSafeUrl, isSsrfSafeHost } from "../utils/ssrf.js";
import { HmacSha256Verifier } from "../services/crypto/signer.js";
import { logger } from "../logger.js";

// ── Zod schema for ticket provider config ───────────────────────────────────

const jiraConfigSchema = z.object({
  source: z.literal("jira"),
  config: z.object({
    baseUrl: z.string().url().refine(isSsrfSafeUrl, {
      message: "URL must not target private or internal addresses",
    }),
    email: z.string().email(),
    apiToken: z.string().min(1),
    projectKey: z.string().optional(),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
    doneStatusName: z.string().optional(),
    todoStatusName: z.string().optional(),
  }),
  enabled: z.boolean().optional(),
});

const gitlabConfigSchema = z.object({
  source: z.literal("gitlab"),
  config: z.object({
    host: z.string().min(1).refine(isSsrfSafeHost, {
      message: "Host must not target private or internal addresses",
    }),
    token: z.string().min(1),
    projectPath: z.string().min(1),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
  }),
  enabled: z.boolean().optional(),
});

const githubConfigSchema = z.object({
  source: z.literal("github"),
  config: z.object({
    token: z.string().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
  }),
  enabled: z.boolean().optional(),
});

const linearConfigSchema = z.object({
  source: z.literal("linear"),
  config: z.object({
    apiKey: z.string().min(1),
    teamId: z.string().optional(),
    projectId: z.string().optional(),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
  }),
  enabled: z.boolean().optional(),
});

const notionConfigSchema = z.object({
  source: z.literal("notion"),
  config: z.object({
    apiKey: z.string().min(1),
    databaseId: z.string().min(1),
    label: z.string().optional(),
    statusProperty: z.string().optional(),
    doneValue: z.string().optional(),
    titleProperty: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
  }),
  enabled: z.boolean().optional(),
});

export const ticketProviderConfigSchema = z.discriminatedUnion("source", [
  jiraConfigSchema,
  gitlabConfigSchema,
  githubConfigSchema,
  linearConfigSchema,
  notionConfigSchema,
]);

const idParamsSchema = z.object({ id: z.string() });

/** Fields per provider type that contain credentials and must be encrypted. */
const SENSITIVE_PROVIDER_FIELDS: Record<string, string[]> = {
  jira: ["apiToken"],
  linear: ["apiKey"],
  notion: ["apiKey"],
};

/** Maximum age (in minutes) for a webhook event before it is rejected. */
const WEBHOOK_MAX_AGE_MINUTES = 5;

/**
 * Verify the HMAC-SHA256 signature sent by GitHub in the X-Hub-Signature-256
 * header against the raw request body and the configured secret.
 *
 * Uses HmacSha256Verifier to centralize constant-time comparison.
 */
export async function verifyGitHubSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): Promise<boolean> {
  // GitHub sends "sha256=<hex>" — strip the prefix and decode the hex digest
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const sigBytes = Buffer.from(signature.slice(prefix.length), "hex");

  const verifier = new HmacSha256Verifier(secret);
  return verifier.verify(rawBody, sigBytes);
}

/**
 * Check whether the webhook delivery timestamp is within the acceptable window.
 * Returns true if the event should be rejected (too old).
 */
export function isReplayedEvent(
  timestampHeader: string | undefined,
  maxAgeMinutes: number = WEBHOOK_MAX_AGE_MINUTES,
): boolean {
  if (!timestampHeader) return false;
  const ts = Number(timestampHeader);
  if (Number.isNaN(ts)) return false;
  const ageMs = Date.now() - ts * 1000;
  return ageMs > maxAgeMinutes * 60 * 1000;
}

export async function ticketRoutes(app: FastifyInstance) {
  // List configured ticket providers
  app.get("/api/tickets/providers", async (_req, reply) => {
    const providers = await db.select().from(ticketProviders);
    reply.send({ providers });
  });

  // Sync tickets from all enabled providers
  app.post("/api/tickets/sync", async (_req, reply) => {
    const synced = await syncAllTickets();
    reply.send({ synced });
  });

  // Configure a ticket provider
  app.post("/api/tickets/providers", async (req, reply) => {
    const parsed = ticketProviderConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "Invalid provider config", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // Separate sensitive fields from config — they go into encrypted secrets
    const sensitiveFields = SENSITIVE_PROVIDER_FIELDS[body.source] ?? [];
    const safeConfig: Record<string, unknown> = { ...body.config };
    const sensitiveValues: Record<string, string> = {};

    for (const field of sensitiveFields) {
      if (safeConfig[field]) {
        sensitiveValues[field] = safeConfig[field] as string;
        delete safeConfig[field];
      }
    }

    const [provider] = await db
      .insert(ticketProviders)
      .values({
        source: body.source,
        config: safeConfig,
        enabled: body.enabled ?? true,
      })
      .returning();

    // Store sensitive fields as encrypted secret
    if (Object.keys(sensitiveValues).length > 0) {
      await storeSecret(
        `ticket-provider:${provider.id}`,
        JSON.stringify(sensitiveValues),
        "ticket-provider",
      );
    }

    reply.status(201).send({ provider });
  });

  // Delete a ticket provider
  app.delete("/api/tickets/providers/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    await db.delete(ticketProviders).where(eq(ticketProviders.id, id));
    // Clean up associated encrypted credentials
    await deleteSecret(`ticket-provider:${id}`, "ticket-provider");
    reply.status(204).send();
  });

  // GitHub webhook endpoint for real-time ticket events
  app.post("/api/webhooks/github", {
    // Capture raw body before JSON parsing so we can verify the HMAC signature
    preParsing: async (req, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
      }
      const rawBody = Buffer.concat(chunks);
      (req as any).rawBody = rawBody;
      return Readable.from(rawBody);
    },
    handler: async (req, reply) => {
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

      if (!webhookSecret) {
        logger.error("GITHUB_WEBHOOK_SECRET is not set — rejecting webhook request");
        return reply.status(401).send({ error: "Webhook secret not configured" });
      }

      // Validate HMAC-SHA256 signature
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        logger.warn("Webhook request missing X-Hub-Signature-256 header");
        return reply.status(401).send({ error: "Missing signature" });
      }

      const rawBody = (req as any).rawBody as Buffer;
      if (!(await verifyGitHubSignature(rawBody, signature, webhookSecret))) {
        logger.warn("Webhook signature verification failed");
        return reply.status(401).send({ error: "Invalid signature" });
      }

      // Replay protection — reject events with stale timestamps
      const timestamp = req.headers["x-github-delivery-timestamp"] as string | undefined;
      if (isReplayedEvent(timestamp)) {
        logger.warn({ timestamp }, "Rejecting replayed webhook event");
        return reply.status(401).send({ error: "Replayed event" });
      }

      const event = req.headers["x-github-event"];
      // GitHub webhook payload — already validated by HMAC signature above.
      // We use a permissive record type since the shape depends on the event.
      const rawPayload = req.body;
      const payload = rawPayload as Record<string, Record<string, unknown> | string | undefined>;

      if (event === "issues" && payload.action === "labeled") {
        const label = (payload.label as Record<string, unknown> | undefined)?.name;
        if (label === "optio") {
          logger.info(
            { issue: (payload.issue as Record<string, unknown> | undefined)?.number },
            "GitHub issue labeled with optio",
          );
          // Trigger a sync — handles deduplication
          await syncAllTickets();
        }
      }

      if (
        event === "pull_request" &&
        payload.action === "closed" &&
        (payload.pull_request as Record<string, unknown> | undefined)?.merged
      ) {
        const prUrl = String((payload.pull_request as Record<string, unknown>).html_url ?? "");
        const allTasks = await taskService.listTasks({ limit: 500 });
        const matchingTask = allTasks.find((t: any) => t.prUrl === prUrl);

        if (matchingTask) {
          try {
            await taskService.transitionTask(
              matchingTask.id,
              TaskState.COMPLETED,
              "pr_merged",
              prUrl,
            );
            logger.info({ taskId: matchingTask.id, prUrl }, "Task completed via PR merge");
          } catch {
            // May already be completed
          }
        }
      }

      reply.status(200).send({ ok: true });
    },
  });
}
