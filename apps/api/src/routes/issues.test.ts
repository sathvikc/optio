import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockRetrieveSecret = vi.fn();
vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
}));

const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("../db/schema.js", () => ({
  repos: { id: "id", workspaceId: "workspaceId" },
  tasks: {
    ticketSource: "ticketSource",
    ticketExternalId: "ticketExternalId",
    id: "id",
    state: "state",
    workspaceId: "workspaceId",
  },
}));

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

import { issueRoutes } from "./issues.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1" };
    done();
  });
  await issueRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/issues", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 503 when no GitHub token is configured", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("No GitHub token");
  });

  it("returns empty issues when no repos are configured", async () => {
    mockRetrieveSecret.mockResolvedValue("ghp_token");

    // repos query returns empty
    const repoChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    // tasks query
    const taskChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect
      .mockReturnValueOnce(repoChain) // repos query (with workspace filter)
      .mockReturnValueOnce(taskChain); // tasks query

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([]);
  });
});

describe("POST /api/issues/assign", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 404 when repo not found", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValue(chainable);

    const res = await app.inject({
      method: "POST",
      url: "/api/issues/assign",
      payload: {
        issueNumber: 42,
        repoId: "nonexistent",
        title: "Fix bug",
        body: "Bug description",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 503 when no GitHub token is configured", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          workspaceId: "ws-1",
        },
      ]),
    };
    mockDbSelect.mockReturnValue(chainable);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));

    const res = await app.inject({
      method: "POST",
      url: "/api/issues/assign",
      payload: {
        issueNumber: 42,
        repoId: "repo-1",
        title: "Fix bug",
        body: "Bug description",
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("No GitHub token");
  });

  it("returns 404 for repo in different workspace", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          workspaceId: "ws-other",
        },
      ]),
    };
    mockDbSelect.mockReturnValue(chainable);

    const res = await app.inject({
      method: "POST",
      url: "/api/issues/assign",
      payload: {
        issueNumber: 42,
        repoId: "repo-1",
        title: "Fix bug",
        body: "Bug description",
      },
    });

    expect(res.statusCode).toBe(404);
  });
});
