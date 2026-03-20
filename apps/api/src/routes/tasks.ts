import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "../workers/task-worker.js";

const createTaskSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  repoUrl: z.string().url(),
  repoBranch: z.string().optional(),
  agentType: z.enum(["claude-code", "codex"]),
  ticketSource: z.string().optional(),
  ticketExternalId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

export async function taskRoutes(app: FastifyInstance) {
  // List tasks
  app.get("/api/tasks", async (req, reply) => {
    const query = req.query as { state?: string; limit?: string; offset?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const taskList = await taskService.listTasks({ state: query.state, limit, offset });
    reply.send({ tasks: taskList, limit, offset });
  });

  // Get task
  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    reply.send({ task });
  });

  // Create task
  app.post("/api/tasks", async (req, reply) => {
    const input = createTaskSchema.parse(req.body);
    const task = await taskService.createTask(input);

    // Enqueue for processing
    await taskService.transitionTask(task.id, TaskState.QUEUED, "task_submitted");
    await taskQueue.add(
      "process-task",
      { taskId: task.id },
      {
        jobId: task.id,
        attempts: task.maxRetries + 1,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    reply.status(201).send({ task });
  });

  // Cancel task
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.transitionTask(id, TaskState.CANCELLED, "user_cancel");
    reply.send({ task });
  });

  // Retry task
  app.post("/api/tasks/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.transitionTask(id, TaskState.QUEUED, "user_retry");
    await taskQueue.add(
      "process-task",
      { taskId: id },
      {
        jobId: `${id}-retry-${Date.now()}`,
        attempts: 1,
      },
    );
    reply.send({ task });
  });

  // Get task logs
  app.get("/api/tasks/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string; offset?: string };
    const logs = await taskService.getTaskLogs(id, {
      limit: query.limit ? parseInt(query.limit, 10) : 200,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
    });
    reply.send({ logs });
  });

  // Get task events
  app.get("/api/tasks/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const events = await taskService.getTaskEvents(id);
    reply.send({ events });
  });
}
