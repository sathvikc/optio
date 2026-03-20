import "dotenv/config";
import { buildServer } from "./server.js";
import { startTaskWorker } from "./workers/task-worker.js";
import { startTicketSyncWorker } from "./workers/ticket-sync-worker.js";
import { startRepoCleanupWorker } from "./workers/repo-cleanup-worker.js";
import { startPrWatcherWorker } from "./workers/pr-watcher-worker.js";
import { logger } from "./logger.js";

const PORT = parseInt(process.env.API_PORT ?? "4000", 10);
const HOST = process.env.API_HOST ?? "0.0.0.0";

async function main() {
  const app = await buildServer();

  // Start BullMQ worker
  const worker = startTaskWorker();
  logger.info("Task worker started");

  // Start ticket sync worker
  const { syncAllTickets } = await import("./services/ticket-sync-service.js");
  const ticketSyncWorker = startTicketSyncWorker(syncAllTickets);
  logger.info("Ticket sync worker started");

  // Start repo cleanup worker
  const repoCleanupWorker = startRepoCleanupWorker();
  logger.info("Repo cleanup worker started");

  // Start PR watcher worker
  const prWatcherWorker = startPrWatcherWorker();
  logger.info("PR watcher worker started");

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
