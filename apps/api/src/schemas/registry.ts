import { ErrorResponseSchema } from "./common.js";
import {
  TaskSchema,
  EnrichedTaskSchema,
  TaskEventSchema,
  LogEntrySchema,
  TaskStatsSchema,
  TaskStateSchema,
  AgentTypeSchema,
  TaskActivitySubstateSchema,
  WorktreeStateSchema,
  TaskTypeSchema,
  TaskCommentSchema,
  TaskMessageSchema,
  TaskDependencySchema,
  SubtaskStatusSchema,
  ActivityItemSchema,
} from "./task.js";
import {
  WorkflowSchema,
  WorkflowRunSchema,
  WorkflowTriggerSchema,
  WorkflowRunLogEntrySchema,
  ScheduleSchema,
  ScheduleRunSchema,
  CronValidationResultSchema,
} from "./workflow.js";

/**
 * Central registry of named schemas surfaced as `components.schemas` in the
 * generated OpenAPI document.
 *
 * `@fastify/swagger` calls `createJsonSchemaTransformObject({ schemas })`
 * once and the resulting transform walks the final spec, replacing any
 * structurally-equal JSON fragment with a `$ref` pointer into
 * `components.schemas`. Names here become the keys of that components map.
 *
 * Add new named schemas as new route phases migrate. Keep names stable —
 * clients generated from the spec use them as TypeScript type identifiers.
 */
export const namedSchemas = {
  ErrorResponse: ErrorResponseSchema,
  Task: TaskSchema,
  EnrichedTask: EnrichedTaskSchema,
  TaskEvent: TaskEventSchema,
  LogEntry: LogEntrySchema,
  TaskStats: TaskStatsSchema,
  TaskState: TaskStateSchema,
  AgentType: AgentTypeSchema,
  TaskActivitySubstate: TaskActivitySubstateSchema,
  WorktreeState: WorktreeStateSchema,
  TaskType: TaskTypeSchema,
  TaskComment: TaskCommentSchema,
  TaskMessage: TaskMessageSchema,
  TaskDependency: TaskDependencySchema,
  SubtaskStatus: SubtaskStatusSchema,
  ActivityItem: ActivityItemSchema,
  Workflow: WorkflowSchema,
  WorkflowRun: WorkflowRunSchema,
  WorkflowTrigger: WorkflowTriggerSchema,
  WorkflowRunLogEntry: WorkflowRunLogEntrySchema,
  Schedule: ScheduleSchema,
  ScheduleRun: ScheduleRunSchema,
  CronValidationResult: CronValidationResultSchema,
} as const;
