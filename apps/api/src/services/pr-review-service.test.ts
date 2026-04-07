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
    delete: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  repos: { id: "id", repoUrl: "repoUrl", workspaceId: "workspaceId" },
  tasks: { id: "id", taskType: "taskType", prUrl: "prUrl", prNumber: "prNumber" },
  taskLogs: { taskId: "taskId", content: "content", logType: "logType" },
  reviewDrafts: {
    id: "id",
    taskId: "taskId",
    prUrl: "prUrl",
    prNumber: "prNumber",
    repoOwner: "repoOwner",
    repoName: "repoName",
    headSha: "headSha",
    state: "state",
  },
}));

const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();
const mockGetTask = vi.fn();

vi.mock("./task-service.js", () => ({
  createTask: (...args: any[]) => mockCreateTask(...args),
  transitionTask: (...args: any[]) => mockTransitionTask(...args),
  getTask: (...args: any[]) => mockGetTask(...args),
}));

const mockGetGitHubToken = vi.fn().mockResolvedValue("ghp_test_token");

vi.mock("./github-token-service.js", () => ({
  getGitHubToken: (...args: any[]) => mockGetGitHubToken(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: (...args: any[]) => mockQueueAdd(...args) },
}));

const mockPublishEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("./event-bus.js", () => ({
  publishEvent: (...args: any[]) => mockPublishEvent(...args),
}));

const mockGetRepoByUrl = vi.fn();

vi.mock("./repo-service.js", () => ({
  getRepoByUrl: (...args: any[]) => mockGetRepoByUrl(...args),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { db } from "../db/client.js";
import {
  launchPrReview,
  parseReviewOutput,
  getReviewDraft,
  updateReviewDraft,
  submitReviewToGitHub,
  getPrStatus,
  listOpenPrs,
  mergePr,
  reReview,
  markDraftStale,
} from "./pr-review-service.js";

// ── Helpers ─────────────────────────────────────────────────────────

function mockJsonResponse(data: any, status = 200, ok = true) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

const sampleDraft = {
  id: "draft-1",
  taskId: "task-1",
  prUrl: "https://github.com/acme/widgets/pull/42",
  prNumber: 42,
  repoOwner: "acme",
  repoName: "widgets",
  headSha: "abc123",
  state: "ready",
  verdict: "approve",
  summary: "Looks good!",
  fileComments: [{ path: "src/index.ts", line: 10, body: "Nit: rename this" }],
  submittedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const sampleRepoConfig = {
  id: "repo-1",
  repoUrl: "https://github.com/acme/widgets",
  fullName: "acme/widgets",
  defaultBranch: "main",
  workspaceId: "ws-1",
  reviewPromptTemplate: null,
  reviewModel: null,
  testCommand: "npm test",
};

// ── launchPrReview ──────────────────────────────────────────────────

describe("launchPrReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockResolvedValue("ghp_test_token");
  });

  it("throws for an invalid PR URL format", async () => {
    await expect(launchPrReview({ prUrl: "https://github.com/acme/widgets" })).rejects.toThrow(
      "Invalid PR URL",
    );
  });

  it("throws for a malformed URL without a PR number", async () => {
    await expect(
      launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/" }),
    ).rejects.toThrow("Invalid PR URL");
  });

  it("throws when the repo is not configured in Optio", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce(null);

    await expect(
      launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/42" }),
    ).rejects.toThrow("not configured in Optio");
  });

  it("creates a task and review draft for a valid PR URL", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce(sampleRepoConfig);

    // fetchPrContext: PR data, reviews, comments, inline comments
    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({
          title: "Add feature X",
          body: "Implements feature X",
          head: { sha: "abc123" },
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    const createdTask = { id: "task-new", title: "Review: PR #42 - Add feature X" };
    mockCreateTask.mockResolvedValueOnce(createdTask);

    // db.update(tasks).set(...).where(...)
    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    // db.insert(reviewDrafts).values(...).returning()
    const draftRow = { id: "draft-new", taskId: "task-new", state: "drafting" };
    vi.mocked(db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([draftRow]),
      }),
    });

    mockTransitionTask.mockResolvedValueOnce(undefined);

    const result = await launchPrReview({
      prUrl: "https://github.com/acme/widgets/pull/42",
      workspaceId: "ws-1",
    });

    expect(result.task.id).toBe("task-new");
    expect(result.task.taskType).toBe("pr_review");
    expect(result.task.prNumber).toBe(42);
    expect(result.draft.id).toBe("draft-new");

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Review: PR #42 - Add feature X",
        repoUrl: "https://github.com/acme/widgets",
        agentType: "claude-code",
      }),
    );

    expect(mockTransitionTask).toHaveBeenCalledWith("task-new", "queued", "pr_review_requested");
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "task-new",
        reviewOverride: expect.objectContaining({
          renderedPrompt: expect.any(String),
          taskFileContent: expect.stringContaining("PR #42"),
          claudeModel: "sonnet",
        }),
      }),
      expect.objectContaining({ jobId: "task-new", priority: 10 }),
    );
  });

  it("renders the prompt with template variables", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce({
      ...sampleRepoConfig,
      reviewPromptTemplate: "Review PR #{{PR_NUMBER}} in {{REPO_NAME}}. Run: {{TEST_COMMAND}}",
      reviewModel: "haiku",
    });

    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({
          title: "Fix bug",
          body: "Fixes bug",
          head: { sha: "def456" },
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    mockCreateTask.mockResolvedValueOnce({ id: "task-tpl" });

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    vi.mocked(db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "draft-tpl", taskId: "task-tpl" }]),
      }),
    });
    mockTransitionTask.mockResolvedValueOnce(undefined);

    await launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/10" });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        reviewOverride: expect.objectContaining({
          renderedPrompt: "Review PR #10 in acme/widgets. Run: npm test",
          claudeModel: "haiku",
        }),
      }),
      expect.any(Object),
    );
  });

  it("falls back to default review prompt when repo has no reviewPromptTemplate", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce({ ...sampleRepoConfig, reviewPromptTemplate: null });

    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ title: "Chore", body: "", head: { sha: "sha1" } }))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    mockCreateTask.mockResolvedValueOnce({ id: "task-def" });
    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    vi.mocked(db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "draft-def", taskId: "task-def" }]),
      }),
    });
    mockTransitionTask.mockResolvedValueOnce(undefined);

    await launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/5" });

    // The default template contains "code review assistant"
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        reviewOverride: expect.objectContaining({
          renderedPrompt: expect.stringContaining("code review assistant"),
        }),
      }),
      expect.any(Object),
    );
  });

  it("throws when PR head SHA is empty", async () => {
    mockGetRepoByUrl.mockResolvedValueOnce(sampleRepoConfig);

    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ title: "PR", body: "", head: { sha: "" } }))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    await expect(
      launchPrReview({ prUrl: "https://github.com/acme/widgets/pull/99" }),
    ).rejects.toThrow("Could not determine PR head SHA");
  });
});

