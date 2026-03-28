import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListNode = vi.fn();
const mockListNamespacedPod = vi.fn();
const mockListNamespacedService = vi.fn();
const mockListNamespacedEvent = vi.fn();
const mockReadNamespacedPod = vi.fn();
const mockListClusterCustomObject = vi.fn();
const mockListNamespacedCustomObject = vi.fn();

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn().mockReturnValue({
      listNode: mockListNode,
      listNamespacedPod: mockListNamespacedPod,
      listNamespacedService: mockListNamespacedService,
      listNamespacedEvent: mockListNamespacedEvent,
      readNamespacedPod: mockReadNamespacedPod,
      listClusterCustomObject: mockListClusterCustomObject,
      listNamespacedCustomObject: mockListNamespacedCustomObject,
    }),
  })),
  CoreV1Api: vi.fn(),
  CustomObjectsApi: vi.fn(),
}));

// Use a flexible chainable mock for all db operations
const createChainable = (resolvedValue: any = []) => {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.groupBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((resolve: any) => resolve(resolvedValue));
  // Make it thennable (Promise-like)
  Object.defineProperty(chain, Symbol.toStringTag, { value: "Promise" });
  return chain;
};

const mockDbSelectChain = createChainable([]);
const mockDbDeleteChain = createChainable();
const mockDbInsertChain = createChainable();

vi.mock("../db/client.js", () => ({
  db: {
    select: () => mockDbSelectChain,
    delete: () => mockDbDeleteChain,
    insert: () => mockDbInsertChain,
  },
}));

vi.mock("../db/schema.js", () => ({
  repoPods: { id: "id", workspaceId: "workspaceId" },
  tasks: {
    id: "id",
    title: "title",
    state: "state",
    agentType: "agentType",
    createdAt: "createdAt",
    repoUrl: "repoUrl",
    lastPodId: "lastPodId",
    workspaceId: "workspaceId",
  },
  podHealthEvents: { createdAt: "createdAt" },
  repos: {
    repoUrl: "repoUrl",
    maxConcurrentTasks: "maxConcurrentTasks",
    maxPodInstances: "maxPodInstances",
    maxAgentsPerPod: "maxAgentsPerPod",
  },
}));

vi.mock("../services/container-service.js", () => ({
  getRuntime: () => ({
    destroy: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { clusterRoutes } from "./cluster.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: null, workspaceRole: "admin" };
    done();
  });
  await clusterRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/cluster/overview", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 500 when K8s API fails", async () => {
    mockListNode.mockRejectedValue(new Error("K8s API unavailable"));

    const res = await app.inject({ method: "GET", url: "/api/cluster/overview" });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("K8s API unavailable");
  });
});

describe("GET /api/cluster/pods", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns pods from database", async () => {
    // Reset the chainable mock to return pods
    mockDbSelectChain.then.mockImplementation((resolve: any) =>
      resolve([
        {
          id: "pod-1",
          repoUrl: "https://github.com/org/repo",
          podName: "optio-repo-1",
          state: "ready",
        },
      ]),
    );
    // For the recentTasks sub-query, the second time through the chain
    mockDbSelectChain.limit.mockReturnValue({
      then: vi.fn().mockImplementation((resolve: any) => resolve([])),
      [Symbol.toStringTag]: "Promise",
    });

    const res = await app.inject({ method: "GET", url: "/api/cluster/pods" });

    expect(res.statusCode).toBe(200);
    // The response should contain a pods array
    expect(res.json().pods).toBeDefined();
  });
});

describe("GET /api/cluster/pods/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 404 for nonexistent pod", async () => {
    mockDbSelectChain.where.mockReturnValueOnce({
      then: vi.fn().mockImplementation((resolve: any) => resolve([])),
      [Symbol.toStringTag]: "Promise",
    });

    const res = await app.inject({ method: "GET", url: "/api/cluster/pods/nonexistent" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Pod not found");
  });
});

describe("GET /api/cluster/health-events", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns health events", async () => {
    mockDbSelectChain.limit.mockReturnValueOnce({
      then: vi
        .fn()
        .mockImplementation((resolve: any) =>
          resolve([{ id: "event-1", eventType: "crashed", message: "OOM killed" }]),
        ),
      [Symbol.toStringTag]: "Promise",
    });

    const res = await app.inject({ method: "GET", url: "/api/cluster/health-events" });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toBeDefined();
  });
});

describe("POST /api/cluster/pods/:id/restart", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 404 for nonexistent pod", async () => {
    mockDbSelectChain.where.mockReturnValueOnce({
      then: vi.fn().mockImplementation((resolve: any) => resolve([])),
      [Symbol.toStringTag]: "Promise",
    });

    const res = await app.inject({ method: "POST", url: "/api/cluster/pods/nonexistent/restart" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Pod not found");
  });
});
