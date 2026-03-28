import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSecrets = vi.fn();
const mockRetrieveSecret = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
}));

const mockCheckRuntimeHealth = vi.fn();
vi.mock("../services/container-service.js", () => ({
  checkRuntimeHealth: (...args: unknown[]) => mockCheckRuntimeHealth(...args),
}));

vi.mock("../services/auth-service.js", () => ({
  isSubscriptionAvailable: () => false,
}));

import { setupRoutes } from "./setup.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  await setupRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/setup/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns fully set up when all keys exist and runtime is healthy", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSetUp).toBe(true);
    expect(body.steps.runtime.done).toBe(true);
    expect(body.steps.githubToken.done).toBe(true);
    expect(body.steps.anthropicKey.done).toBe(true);
    expect(body.steps.anyAgentKey.done).toBe(true);
  });

  it("returns not set up when no agent key exists", async () => {
    mockListSecrets.mockResolvedValue([{ name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().isSetUp).toBe(false);
    expect(res.json().steps.anyAgentKey.done).toBe(false);
  });

  it("returns not set up when runtime is unhealthy", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(false);
    expect(res.json().steps.runtime.done).toBe(false);
  });

  it("detects OAuth token mode", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN" },
    ]);
    mockRetrieveSecret.mockImplementation(async (name: string) => {
      if (name === "CLAUDE_AUTH_MODE") return "oauth-token";
      throw new Error("not found");
    });
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });
});

describe("POST /api/setup/validate/github-token", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no token is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().valid).toBe(false);
  });

  it("validates a valid GitHub token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test User" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_valid_token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(res.json().user.login).toBe("testuser");
  });

  it("returns invalid for bad token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "bad-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });
});

describe("POST /api/setup/validate/anthropic-key", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no key is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("validates a valid Anthropic key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: { key: "sk-ant-valid" },
    });

    expect(res.json().valid).toBe(true);
  });
});

describe("POST /api/setup/validate/openai-key", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no key is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/openai-key",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/setup/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no token provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Token is required");
  });

  it("lists repos for a valid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            full_name: "org/repo",
            html_url: "https://github.com/org/repo",
            clone_url: "https://github.com/org/repo.git",
            default_branch: "main",
            private: false,
            description: "A repo",
            language: "TypeScript",
            pushed_at: "2026-03-27T10:00:00Z",
          },
        ],
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: { token: "ghp_valid" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toHaveLength(1);
    expect(res.json().repos[0].fullName).toBe("org/repo");
  });
});
