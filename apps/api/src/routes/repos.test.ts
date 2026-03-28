import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListRepos = vi.fn();
const mockGetRepo = vi.fn();
const mockGetRepoByUrl = vi.fn();
const mockCreateRepo = vi.fn();
const mockUpdateRepo = vi.fn();
const mockDeleteRepo = vi.fn();

vi.mock("../services/repo-service.js", () => ({
  listRepos: (...args: unknown[]) => mockListRepos(...args),
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
  getRepoByUrl: (...args: unknown[]) => mockGetRepoByUrl(...args),
  createRepo: (...args: unknown[]) => mockCreateRepo(...args),
  updateRepo: (...args: unknown[]) => mockUpdateRepo(...args),
  deleteRepo: (...args: unknown[]) => mockDeleteRepo(...args),
}));

vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: vi.fn().mockRejectedValue(new Error("not found")),
}));

vi.mock("../services/repo-detect-service.js", () => ({
  detectRepoConfig: vi.fn().mockResolvedValue({ imagePreset: "node", testCommand: "npm test" }),
}));

import { repoRoutes } from "./repos.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1", workspaceRole: "admin" };
    done();
  });
  await repoRoutes(app);
  await app.ready();
  return app;
}

const mockRepoData = {
  id: "repo-1",
  repoUrl: "https://github.com/org/repo",
  fullName: "org/repo",
  workspaceId: "ws-1",
  cpuRequest: null,
  cpuLimit: null,
  memoryRequest: null,
  memoryLimit: null,
};

describe("GET /api/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists repos scoped to workspace", async () => {
    mockListRepos.mockResolvedValue([mockRepoData]);

    const res = await app.inject({ method: "GET", url: "/api/repos" });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toHaveLength(1);
    expect(mockListRepos).toHaveBeenCalledWith("ws-1");
  });
});

describe("GET /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().repo.id).toBe("repo-1");
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/repos/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for repo in different workspace", async () => {
    mockGetRepo.mockResolvedValue({ ...mockRepoData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a repo", async () => {
    mockGetRepoByUrl.mockResolvedValue(null);
    mockCreateRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
        workspaceId: "ws-1",
      }),
    );
  });

  it("rejects duplicate repo", async () => {
    mockGetRepoByUrl.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already been added");
  });

  it("rejects missing required fields (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: "https://github.com/org/repo" },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("PATCH /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, imagePreset: "node" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { imagePreset: "node" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ imagePreset: "node" }),
    );
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/nonexistent",
      payload: { imagePreset: "node" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects invalid CPU quantity", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { cpuRequest: "invalid" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("rejects invalid memory quantity", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { memoryRequest: "invalid" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockDeleteRepo.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteRepo).toHaveBeenCalledWith("repo-1");
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/repos/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});
