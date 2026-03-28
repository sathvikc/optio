import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockTransitionTask = vi.fn();

vi.mock("../services/task-service.js", () => ({
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: { id: "id", state: "state", workspaceId: "workspaceId" },
}));

import { bulkRoutes } from "./bulk.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1", workspaceRole: "admin" };
    done();
  });
  await bulkRoutes(app);
  await app.ready();
  return app;
}

describe("POST /api/tasks/bulk/retry-failed", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("retries all failed tasks", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "task-1" }, { id: "task-2" }]),
    };
    mockDbSelect.mockReturnValue(chainable);
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/retry-failed" });

    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(2);
    expect(res.json().total).toBe(2);
    expect(mockTransitionTask).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("skips tasks that fail to transition", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "task-1" }, { id: "task-2" }]),
    };
    mockDbSelect.mockReturnValue(chainable);
    mockTransitionTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Invalid transition"));

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/retry-failed" });

    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(1);
    expect(res.json().total).toBe(2);
  });

  it("returns zero when no failed tasks exist", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValue(chainable);

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/retry-failed" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ retried: 0, total: 0 });
  });
});

describe("POST /api/tasks/bulk/cancel-active", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("cancels all running and queued tasks", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
    };
    chainable.where
      .mockResolvedValueOnce([{ id: "task-1", state: "running" }]) // running
      .mockResolvedValueOnce([{ id: "task-2", state: "queued" }]); // queued

    mockDbSelect.mockReturnValue(chainable);
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/cancel-active" });

    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toBe(2);
    expect(res.json().total).toBe(2);
  });
});
