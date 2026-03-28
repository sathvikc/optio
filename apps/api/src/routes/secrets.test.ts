import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSecrets = vi.fn();
const mockStoreSecret = vi.fn();
const mockDeleteSecret = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
  deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
}));

import { secretRoutes } from "./secrets.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1", workspaceRole: "admin" };
    done();
  });
  await secretRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/secrets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists secrets with workspace scoping", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN", scope: "global" },
      { name: "ANTHROPIC_API_KEY", scope: "global" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/secrets" });

    expect(res.statusCode).toBe(200);
    expect(res.json().secrets).toHaveLength(2);
    expect(mockListSecrets).toHaveBeenCalledWith(undefined, "ws-1");
  });

  it("passes scope query parameter", async () => {
    mockListSecrets.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/secrets?scope=repo:my-repo" });

    expect(res.statusCode).toBe(200);
    expect(mockListSecrets).toHaveBeenCalledWith("repo:my-repo", "ws-1");
  });
});

describe("POST /api/secrets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a secret", async () => {
    mockStoreSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "MY_SECRET", value: "super-secret-value" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "MY_SECRET", scope: "global" });
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "MY_SECRET",
      "super-secret-value",
      undefined,
      "ws-1",
    );
  });

  it("creates a secret with custom scope", async () => {
    mockStoreSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "REPO_KEY", value: "val", scope: "repo:my-repo" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "REPO_KEY", scope: "repo:my-repo" });
    expect(mockStoreSecret).toHaveBeenCalledWith("REPO_KEY", "val", "repo:my-repo", "ws-1");
  });

  it("rejects missing name (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { value: "val" },
    });

    expect(res.statusCode).toBe(500);
  });

  it("rejects missing value (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "KEY" },
    });

    expect(res.statusCode).toBe(500);
  });

  it("rejects empty name (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "", value: "val" },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("DELETE /api/secrets/:name", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a secret", async () => {
    mockDeleteSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/secrets/MY_SECRET",
    });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteSecret).toHaveBeenCalledWith("MY_SECRET", undefined, "ws-1");
  });

  it("passes scope query parameter when deleting", async () => {
    mockDeleteSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/secrets/MY_SECRET?scope=repo:r",
    });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteSecret).toHaveBeenCalledWith("MY_SECRET", "repo:r", "ws-1");
  });
});
