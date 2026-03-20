import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as subtaskService from "../services/subtask-service.js";

const createSubtaskSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  taskType: z.enum(["review", "step", "child"]).optional(),
  blocksParent: z.boolean().optional(),
  agentType: z.string().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  autoQueue: z.boolean().optional(),
});

export async function subtaskRoutes(app: FastifyInstance) {
  // List subtasks for a task
  app.get("/api/tasks/:id/subtasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const subtasks = await subtaskService.getSubtasks(id);
    reply.send({ subtasks });
  });

  // Create a subtask
  app.post("/api/tasks/:id/subtasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createSubtaskSchema.parse(req.body);

    const subtask = await subtaskService.createSubtask({
      parentTaskId: id,
      title: body.title,
      prompt: body.prompt,
      taskType: body.taskType,
      blocksParent: body.blocksParent,
      agentType: body.agentType,
      priority: body.priority,
    });

    // Auto-queue if requested
    if (body.autoQueue !== false) {
      await subtaskService.queueSubtask(subtask.id);
    }

    reply.status(201).send({ subtask });
  });

  // Check blocking subtask status
  app.get("/api/tasks/:id/subtasks/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const status = await subtaskService.checkBlockingSubtasks(id);
    reply.send(status);
  });
}