// ── parseReviewOutput ───────────────────────────────────────────────

describe("parseReviewOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips if no review draft found for the task", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await parseReviewOutput("task-no-draft");

    // Should not call update
    expect(db.update).not.toHaveBeenCalled();
  });

  it("parses JSON verdict from a markdown code block in task logs", async () => {
    const selectMock = vi.fn();
    const fromMock = vi.fn();
    const whereMock = vi.fn();

    // First call: select reviewDrafts → return draft
    // Second call: select taskLogs → return logs
    let callCount = 0;
    selectMock.mockImplementation(() => {
      callCount++;
      return { from: fromMock };
    });
    fromMock.mockImplementation(() => ({ where: whereMock }));
    whereMock.mockImplementation(() => {
      if (callCount === 1) {
        return Promise.resolve([{ id: "draft-1", taskId: "task-1" }]);
      }
      return Promise.resolve([
        {
          content: '```json\n{"verdict": "approve", "summary": "LGTM", "fileComments": []}\n```',
          logType: "tool_result",
        },
      ]);
    });

    vi.mocked(db.select as any).mockImplementation(selectMock);

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-1");

    expect(db.update).toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "ready",
        verdict: "approve",
        summary: "LGTM",
      }),
    );
  });

  it("parses raw JSON verdict from logs", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-2", taskId: "task-2" }]);
            return Promise.resolve([
              {
                content: '{"verdict": "request_changes", "summary": "Needs work"}',
                logType: "text",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-2");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: "request_changes",
        summary: "Needs work",
      }),
    );
  });

  it("handles JSON with trailing commas", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-3", taskId: "task-3" }]);
            return Promise.resolve([
              {
                content: '```json\n{"verdict": "comment", "summary": "Minor nits",}\n```',
                logType: "tool_result",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-3");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: "comment",
        summary: "Minor nits",
      }),
    );
  });

  it("falls back to task resultSummary when no structured output exists", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-4", taskId: "task-4" }]);
            return Promise.resolve([
              { content: "Some plain text log with no JSON", logType: "text" },
            ]);
          }),
        }),
      };
    });

    mockGetTask.mockResolvedValueOnce({ id: "task-4", resultSummary: "Task completed well" });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-4");

    expect(mockGetTask).toHaveBeenCalledWith("task-4");
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "ready",
        summary: "Task completed well",
      }),
    );
  });

  it("ignores invalid verdict values", async () => {
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-5", taskId: "task-5" }]);
            return Promise.resolve([
              {
                content: '{"verdict": "reject", "summary": "Bad"}',
                logType: "text",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-5");

    // "reject" is not in the allowed set; verdict should not be set
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ state: "ready" }));
    const setArg = updateSetMock.mock.calls[0][0];
    expect(setArg.verdict).toBeUndefined();
  });

  it("stores fileComments when present in parsed output", async () => {
    const comments = [
      { path: "src/app.ts", line: 5, body: "Use const here" },
      { path: "src/lib.ts", body: "Missing docs" },
    ];
    let callCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([{ id: "draft-6", taskId: "task-6" }]);
            return Promise.resolve([
              {
                content: JSON.stringify({
                  verdict: "comment",
                  summary: "Some issues",
                  fileComments: comments,
                }),
                logType: "tool_result",
              },
            ]);
          }),
        }),
      };
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    await parseReviewOutput("task-6");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileComments: comments,
      }),
    );
  });
});

