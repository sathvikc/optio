import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSkills = vi.fn();
const mockGetSkill = vi.fn();
const mockCreateSkill = vi.fn();
const mockUpdateSkill = vi.fn();
const mockDeleteSkill = vi.fn();

vi.mock("../services/skill-service.js", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
  createSkill: (...args: unknown[]) => mockCreateSkill(...args),
  updateSkill: (...args: unknown[]) => mockUpdateSkill(...args),
  deleteSkill: (...args: unknown[]) => mockDeleteSkill(...args),
}));

import { skillRoutes } from "./skills.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1" };
    done();
  });
  await skillRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/skills", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists skills", async () => {
    mockListSkills.mockResolvedValue([{ id: "skill-1", name: "lint" }]);

    const res = await app.inject({ method: "GET", url: "/api/skills" });

    expect(res.statusCode).toBe(200);
    expect(res.json().skills).toHaveLength(1);
    expect(mockListSkills).toHaveBeenCalledWith(undefined, "ws-1");
  });
});

describe("POST /api/skills", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a skill", async () => {
    mockCreateSkill.mockResolvedValue({ id: "skill-1", name: "lint" });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { name: "lint", prompt: "Run linting" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lint", prompt: "Run linting" }),
      "ws-1",
    );
  });

  it("rejects missing prompt (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { name: "lint" },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("PATCH /api/skills/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a skill", async () => {
    mockGetSkill.mockResolvedValue({ id: "skill-1" });
    mockUpdateSkill.mockResolvedValue({ id: "skill-1", enabled: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/skills/skill-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for nonexistent skill", async () => {
    mockGetSkill.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/skills/nonexistent",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/skills/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a skill", async () => {
    mockGetSkill.mockResolvedValue({ id: "skill-1" });
    mockDeleteSkill.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/skills/skill-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent skill", async () => {
    mockGetSkill.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/skills/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});
