import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockGetSubtasks = vi.fn();
const mockCreateSubtask = vi.fn();
const mockQueueSubtask = vi.fn();
const mockCheckBlockingSubtasks = vi.fn();

vi.mock("../services/subtask-service.js", () => ({
  getSubtasks: (...args: unknown[]) => mockGetSubtasks(...args),
  createSubtask: (...args: unknown[]) => mockCreateSubtask(...args),
  queueSubtask: (...args: unknown[]) => mockQueueSubtask(...args),
  checkBlockingSubtasks: (...args: unknown[]) => mockCheckBlockingSubtasks(...args),
}));

const mockGetTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
}));

import { subtaskRoutes } from "./subtasks.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1" };
    done();
  });
  await subtaskRoutes(app);
  await app.ready();
  return app;
}

const mockTaskData = {
  id: "task-1",
  workspaceId: "ws-1",
  state: "running",
};

describe("GET /api/tasks/:id/subtasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists subtasks for a task", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetSubtasks.mockResolvedValue([{ id: "sub-1", title: "Step 1", parentTaskId: "task-1" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks" });

    expect(res.statusCode).toBe(200);
    expect(res.json().subtasks).toHaveLength(1);
  });

  it("returns 404 if parent task not found", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent/subtasks" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 if task is in a different workspace", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/subtasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates and auto-queues a child subtask", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      id: "sub-1",
      title: "Child task",
      subtaskOrder: 0,
    });
    mockQueueSubtask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Child task", prompt: "Do the thing", taskType: "child" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().subtask.id).toBe("sub-1");
    expect(mockQueueSubtask).toHaveBeenCalledWith("sub-1");
  });

  it("auto-queues first step but not subsequent steps", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      id: "sub-2",
      title: "Step 2",
      subtaskOrder: 1,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Step 2", prompt: "Do step 2", taskType: "step" },
    });

    expect(res.statusCode).toBe(201);
    // subtaskOrder 1 means not the first step, so should NOT auto-queue
    expect(mockQueueSubtask).not.toHaveBeenCalled();
  });

  it("respects autoQueue=false", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      id: "sub-1",
      title: "Manual task",
      subtaskOrder: 0,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Manual task", prompt: "Wait for me", autoQueue: false },
    });

    expect(res.statusCode).toBe(201);
    expect(mockQueueSubtask).not.toHaveBeenCalled();
  });

  it("rejects missing title (Zod throws)", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { prompt: "Do something" },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("GET /api/tasks/:id/subtasks/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns blocking subtask status", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCheckBlockingSubtasks.mockResolvedValue({
      allComplete: false,
      blockingCount: 2,
      completedCount: 1,
    });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().allComplete).toBe(false);
    expect(res.json().blockingCount).toBe(2);
  });
});
