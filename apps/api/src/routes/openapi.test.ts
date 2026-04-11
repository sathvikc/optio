/**
 * OpenAPI spec smoke test.
 *
 * Boots the full server and interrogates `app.swagger()` to verify structural
 * invariants we want to preserve across the phased migration.
 *
 * This file gets tighter in each phase: as routes migrate to the Zod type
 * provider, add specific assertions (expected routes carry summary,
 * operationId, tag, response schemas, etc.) to guard against regression.
 *
 * Invariants that hold TODAY (Phase 0 baseline):
 * - Spec is OpenAPI 3.0.3
 * - Info title/version present
 * - The 10 canonical tags are declared
 * - `components.securitySchemes.cookieAuth` and `bearerAuth` exist
 * - `components.schemas.ErrorResponse` exists
 * - The global default `security` requires one of the two schemes
 * - No `/ws/*` path leaks into the spec
 *
 * Invariants that TIGHTEN in later phases:
 * - Every path+method has a non-empty `summary`
 * - Every path+method has a unique `operationId`
 * - Every path+method has at least one `tag`
 * - No response is labelled "Default Response"
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";

// Avoid touching Redis during the build — rate-limit and BullMQ queues
// connect at module-load/register time otherwise.
process.env.OPTIO_SKIP_RATE_LIMIT_REDIS = "1";

type OpenApiSpec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: Array<{ name: string; description?: string }>;
  servers?: Array<{ url: string }>;
  paths: Record<
    string,
    Record<
      string,
      {
        summary?: string;
        operationId?: string;
        tags?: string[];
        responses?: Record<string, { description?: string }>;
      }
    >
  >;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, unknown>>;
};

let app: FastifyInstance;
let spec: OpenApiSpec;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  spec = (app as unknown as { swagger: () => OpenApiSpec }).swagger();
});

afterAll(async () => {
  await app.close();
});

describe("OpenAPI spec — Phase 0 baseline", () => {
  it("declares OpenAPI 3.0.3", () => {
    expect(spec.openapi).toBe("3.0.3");
  });

  it("has title and version", () => {
    expect(spec.info.title).toBe("Optio API");
    expect(spec.info.version).toBeTruthy();
  });

  it("declares the 10 canonical tags with descriptions", () => {
    const expectedTags = [
      "Tasks",
      "Workflows",
      "Sessions",
      "Reviews & PRs",
      "Repos & Integrations",
      "Cluster",
      "Workspaces",
      "Auth & Sessions",
      "Setup & Settings",
      "System",
    ];
    const actualTagNames = (spec.tags ?? []).map((t) => t.name);
    for (const name of expectedTags) {
      expect(actualTagNames, `missing tag ${name}`).toContain(name);
    }
    for (const tag of spec.tags ?? []) {
      expect(tag.description, `tag ${tag.name} missing description`).toBeTruthy();
    }
  });

  it("declares cookieAuth and bearerAuth security schemes", () => {
    expect(spec.components?.securitySchemes).toBeDefined();
    expect(spec.components?.securitySchemes?.cookieAuth).toBeDefined();
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
  });

  it("sets the global default security to require one of the two schemes", () => {
    expect(spec.security).toBeDefined();
    expect(Array.isArray(spec.security)).toBe(true);
    // Two entries, each with one scheme, means "either one of these"
    expect(spec.security?.length).toBe(2);
  });

  it("exposes ErrorResponse as a named component schema", () => {
    expect(spec.components?.schemas).toBeDefined();
    expect(spec.components?.schemas?.ErrorResponse).toBeDefined();
  });

  it("has at least some paths registered", () => {
    const pathCount = Object.keys(spec.paths ?? {}).length;
    expect(pathCount).toBeGreaterThan(50);
  });

  it("does not leak /ws/* paths into the spec", () => {
    const wsPaths = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith("/ws"));
    expect(wsPaths, `WebSocket paths should be hidden: ${wsPaths.join(", ")}`).toHaveLength(0);
  });

  it("does not include the swagger UI's own routes in the spec", () => {
    const docPaths = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith("/docs"));
    expect(docPaths, `/docs paths should be hidden: ${docPaths.join(", ")}`).toHaveLength(0);
  });
});

/**
 * Routes migrated by each phase of the rollout. The union of all entries
 * must always be fully documented — summary, operationId, tag, and at
 * least one response with a non-"Default Response" description.
 *
 * When a new phase lands, add its routes here and the assertion below
 * guards against regressions.
 */
interface MigratedRoute {
  method: string;
  path: string;
  /**
   * True for routes that are intentionally under-schematized in the spec
   * (currently only the multi-content-type log-export endpoint). They must
   * still carry summary/operationId/tag, but are allowed to have zero
   * explicit response schemas.
   */
  lenient?: boolean;
}

