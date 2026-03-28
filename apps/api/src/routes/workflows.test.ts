import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListWorkflowTemplates = vi.fn();
const mockGetWorkflowTemplate = vi.fn();
const mockCreateWorkflowTemplate = vi.fn();
const mockUpdateWorkflowTemplate = vi.fn();
const mockDeleteWorkflowTemplate = vi.fn();
const mockRunWorkflow = vi.fn();
const mockListWorkflowRuns = vi.fn();
const mockGetWorkflowRun = vi.fn();

vi.mock("../services/workflow-service.js", () => ({
  listWorkflowTemplates: (...args: unknown[]) => mockListWorkflowTemplates(...args),
  getWorkflowTemplate: (...args: unknown[]) => mockGetWorkflowTemplate(...args),
  createWorkflowTemplate: (...args: unknown[]) => mockCreateWorkflowTemplate(...args),
  updateWorkflowTemplate: (...args: unknown[]) => mockUpdateWorkflowTemplate(...args),
  deleteWorkflowTemplate: (...args: unknown[]) => mockDeleteWorkflowTemplate(...args),
  runWorkflow: (...args: unknown[]) => mockRunWorkflow(...args),
  listWorkflowRuns: (...args: unknown[]) => mockListWorkflowRuns(...args),
  getWorkflowRun: (...args: unknown[]) => mockGetWorkflowRun(...args),
}));

import { workflowRoutes } from "./workflows.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { id: "user-1", workspaceId: "ws-1" };
    done();
  });
  await workflowRoutes(app);
  await app.ready();
  return app;
}

const mockStep = { id: "step-1", title: "Step 1", prompt: "Do step 1" };

describe("GET /api/workflow-templates", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists templates scoped to workspace", async () => {
    mockListWorkflowTemplates.mockResolvedValue([{ id: "wf-1", name: "Deploy" }]);

    const res = await app.inject({ method: "GET", url: "/api/workflow-templates" });

    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toHaveLength(1);
    expect(mockListWorkflowTemplates).toHaveBeenCalledWith("ws-1");
  });
});

describe("POST /api/workflow-templates", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a workflow template", async () => {
    mockCreateWorkflowTemplate.mockResolvedValue({ id: "wf-1", name: "Deploy" });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflow-templates",
      payload: { name: "Deploy", steps: [mockStep] },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkflowTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Deploy", workspaceId: "ws-1", createdBy: "user-1" }),
    );
  });

  it("rejects empty steps array (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow-templates",
      payload: { name: "Empty", steps: [] },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("POST /api/workflow-templates/:id/run", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("runs a workflow", async () => {
    mockRunWorkflow.mockResolvedValue({ id: "run-1", status: "running" });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflow-templates/wf-1/run",
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      "wf-1",
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
  });

  it("returns 400 when run fails", async () => {
    mockRunWorkflow.mockRejectedValue(new Error("Template not found"));

    const res = await app.inject({
      method: "POST",
      url: "/api/workflow-templates/nonexistent/run",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/workflow-runs/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a workflow run", async () => {
    mockGetWorkflowRun.mockResolvedValue({ id: "run-1" });

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/run-1" });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for nonexistent run", async () => {
    mockGetWorkflowRun.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});
