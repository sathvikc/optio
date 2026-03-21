import "dotenv/config";
import { Queue } from "bullmq";
import { buildServer } from "./server.js";
import { startTaskWorker, reconcileOrphanedTasks } from "./workers/task-worker.js";
import { startTicketSyncWorker } from "./workers/ticket-sync-worker.js";
import { startRepoCleanupWorker } from "./workers/repo-cleanup-worker.js";
import { startPrWatcherWorker } from "./workers/pr-watcher-worker.js";
import { logger } from "./logger.js";

const redisConnection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  maxRetriesPerRequest: null,
};

/**
 * Remove all stale repeatable jobs from a queue before re-registering.
 * Prevents duplicate/orphaned repeat jobs after server restarts.
 */
async function cleanRepeatJobs(queueName: string) {
  const queue = new Queue(queueName, { connection: redisConnection });
  try {
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await queue.removeRepeatableByKey(job.key);
    }
    if (repeatableJobs.length > 0) {
      logger.info(
        { queue: queueName, removed: repeatableJobs.length },
        "Cleaned stale repeat jobs",
      );
    }
  } finally {
    await queue.close();
  }
}

const PORT = parseInt(process.env.API_PORT ?? "4000", 10);
const HOST = process.env.API_HOST ?? "0.0.0.0";

// Prevent Redis connection errors from crashing the process
process.on("uncaughtException", (err) => {
  if (err.message?.includes("Connection is closed") || err.message?.includes("ECONNREFUSED")) {
    logger.warn({ err: err.message }, "Redis connection error (will reconnect)");
    return;
  }
  logger.error(err, "Uncaught exception");
  process.exit(1);
});

async function main() {
  const app = await buildServer();

  // Clean stale repeat jobs from previous server sessions
  await Promise.all([
    cleanRepeatJobs("pr-watcher"),
    cleanRepeatJobs("repo-cleanup"),
    cleanRepeatJobs("ticket-sync"),
  ]);

  // Start BullMQ workers (each re-registers its repeat job)
  const worker = startTaskWorker();
  logger.info("Task worker started");

  const { syncAllTickets } = await import("./services/ticket-sync-service.js");
  const ticketSyncWorker = startTicketSyncWorker(syncAllTickets);
  logger.info("Ticket sync worker started");

  const repoCleanupWorker = startRepoCleanupWorker();
  logger.info("Repo cleanup worker started");

  const prWatcherWorker = startPrWatcherWorker();
  logger.info("PR watcher worker started");

  // Re-enqueue any tasks orphaned by a Redis restart
  await reconcileOrphanedTasks();

  // Start HTTP server
  await app.listen({ port: PORT, host: HOST });
  logger.info(`API server listening on ${HOST}:${PORT}`);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await worker.close();
    await ticketSyncWorker.close();
    await repoCleanupWorker.close();
    await prWatcherWorker.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(err, "Failed to start");
  process.exit(1);
});
