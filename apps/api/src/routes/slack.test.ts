import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockHandleSlackAction = vi.fn();
const mockSendSlackNotification = vi.fn();
const mockGetGlobalSlackWebhookUrl = vi.fn();

vi.mock("../services/slack-service.js", () => ({
  handleSlackAction: (...args: unknown[]) => mockHandleSlackAction(...args),
  sendSlackNotification: (...args: unknown[]) => mockSendSlackNotification(...args),
  getGlobalSlackWebhookUrl: (...args: unknown[]) => mockGetGlobalSlackWebhookUrl(...args),
}));

vi.mock("../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import { slackRoutes } from "./slack.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  await slackRoutes(app);
  await app.ready();
  return app;
}

describe("POST /api/webhooks/slack/actions", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("handles a valid Slack action", async () => {
    mockHandleSlackAction.mockResolvedValue({ text: "Task retried successfully" });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/actions",
      payload: {
        actions: [{ action_id: "retry_task", value: "task-1" }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe("Task retried successfully");
    expect(res.json().response_type).toBe("ephemeral");
  });

  it("handles Slack form-encoded payload", async () => {
    mockHandleSlackAction.mockResolvedValue({ text: "Done" });

    const payload = JSON.stringify({
      actions: [{ action_id: "cancel_task", value: "task-2" }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/actions",
      payload: { payload },
    });

    expect(res.statusCode).toBe(200);
    expect(mockHandleSlackAction).toHaveBeenCalledWith("cancel_task", "task-2");
  });

  it("returns 400 when no actions in payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/actions",
      payload: { data: "no actions" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("No actions in payload");
  });

  it("returns 400 when action format is invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/actions",
      payload: { actions: [{ invalid: true }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid action format");
  });

  it("returns 200 with error message on handler failure", async () => {
    mockHandleSlackAction.mockRejectedValue(new Error("Internal error"));

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/actions",
      payload: {
        actions: [{ action_id: "retry_task", value: "task-1" }],
      },
    });

    // Slack expects 200 even on error
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("error");
  });
});

describe("POST /api/slack/test", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("sends a test notification", async () => {
    mockSendSlackNotification.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/slack/test",
      payload: { webhookUrl: "https://hooks.slack.com/services/xxx" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("returns 400 on notification failure", async () => {
    mockSendSlackNotification.mockRejectedValue(new Error("Invalid webhook URL"));

    const res = await app.inject({
      method: "POST",
      url: "/api/slack/test",
      payload: { webhookUrl: "https://hooks.slack.com/services/xxx" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });
});

describe("GET /api/slack/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns Slack configuration status", async () => {
    mockGetGlobalSlackWebhookUrl.mockResolvedValue("https://hooks.slack.com/services/xxx");

    const res = await app.inject({ method: "GET", url: "/api/slack/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().globalWebhookConfigured).toBe(true);
  });

  it("returns false when no global webhook is configured", async () => {
    mockGetGlobalSlackWebhookUrl.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/slack/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().globalWebhookConfigured).toBe(false);
  });
});
