import { eq, and, sql, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { logger } from "../logger.js";

export interface SubtaskInput {
  parentTaskId: string;
  title: string;
  prompt: string;
  taskType?: string;  // "review" | "step" | "child"
  blocksParent?: boolean;
  agentType?: string;
  priority?: number;
}

/**
 * Create a subtask linked to a parent task.
 */
export async function createSubtask(input: SubtaskInput) {
  const parent = await taskService.getTask(input.parentTaskId);
  if (!parent) throw new Error("Parent task not found");

  // Get next subtask order
  const [maxOrder] = await db
    .select({ max: sql<number>`COALESCE(MAX(${tasks.subtaskOrder}), -1)` })
    .from(tasks)
    .where(eq(tasks.parentTaskId, input.parentTaskId));
  const nextOrder = (Number(maxOrder?.max) ?? -1) + 1;

  // Create the subtask
  const subtask = await taskService.createTask({
    title: input.title,
    prompt: input.prompt,
    repoUrl: parent.repoUrl,
    agentType: input.agentType ?? parent.agentType,
    priority: input.priority ?? Math.max(1, (parent.priority ?? 100) - 1),
  });

  // Set subtask fields
  await db
    .update(tasks)
    .set({
      parentTaskId: input.parentTaskId,
      taskType: input.taskType ?? "child",
      subtaskOrder: nextOrder,
      blocksParent: input.blocksParent ?? false,
    })
    .where(eq(tasks.id, subtask.id));

  logger.info(
    { parentTaskId: input.parentTaskId, subtaskId: subtask.id, taskType: input.taskType },
    "Subtask created",
  );

  return { ...subtask, parentTaskId: input.parentTaskId, taskType: input.taskType, subtaskOrder: nextOrder };
}

/**
 * Queue a subtask for execution.
 */
export async function queueSubtask(subtaskId: string) {
  const subtask = await taskService.getTask(subtaskId);
  if (!subtask) throw new Error("Subtask not found");

  await taskService.transitionTask(subtaskId, TaskState.QUEUED, "subtask_queued");
  await taskQueue.add(
    "process-task",
    { taskId: subtaskId },
    {
      jobId: subtaskId,
      priority: subtask.priority ?? 50,
      attempts: subtask.maxRetries + 1,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}

/**
 * Get all subtasks for a parent task, ordered by subtaskOrder.
 */
export async function getSubtasks(parentTaskId: string) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(tasks.subtaskOrder);
}

/**
 * Check if all blocking subtasks of a parent are complete.
 * Returns { allComplete, pending, running, completed, failed }
 */
export async function checkBlockingSubtasks(parentTaskId: string) {
  const subtasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.blocksParent, true)));

  if (subtasks.length === 0) return { allComplete: true, total: 0, pending: 0, running: 0, completed: 0, failed: 0 };

  const completed = subtasks.filter((s) => s.state === "completed").length;
  const failed = subtasks.filter((s) => s.state === "failed").length;
  const running = subtasks.filter((s) => ["running", "provisioning", "queued"].includes(s.state)).length;
  const pending = subtasks.filter((s) => s.state === "pending").length;

  return {
    allComplete: completed === subtasks.length,
    total: subtasks.length,
    pending,
    running,
    completed,
    failed,
  };
}

/**
 * Called when a subtask completes. Checks if the parent should transition.
 */
export async function onSubtaskComplete(subtaskId: string) {
  const subtask = await taskService.getTask(subtaskId);
  if (!subtask?.parentTaskId) return;

  const status = await checkBlockingSubtasks(subtask.parentTaskId);
  if (!status.allComplete) return;

  const parent = await taskService.getTask(subtask.parentTaskId);
  if (!parent) return;

  // All blocking subtasks are done — check if parent should auto-advance
  if (parent.state === "pr_opened") {
    // Check if review approved
    const reviewSubtasks = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.parentTaskId, parent.id),
          eq(tasks.taskType, "review"),
        ),
      );

    const anyApproved = reviewSubtasks.some((r) => r.state === "completed");
    const anyFailed = reviewSubtasks.some((r) => r.state === "failed");

    if (anyApproved && parent.prUrl) {
      logger.info({ taskId: parent.id }, "All blocking subtasks complete, review approved");
      // Could auto-merge here if enabled
    }
  }

  logger.info(
    { parentTaskId: parent.id, status },
    "All blocking subtasks complete",
  );
}