// ── getReviewDraft ──────────────────────────────────────────────────

describe("getReviewDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the draft for an existing task", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleDraft]),
      }),
    });

    const result = await getReviewDraft("task-1");

    expect(result).toEqual(sampleDraft);
  });

  it("returns null when no draft exists", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await getReviewDraft("task-no-draft");

    expect(result).toBeNull();
  });
});

// ── updateReviewDraft ───────────────────────────────────────────────

describe("updateReviewDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when draft not found", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(updateReviewDraft("no-draft", { summary: "updated" })).rejects.toThrow(
      "Review draft not found",
    );
  });

  it("throws when draft is in drafting state", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "drafting" }]),
      }),
    });

    await expect(updateReviewDraft("draft-1", { summary: "x" })).rejects.toThrow(
      "Cannot edit draft in drafting state",
    );
  });

  it("throws when draft is in submitted state", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
      }),
    });

    await expect(updateReviewDraft("draft-1", { verdict: "approve" })).rejects.toThrow(
      "Cannot edit draft in submitted state",
    );
  });

  it("updates summary, verdict, and fileComments", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "ready" }]),
      }),
    });

    const updatedDraft = { ...sampleDraft, summary: "Updated summary", verdict: "comment" };
    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([updatedDraft]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await updateReviewDraft("draft-1", {
      summary: "Updated summary",
      verdict: "comment",
      fileComments: [{ path: "a.ts", body: "nit" }],
    });

    expect(result).toEqual(updatedDraft);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Updated summary",
        verdict: "comment",
        fileComments: [{ path: "a.ts", body: "nit" }],
      }),
    );
  });

  it("allows editing a stale draft", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "stale" }]),
      }),
    });

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "stale", summary: "new" }]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await updateReviewDraft("draft-1", { summary: "new" });

    expect(result.summary).toBe("new");
  });
});

// ── submitReviewToGitHub ────────────────────────────────────────────

