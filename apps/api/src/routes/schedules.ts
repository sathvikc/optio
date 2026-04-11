import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import * as scheduleService from "../services/schedule-service.js";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  ScheduleSchema,
  ScheduleRunSchema,
  CronValidationResultSchema,
} from "../schemas/workflow.js";
import { TaskSchema, AgentTypeSchema } from "../schemas/task.js";

const limitQuerySchema = z
  .object({
    limit: z.string().optional().describe("Max number of items to return (stringified int)"),
  })
  .describe("Query parameter: page limit");

const taskConfigSchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    repoUrl: z.string().url(),
    repoBranch: z
      .string()
      .regex(/^[a-zA-Z0-9._/-]+$/, "Invalid branch name")
      .optional(),
    agentType: AgentTypeSchema,
    maxRetries: z.number().int().min(0).max(10).optional(),
    priority: z.number().int().min(1).max(1000).optional(),
  })
  .describe("Template task definition instantiated each time the schedule fires");

const createScheduleSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    cronExpression: z.string().min(1).describe("Cron expression (unix format)"),
    enabled: z.boolean().optional(),
    taskConfig: taskConfigSchema,
  })
  .describe("Body for creating a new schedule");

const updateScheduleSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    cronExpression: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    taskConfig: taskConfigSchema.optional(),
  })
  .describe("Partial update to a schedule");

const validateCronBodySchema = z
  .object({
    cronExpression: z.string().min(1).describe("Cron expression to validate"),
  })
  .describe("Body for cron expression validation");

const ScheduleListResponseSchema = z
  .object({
    schedules: z.array(ScheduleSchema),
  })
  .describe("All schedules in the current workspace");

const ScheduleResponseSchema = z
  .object({
    schedule: ScheduleSchema,
  })
  .describe("Single schedule envelope");

const ScheduleRunsListResponseSchema = z
  .object({
    runs: z.array(ScheduleRunSchema),
  })
  .describe("Recent schedule run history");

const TaskResponseSchema = z
  .object({
    task: TaskSchema,
  })
  .describe("Task that was created by the manual trigger");

