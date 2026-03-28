import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockGetDependencies = vi.fn();
const mockGetDependents = vi.fn();
const mockAddDependencies = vi.fn();
const mockRemoveDependency = vi.fn();

vi.mock("../services/dependency-service.js", () => ({
  getDependencies: (...args: unknown[]) => mockGetDependencies(...args),
  getDependents: (...args: unknown[]) => mockGetDependents(...args),
  addDependencies: (...args: unknown[]) => mockAddDependencies(...args),
  removeDependency: (...args: unknown[]) => mockRemoveDependency(...args),
}));

const mockGetTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
}));

import { dependencyRoutes } from "./dependencies.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  await dependencyRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/tasks/:id/dependencies", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists dependencies", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockGetDependencies.mockResolvedValue([{ id: "dep-1" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/dependencies" });

    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies).toHaveLength(1);
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent/dependencies" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/tasks/:id/dependents", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists dependents", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockGetDependents.mockResolvedValue([{ id: "dep-1" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/dependents" });

    expect(res.statusCode).toBe(200);
    expect(res.json().dependents).toHaveLength(1);
  });
});

describe("POST /api/tasks/:id/dependencies", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("adds dependencies", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockAddDependencies.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/dependencies",
      payload: { dependsOnIds: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddDependencies).toHaveBeenCalledWith("task-1", [
      "00000000-0000-0000-0000-000000000001",
    ]);
  });

  it("returns 400 when addDependencies throws", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1" });
    mockAddDependencies.mockRejectedValue(new Error("Circular dependency"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/dependencies",
      payload: { dependsOnIds: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Circular dependency");
  });

  it("rejects empty dependsOnIds (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/dependencies",
      payload: { dependsOnIds: [] },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("DELETE /api/tasks/:id/dependencies/:depTaskId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("removes a dependency", async () => {
    mockRemoveDependency.mockResolvedValue(true);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/dependencies/task-2",
    });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent dependency", async () => {
    mockRemoveDependency.mockResolvedValue(false);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/dependencies/nonexistent",
    });

    expect(res.statusCode).toBe(404);
  });
});