describe("submitReviewToGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockResolvedValue("ghp_test_token");
  });

  it("throws when draft not found", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(submitReviewToGitHub("no-draft")).rejects.toThrow("Review draft not found");
  });

  it("throws when draft is in drafting state", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "drafting" }]),
      }),
    });

    await expect(submitReviewToGitHub("draft-1")).rejects.toThrow(
      "Cannot submit draft in drafting state",
    );
  });

  it("submits review with APPROVE event", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1" }),
    );

    const updatedDraft = { ...sampleDraft, state: "submitted", submittedAt: new Date() };
    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedDraft]),
        }),
      }),
    });

    const result = await submitReviewToGitHub("draft-1");

    expect(result.draft.state).toBe("submitted");
    expect(result.reviewUrl).toContain("pullrequestreview");

    // Verify fetch was called with APPROVE event
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/pulls/42/reviews",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"APPROVE"'),
      }),
    );
  });

  it("submits review with REQUEST_CHANGES event", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { ...sampleDraft, verdict: "request_changes", summary: "Fix the bugs" },
          ]),
      }),
    });

    mockFetch.mockResolvedValueOnce(mockJsonResponse({ html_url: "https://github.com/review/2" }));

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/reviews"),
      expect.objectContaining({
        body: expect.stringContaining('"REQUEST_CHANGES"'),
      }),
    );
  });

  it("defaults to COMMENT event when verdict is null", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([{ ...sampleDraft, verdict: null, summary: "Some notes" }]),
      }),
    });

    mockFetch.mockResolvedValueOnce(mockJsonResponse({ html_url: "https://github.com/review/3" }));

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/reviews"),
      expect.objectContaining({
        body: expect.stringContaining('"COMMENT"'),
      }),
    );
  });

  it("includes file comments in the submission", async () => {
    const fileComments = [
      { path: "src/index.ts", line: 10, body: "Rename this variable" },
      { path: "src/utils.ts", body: "Add docs" },
    ];
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "comment", fileComments }]),
      }),
    });

    mockFetch.mockResolvedValueOnce(mockJsonResponse({ html_url: "https://github.com/review/4" }));

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1");

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.comments).toHaveLength(2);
    expect(fetchBody.comments[0]).toEqual(
      expect.objectContaining({ path: "src/index.ts", line: 10, body: "Rename this variable" }),
    );
    // Second comment has no line, should have position: 1
    expect(fetchBody.comments[1]).toEqual(
      expect.objectContaining({ path: "src/utils.ts", body: "Add docs", position: 1 }),
    );
  });

  it("throws for GitHub API errors", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Validation failed"),
    });

    await expect(submitReviewToGitHub("draft-1")).rejects.toThrow("GitHub API error 422");
  });

  it("marks draft as submitted after success", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    mockFetch.mockResolvedValueOnce(mockJsonResponse({ html_url: "https://github.com/review/5" }));

    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await submitReviewToGitHub("draft-1");

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "submitted",
      }),
    );
    expect(result.draft.state).toBe("submitted");
  });

  it("uses user token when userId is provided", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...sampleDraft, verdict: "approve" }]),
      }),
    });

    mockFetch.mockResolvedValueOnce(mockJsonResponse({ html_url: "https://github.com/review/6" }));

    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...sampleDraft, state: "submitted" }]),
        }),
      }),
    });

    await submitReviewToGitHub("draft-1", "user-123");

    expect(mockGetGitHubToken).toHaveBeenCalledWith({ userId: "user-123" });
  });
});

// ── getPrStatus ─────────────────────────────────────────────────────

