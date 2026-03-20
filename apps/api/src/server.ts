import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { healthRoutes } from "./routes/health.js";
import { taskRoutes } from "./routes/tasks.js";
import { secretRoutes } from "./routes/secrets.js";
import { ticketRoutes } from "./routes/tickets.js";
import { setupRoutes } from "./routes/setup.js";
import { authRoutes } from "./routes/auth.js";
import { resumeRoutes } from "./routes/resume.js";
import { promptTemplateRoutes } from "./routes/prompt-templates.js";
import { repoRoutes } from "./routes/repos.js";
import { clusterRoutes } from "./routes/cluster.js";
import { bulkRoutes } from "./routes/bulk.js";
import { issueRoutes } from "./routes/issues.js";
import { subtaskRoutes } from "./routes/subtasks.js";
import { logStreamWs } from "./ws/log-stream.js";
import { eventsWs } from "./ws/events.js";
import { logger } from "./logger.js";

const loggerConfig =
  process.env.NODE_ENV !== "production"
    ? {
        level: process.env.LOG_LEVEL ?? "info",
        transport: { target: "pino-pretty", options: { colorize: true } },
      }
    : { level: process.env.LOG_LEVEL ?? "info" };

export async function buildServer() {
  const app = Fastify({ logger: loggerConfig });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "::1"],
  });
  await app.register(websocket);

  // REST routes
  await app.register(healthRoutes);
  await app.register(taskRoutes);
  await app.register(secretRoutes);
  await app.register(ticketRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(resumeRoutes);
  await app.register(promptTemplateRoutes);
  await app.register(repoRoutes);
  await app.register(clusterRoutes);
  await app.register(bulkRoutes);
  await app.register(issueRoutes);
  await app.register(subtaskRoutes);

  // WebSocket routes
  await app.register(logStreamWs);
  await app.register(eventsWs);

  // Global error handler for Zod validation
  app.setErrorHandler((error: FastifyError | Error, _req, reply) => {
    if (error.name === "ZodError") {
      return reply.status(400).send({ error: "Validation error", details: error.message });
    }
    if (error.name === "InvalidTransitionError") {
      return reply.status(409).send({ error: error.message });
    }
    app.log.error(error);
    reply.status(500).send({ error: "Internal server error" });
  });

  return app;
}