const MIGRATED_ROUTES: MigratedRoute[] = [
  // Phase 1 — tasks.ts (14 routes)
  { method: "get", path: "/api/tasks" },
  { method: "get", path: "/api/tasks/stats" },
  { method: "get", path: "/api/tasks/search" },
  { method: "get", path: "/api/tasks/{id}" },
  { method: "post", path: "/api/tasks" },
  { method: "post", path: "/api/tasks/{id}/cancel" },
  { method: "post", path: "/api/tasks/{id}/retry" },
  { method: "post", path: "/api/tasks/{id}/force-redo" },
  { method: "get", path: "/api/tasks/{id}/logs" },
  // Multi-content-type endpoint: body varies by ?format=. Response shapes
  // are documented in the description, not as Zod schemas.
  { method: "get", path: "/api/tasks/{id}/logs/export", lenient: true },
  { method: "get", path: "/api/tasks/{id}/events" },
  { method: "post", path: "/api/tasks/{id}/review" },
  { method: "post", path: "/api/tasks/{id}/run-now" },
  { method: "post", path: "/api/tasks/reorder" },

  // Phase 2 — task ecosystem (19 routes)
  // subtasks.ts (3)
  { method: "get", path: "/api/tasks/{id}/subtasks" },
  { method: "post", path: "/api/tasks/{id}/subtasks" },
  { method: "get", path: "/api/tasks/{id}/subtasks/status" },
  // dependencies.ts (4)
  { method: "get", path: "/api/tasks/{id}/dependencies" },
  { method: "get", path: "/api/tasks/{id}/dependents" },
  { method: "post", path: "/api/tasks/{id}/dependencies" },
  { method: "delete", path: "/api/tasks/{id}/dependencies/{depTaskId}" },
  // bulk.ts (2)
  { method: "post", path: "/api/tasks/bulk/retry-failed" },
  { method: "post", path: "/api/tasks/bulk/cancel-active" },
  // comments.ts (5)
  { method: "get", path: "/api/tasks/{id}/comments" },
  { method: "post", path: "/api/tasks/{id}/comments" },
  { method: "patch", path: "/api/tasks/{taskId}/comments/{commentId}" },
  { method: "delete", path: "/api/tasks/{taskId}/comments/{commentId}" },
  { method: "get", path: "/api/tasks/{id}/activity" },
  // messages.ts (2)
  { method: "post", path: "/api/tasks/{id}/message" },
  { method: "get", path: "/api/tasks/{id}/messages" },
  // resume.ts (2)
  { method: "post", path: "/api/tasks/{id}/resume" },
  { method: "post", path: "/api/tasks/{id}/force-restart" },

  // Phase 3 — workflows & scheduling (24 routes)
  // workflows.ts (12)
  { method: "get", path: "/api/workflows" },
  { method: "post", path: "/api/workflows" },
  { method: "get", path: "/api/workflows/{id}" },
  { method: "patch", path: "/api/workflows/{id}" },
  { method: "post", path: "/api/workflows/{id}/clone" },
  { method: "delete", path: "/api/workflows/{id}" },
  { method: "post", path: "/api/workflows/{id}/runs" },
  { method: "get", path: "/api/workflows/{id}/runs" },
  { method: "get", path: "/api/workflow-runs/{id}" },
  { method: "post", path: "/api/workflow-runs/{id}/retry" },
  { method: "post", path: "/api/workflow-runs/{id}/cancel" },
  { method: "get", path: "/api/workflow-runs/{id}/logs" },
  // workflow-triggers.ts (4)
  { method: "get", path: "/api/workflows/{id}/triggers" },
  { method: "post", path: "/api/workflows/{id}/triggers" },
  { method: "patch", path: "/api/workflows/{id}/triggers/{triggerId}" },
  { method: "delete", path: "/api/workflows/{id}/triggers/{triggerId}" },
  // schedules.ts (8)
  { method: "get", path: "/api/schedules" },
  { method: "get", path: "/api/schedules/{id}" },
  { method: "post", path: "/api/schedules" },
  { method: "patch", path: "/api/schedules/{id}" },
  { method: "delete", path: "/api/schedules/{id}" },
  { method: "post", path: "/api/schedules/{id}/trigger" },
  { method: "get", path: "/api/schedules/{id}/runs" },
  { method: "post", path: "/api/schedules/validate-cron" },
];

describe("OpenAPI spec — migrated routes are fully documented", () => {
  for (const { method, path, lenient } of MIGRATED_ROUTES) {
    it(`${method.toUpperCase()} ${path} has summary, operationId, and tag`, () => {
      const op = spec.paths?.[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path} not in spec`).toBeDefined();
      expect(op?.summary, `${method.toUpperCase()} ${path} missing summary`).toBeTruthy();
      expect(op?.operationId, `${method.toUpperCase()} ${path} missing operationId`).toBeTruthy();
      expect(op?.tags?.length ?? 0, `${method.toUpperCase()} ${path} missing tags`).toBeGreaterThan(
        0,
      );

      if (!lenient) {
        // Must have at least one explicit response schema (not the
        // "Default Response" fallback). Lenient routes opt out — see
        // the `lenient` flag in MIGRATED_ROUTES.
        expect(op?.responses, `${method.toUpperCase()} ${path} missing responses`).toBeDefined();
        const responses = op?.responses ?? {};
        const explicit = Object.values(responses).filter(
          (r) => r.description && r.description !== "Default Response",
        );
        expect(
          explicit.length,
          `${method.toUpperCase()} ${path} has only fallback responses`,
        ).toBeGreaterThan(0);
      }
    });
  }

  it("migrated routes count matches the sum of completed phases", () => {
    // Phase 1 = 14, Phase 2 = 18, Phase 3 = 24
    expect(MIGRATED_ROUTES).toHaveLength(56);
  });

  it("components.schemas contains the Task domain types", () => {
    const schemas = spec.components?.schemas ?? {};
    for (const name of ["Task", "EnrichedTask", "TaskEvent", "LogEntry", "TaskStats"]) {
      expect(schemas[name], `components.schemas.${name} missing`).toBeDefined();
    }
  });
});