describe("getPrStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockResolvedValue("ghp_test_token");
  });

  it("throws for an invalid PR URL", async () => {
    await expect(getPrStatus("https://github.com/acme/widgets")).rejects.toThrow("Invalid PR URL");
  });

  it("returns checks/review/mergeable status", async () => {
    mockFetch
      // PR data
      .mockResolvedValueOnce(
        mockJsonResponse({
          state: "open",
          merged: false,
          mergeable: true,
          head: { sha: "sha1" },
        }),
      )
      // Check runs
      .mockResolvedValueOnce(
        mockJsonResponse({
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "skipped" },
          ],
        }),
      )
      // Reviews
      .mockResolvedValueOnce(mockJsonResponse([{ state: "APPROVED", body: "LGTM" }]));

    const result = await getPrStatus("https://github.com/acme/widgets/pull/42");

    expect(result).toEqual({
      checksStatus: "passing",
      reviewStatus: "approved",
      mergeable: true,
      prState: "open",
      headSha: "sha1",
    });
  });

  it("maps check run conclusions to overall status - pending", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({
          state: "open",
          merged: false,
          mergeable: true,
          head: { sha: "sha2" },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          check_runs: [
            { status: "in_progress", conclusion: null },
            { status: "completed", conclusion: "success" },
          ],
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse([]));

    const result = await getPrStatus("https://github.com/acme/widgets/pull/43");

    expect(result.checksStatus).toBe("pending");
  });

  it("maps check run conclusions to overall status - failing", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({
          state: "open",
          merged: false,
          mergeable: null,
          head: { sha: "sha3" },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          check_runs: [
            { status: "completed", conclusion: "failure" },
            { status: "completed", conclusion: "success" },
          ],
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse([]));

    const result = await getPrStatus("https://github.com/acme/widgets/pull/44");

    expect(result.checksStatus).toBe("failing");
  });

  it("returns 'none' when there are no check runs", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({
          state: "open",
          merged: false,
          mergeable: true,
          head: { sha: "sha4" },
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse({ check_runs: [] }))
      .mockResolvedValueOnce(mockJsonResponse([]));

    const result = await getPrStatus("https://github.com/acme/widgets/pull/45");

    expect(result.checksStatus).toBe("none");
    expect(result.reviewStatus).toBe("none");
  });

  it("detects merged PRs", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({
          state: "closed",
          merged: true,
          mergeable: false,
          head: { sha: "sha5" },
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse({ check_runs: [] }))
      .mockResolvedValueOnce(mockJsonResponse([]));

    const result = await getPrStatus("https://github.com/acme/widgets/pull/46");

    expect(result.prState).toBe("merged");
  });

  it("detects changes_requested review status", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({
          state: "open",
          merged: false,
          mergeable: true,
          head: { sha: "sha6" },
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse({ check_runs: [] }))
      .mockResolvedValueOnce(
        mockJsonResponse([
          { state: "COMMENTED", body: "nice" },
          { state: "CHANGES_REQUESTED", body: "Fix this" },
        ]),
      );

    const result = await getPrStatus("https://github.com/acme/widgets/pull/47");

    expect(result.reviewStatus).toBe("changes_requested");
  });
});

// ── listOpenPrs ─────────────────────────────────────────────────────