export async function scheduleRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/schedules",
    {
      schema: {
        operationId: "listSchedules",
        summary: "List schedules",
        description: "Return all schedules in the current workspace.",
        tags: ["Workflows"],
        response: {
          200: ScheduleListResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const list = await scheduleService.listSchedules(workspaceId);
      reply.send({ schedules: list });
    },
  );

  app.get(
    "/api/schedules/:id",
    {
      schema: {
        operationId: "getSchedule",
        summary: "Get a schedule",
        description: "Fetch a single schedule by ID.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          200: ScheduleResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const schedule = await scheduleService.getSchedule(id);
      if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && schedule.workspaceId && schedule.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Schedule not found" });
      }
      reply.send({ schedule });
    },
  );

  app.post(
    "/api/schedules",
    {
      schema: {
        operationId: "createSchedule",
        summary: "Create a schedule",
        description:
          "Create a new cron-based schedule. The `cronExpression` is " +
          "validated up-front; invalid expressions return 400.",
        tags: ["Workflows"],
        body: createScheduleSchema,
        response: {
          201: ScheduleResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;

      const validation = scheduleService.validateCronExpression(body.cronExpression);
      if (!validation.valid) {
        return reply.status(400).send({ error: `Invalid cron expression: ${validation.error}` });
      }

      const workspaceId = req.user?.workspaceId ?? null;
      const schedule = await scheduleService.createSchedule(body, req.user?.id, workspaceId);
      reply.status(201).send({ schedule });
    },
  );

  app.patch(
    "/api/schedules/:id",
    {
      schema: {
        operationId: "updateSchedule",
        summary: "Update a schedule",
        description: "Partial update to a schedule.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        body: updateScheduleSchema,
        response: {
          200: ScheduleResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await scheduleService.getSchedule(id);
      if (!existing) return reply.status(404).send({ error: "Schedule not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Schedule not found" });
      }

      const body = req.body;

      if (body.cronExpression) {
        const validation = scheduleService.validateCronExpression(body.cronExpression);
        if (!validation.valid) {
          return reply.status(400).send({ error: `Invalid cron expression: ${validation.error}` });
        }
      }

      const schedule = await scheduleService.updateSchedule(id, body);
      if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
      reply.send({ schedule });
    },
  );

  app.delete(
    "/api/schedules/:id",
    {
      schema: {
        operationId: "deleteSchedule",
        summary: "Delete a schedule",
        description: "Delete a schedule. Returns 204 on success.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          204: z.null().describe("Schedule deleted"),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await scheduleService.getSchedule(id);
      if (!existing) return reply.status(404).send({ error: "Schedule not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Schedule not found" });
      }
      const deleted = await scheduleService.deleteSchedule(id);
      if (!deleted) return reply.status(404).send({ error: "Schedule not found" });
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/schedules/:id/trigger",
    {
      schema: {
        operationId: "triggerScheduleNow",
        summary: "Manually trigger a schedule",
        description:
          "Force a schedule to fire immediately, creating a task from its " +
          "configured template and enqueuing it. Returns the created task. " +
          "Records the manual run in the schedule's run history.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          200: TaskResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const schedule = await scheduleService.getSchedule(id);
      if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && schedule.workspaceId && schedule.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Schedule not found" });
      }

      const config = schedule.taskConfig as {
        title: string;
        prompt: string;
        repoUrl: string;
        repoBranch?: string;
        agentType: string;
        maxRetries?: number;
        priority?: number;
      };

      try {
        const task = await taskService.createTask({
          title: config.title,
          prompt: config.prompt,
          repoUrl: config.repoUrl,
          repoBranch: config.repoBranch,
          agentType: config.agentType,
          maxRetries: config.maxRetries,
          priority: config.priority,
          metadata: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            triggeredManually: true,
          },
          createdBy: req.user?.id,
          workspaceId: req.user?.workspaceId ?? null,
        });

        await taskService.transitionTask(task.id, TaskState.QUEUED, "schedule_manual_trigger");
        await taskQueue.add(
          "process-task",
          { taskId: task.id },
          {
            jobId: task.id,
            priority: task.priority ?? 100,
            attempts: task.maxRetries + 1,
            backoff: { type: "exponential", delay: 5000 },
          },
        );

        await scheduleService.recordRun(schedule.id, task.id, "created");
        reply.send({ task });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        await scheduleService.recordRun(schedule.id, null, "failed", errorMsg);
        reply.status(500).send({ error: errorMsg });
      }
    },
  );

  app.get(
    "/api/schedules/:id/runs",
    {
      schema: {
        operationId: "getScheduleRuns",
        summary: "Get schedule run history",
        description: "Return recent schedule run entries, newest first.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        querystring: limitQuerySchema,
        response: {
          200: ScheduleRunsListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const schedule = await scheduleService.getSchedule(id);
      if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && schedule.workspaceId && schedule.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Schedule not found" });
      }
      const { limit } = req.query;
      const runs = await scheduleService.getScheduleRuns(id, limit ? parseInt(limit, 10) : 50);
      reply.send({ runs });
    },
  );

  app.post(
    "/api/schedules/validate-cron",
    {
      schema: {
        operationId: "validateCronExpression",
        summary: "Validate a cron expression",
        description:
          "Check whether a cron expression parses correctly. Returns " +
          "`{ valid: true }` or `{ valid: false, error }`.",
        tags: ["Workflows"],
        body: validateCronBodySchema,
        response: {
          200: CronValidationResultSchema,
        },
      },
    },
    async (req, reply) => {
      const { cronExpression } = req.body;
      const result = scheduleService.validateCronExpression(cronExpression);
      reply.send(result);
    },
  );
}
