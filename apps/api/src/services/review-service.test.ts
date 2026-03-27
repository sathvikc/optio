import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../db/schema.js", () => ({
  repos: { repoUrl: "repoUrl", workspaceId: "workspaceId" },
  workspaces: { id: "id", slug: "slug" },
  tasks: {},
  taskEvents: {},
  taskLogs: {},
}));

const mockGetTask = vi.fn();
const mockTransitionTask = vi.fn();

vi.mock("./task-service.js", () => ({
  getTask: (...args: any[]) => mockGetTask(...args),
  transitionTask: (...args: any[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: (...args: any[]) => mockQueueAdd(...args) },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock subtask-service (dynamic import in launchReview)
const mockCreateSubtask = vi.fn();
const mockQueueSubtask = vi.fn();

vi.mock("./subtask-service.js", () => ({
  createSubtask: (...args: any[]) => mockCreateSubtask(...args),
  queueSubtask: (...args: any[]) => mockQueueSubtask(...args),
}));

import { db } from "../db/client.js";
import { launchReview } from "./review-service.js";

// ── launchReview ────────────────────────────────────────────────────

describe("launchReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when parent task is not found", async () => {
    mockGetTask.mockResolvedValueOnce(null);

    await expect(launchReview("nonexistent")).rejects.toThrow("Parent task not found");
  });

  it("throws when parent task has no PR", async () => {
    mockGetTask.mockResolvedValueOnce({
      id: "task-1",
      title: "Test Task",
      prUrl: null,
      repoUrl: "https://github.com/org/repo",
    });

    await expect(launchReview("task-1")).rejects.toThrow("Parent task has no PR");
  });

  it("throws when PR number cannot be parsed from URL", async () => {
    mockGetTask.mockResolvedValueOnce({
      id: "task-1",
      title: "Test Task",
      prUrl: "https://github.com/org/repo",
      repoUrl: "https://github.com/org/repo",
    });

    await expect(launchReview("task-1")).rejects.toThrow("Cannot parse PR number");
  });

  it("creates a review subtask and queues it", async () => {
    const parentTask = {
      id: "task-1",
      title: "Implement feature X",
      prompt: "Add feature X",
      prUrl: "https://github.com/org/repo/pull/42",
      repoUrl: "https://github.com/org/repo.git",
    };

    mockGetTask.mockResolvedValueOnce(parentTask);

    // Repo config query (first call is getDefaultWorkspaceId, second is the repo lookup)
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { reviewPromptTemplate: null, testCommand: "npm test", reviewModel: "haiku" },
      ]);

    const reviewSubtask = { id: "review-1", title: "Review: Implement feature X" };
    mockCreateSubtask.mockResolvedValueOnce(reviewSubtask);
    mockTransitionTask.mockResolvedValueOnce({ id: "review-1", state: "queued" });

    const reviewId = await launchReview("task-1");

    expect(reviewId).toBe("review-1");

    // Verify subtask was created correctly
    expect(mockCreateSubtask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: "task-1",
        title: "Review: Implement feature X",
        prompt: expect.stringContaining("PR #42"),
        taskType: "review",
        blocksParent: true,
        agentType: "claude-code",
      }),
    );

    // Verify task was transitioned to queued
    expect(mockTransitionTask).toHaveBeenCalledWith("review-1", "queued", "review_requested");

    // Verify job was added to queue with review overrides
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "review-1",
        reviewOverride: expect.objectContaining({
          renderedPrompt: expect.any(String),
          taskFileContent: expect.stringContaining("Implement feature X"),
          claudeModel: "haiku",
        }),
      }),
      expect.objectContaining({
        priority: 10,
      }),
    );
  });

  it("uses default review model when repo has no reviewModel configured", async () => {
    const parentTask = {
      id: "task-2",
      title: "Fix bug",
      prompt: "Fix bug Y",
      prUrl: "https://github.com/org/repo/pull/10",
      repoUrl: "https://github.com/org/repo",
    };

    mockGetTask.mockResolvedValueOnce(parentTask);

    // No repo config (first call is getDefaultWorkspaceId, second is the repo lookup)
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockCreateSubtask.mockResolvedValueOnce({ id: "review-2" });
    mockTransitionTask.mockResolvedValueOnce({ id: "review-2", state: "queued" });

    await launchReview("task-2");

    // Should use default model "sonnet"
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        reviewOverride: expect.objectContaining({
          claudeModel: "sonnet",
        }),
      }),
      expect.any(Object),
    );
  });

  it("includes review context with PR details", async () => {
    const parentTask = {
      id: "task-3",
      title: "Add tests",
      prompt: "Write unit tests for module Z",
      prUrl: "https://github.com/org/repo/pull/99",
      repoUrl: "https://github.com/org/repo",
    };

    mockGetTask.mockResolvedValueOnce(parentTask);
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockCreateSubtask.mockResolvedValueOnce({ id: "review-3" });
    mockTransitionTask.mockResolvedValueOnce({ id: "review-3" });

    await launchReview("task-3");

    const queueCall = mockQueueAdd.mock.calls[0];
    const taskFileContent = queueCall[1].reviewOverride.taskFileContent;

    expect(taskFileContent).toContain("Add tests");
    expect(taskFileContent).toContain("Write unit tests for module Z");
    expect(taskFileContent).toContain("#99");
    expect(taskFileContent).toContain("optio/task-task-3");
  });
});