describe("listOpenPrs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockResolvedValue("ghp_test_token");
  });

  it("returns empty array when no repos are configured", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await listOpenPrs("ws-1");

    expect(result).toEqual([]);
  });

  it("returns empty array when GitHub token is not available", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });

    mockGetGitHubToken.mockRejectedValueOnce(new Error("No token"));

    const result = await listOpenPrs("ws-1");

    expect(result).toEqual([]);
  });

  it("lists PRs across configured repos", async () => {
    let selectCallCount = 0;
    vi.mocked(db.select as any).mockImplementation(() => {
      selectCallCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) {
              // Repo list
              return Promise.resolve([sampleRepoConfig]);
            }
            // This won't be called with the current mock setup; drafts are fetched without where
            return Promise.resolve([]);
          }),
        }),
      };
    });

    // Override: the drafts query has no where clause — uses `db.select().from(reviewDrafts)`
    // We need a more nuanced approach: after repo list, the next select is for drafts (no where)
    // Reset and set up sequentially
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });

    // Drafts query: db.select().from(reviewDrafts) — no where
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([]),
    });

    // GitHub API: list PRs for repo
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: 1001,
          number: 42,
          title: "Feature X",
          body: "Adds X",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/widgets/pull/42",
          head: { sha: "abc" },
          base: { ref: "main" },
          user: { login: "alice" },
          assignees: [],
          labels: [{ name: "enhancement" }],
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-29T00:00:00Z",
        },
      ]),
    );

    const result = await listOpenPrs("ws-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        number: 42,
        title: "Feature X",
        repo: expect.objectContaining({ id: "repo-1", fullName: "acme/widgets" }),
        reviewDraft: null,
      }),
    );
  });

  it("cross-references existing drafts with PRs", async () => {
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });

    // Drafts query
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([
        {
          id: "draft-existing",
          taskId: "task-existing",
          state: "ready",
          verdict: "approve",
          repoOwner: "acme",
          repoName: "widgets",
          prNumber: 42,
        },
      ]),
    });

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: 1001,
          number: 42,
          title: "Feature X",
          body: "",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/widgets/pull/42",
          head: { sha: "abc" },
          base: { ref: "main" },
          user: { login: "alice" },
          assignees: [],
          labels: [],
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-29T00:00:00Z",
        },
      ]),
    );

    const result = await listOpenPrs("ws-1");

    expect(result[0].reviewDraft).toEqual(
      expect.objectContaining({
        id: "draft-existing",
        taskId: "task-existing",
        state: "ready",
        verdict: "approve",
      }),
    );
  });

  it("sorts unreviewed PRs first", async () => {
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });

    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([
        {
          id: "draft-x",
          taskId: "task-x",
          state: "ready",
          verdict: "comment",
          repoOwner: "acme",
          repoName: "widgets",
          prNumber: 10,
        },
      ]),
    });

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: 1,
          number: 10,
          title: "Already reviewed",
          body: "",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/widgets/pull/10",
          head: { sha: "a" },
          base: { ref: "main" },
          user: { login: "bob" },
          assignees: [],
          labels: [],
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-30T00:00:00Z",
        },
        {
          id: 2,
          number: 11,
          title: "Not reviewed",
          body: "",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/widgets/pull/11",
          head: { sha: "b" },
          base: { ref: "main" },
          user: { login: "carol" },
          assignees: [],
          labels: [],
          created_at: "2026-03-02T00:00:00Z",
          updated_at: "2026-03-28T00:00:00Z",
        },
      ]),
    );

    const result = await listOpenPrs("ws-1");

    expect(result).toHaveLength(2);
    // Unreviewed PR should come first
    expect(result[0].number).toBe(11);
    expect(result[0].reviewDraft).toBeNull();
    // Reviewed PR second
    expect(result[1].number).toBe(10);
    expect(result[1].reviewDraft).not.toBeNull();
  });

  it("filters by repo when repoId is provided", async () => {
    // When repoId is passed, we look up a single repo by id
    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([sampleRepoConfig]),
      }),
    });

    vi.mocked(db.select as any).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([]),
    });

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: 1,
          number: 1,
          title: "PR 1",
          body: "",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/widgets/pull/1",
          head: { sha: "x" },
          base: { ref: "main" },
          user: { login: "dev" },
          assignees: [],
          labels: [],
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-29T00:00:00Z",
        },
      ]),
    );

    const result = await listOpenPrs("ws-1", "repo-1");

    expect(result).toHaveLength(1);
    expect(result[0].repo.id).toBe("repo-1");
  });
});

// ── mergePr ─────────────────────────────────────────────────────────

describe("mergePr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockResolvedValue("ghp_test_token");
  });

  it("throws for an invalid PR URL", async () => {
    await expect(mergePr({ prUrl: "not-a-url", mergeMethod: "squash" })).rejects.toThrow(
      "Invalid PR URL",
    );
  });

  it("merges a PR with the specified method", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ merged: true }));

    const result = await mergePr({
      prUrl: "https://github.com/acme/widgets/pull/42",
      mergeMethod: "squash",
    });

    expect(result).toEqual({ merged: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/pulls/42/merge",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ merge_method: "squash" }),
      }),
    );
  });

  it("throws when merge fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 405,
      text: () => Promise.resolve("Pull request is not mergeable"),
    });

    await expect(
      mergePr({
        prUrl: "https://github.com/acme/widgets/pull/42",
        mergeMethod: "merge",
      }),
    ).rejects.toThrow("Merge failed (405)");
  });
});

// ── reReview ────────────────────────────────────────────────────────

describe("reReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockResolvedValue("ghp_test_token");
  });

  it("throws when no review draft found for task", async () => {
    vi.mocked(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(reReview("task-no-draft")).rejects.toThrow("No review draft found for task");
  });
});

// ── markDraftStale ──────────────────────────────────────────────────

describe("markDraftStale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a ready draft as stale and publishes event", async () => {
    const staleDraft = { ...sampleDraft, state: "stale" };
    const updateSetMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([staleDraft]),
      }),
    });
    vi.mocked(db.update as any).mockReturnValue({ set: updateSetMock });

    const result = await markDraftStale("draft-1");

    expect(result).toEqual(staleDraft);
    expect(mockPublishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "review_draft:stale",
        taskId: "task-1",
      }),
    );
  });

  it("returns null when draft is not in ready state", async () => {
    vi.mocked(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await markDraftStale("draft-1");

    expect(result).toBeNull();
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });
});
