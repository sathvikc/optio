import {
  TaskState,
  DEFAULT_PR_REVIEW_PROMPT_TEMPLATE,
  REVIEW_TASK_FILE_PATH,
  PR_REVIEW_OUTPUT_PATH,
  renderPromptTemplate,
  normalizeRepoUrl,
} from "@optio/shared";
import { db } from "../db/client.js";
import { repos, tasks, taskLogs, reviewDrafts } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import * as taskService from "./task-service.js";
import { getGitHubToken } from "./github-token-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { publishEvent } from "./event-bus.js";
import { logger } from "../logger.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function parsePrUrl(prUrl: string): { owner: string; repo: string; prNumber: number } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

function buildGitHubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Optio",
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
}

/**
 * Fetch PR context from GitHub: description, existing reviews, comments.
 * Reuses the same pattern as review-service.ts fetchPrContext.
 */
async function fetchPrContext(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{
  prTitle: string;
  prBody: string;
  headSha: string;
  existingReviews: string;
  prComments: string;
  inlineComments: string;
}> {
  const headers = buildGitHubHeaders(token);
  const result = {
    prTitle: "",
    prBody: "",
    headSha: "",
    existingReviews: "",
    prComments: "",
    inlineComments: "",
  };

  // Fetch PR data
  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers,
  });
  if (!prRes.ok) throw new Error(`Failed to fetch PR #${prNumber}: ${prRes.status}`);
  const prData = (await prRes.json()) as any;
  result.prTitle = prData.title ?? "";
  result.prBody = prData.body ?? "";
  result.headSha = prData.head?.sha ?? "";

  // Fetch existing reviews
  try {
    const reviewsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      { headers },
    );
    if (reviewsRes.ok) {
      const reviews = (await reviewsRes.json()) as any[];
      const withBody = reviews.filter((r: any) => r.body?.trim());
      if (withBody.length > 0) {
        result.existingReviews = withBody
          .map((r: any) => `**${r.user?.login ?? "unknown"}** (${r.state}):\n${r.body}`)
          .join("\n\n");
      }
    }
  } catch {}

  // Fetch PR discussion comments
  try {
    const commentsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=30`,
      { headers },
    );
    if (commentsRes.ok) {
      const comments = (await commentsRes.json()) as any[];
      if (comments.length > 0) {
        result.prComments = comments
          .map((c: any) => `**${c.user?.login ?? "unknown"}** (${c.created_at}):\n${c.body ?? ""}`)
          .join("\n\n");
      }
    }
  } catch {}

  // Fetch inline review comments
  try {
    const inlineRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=50`,
      { headers },
    );
    if (inlineRes.ok) {
      const inlineComments = (await inlineRes.json()) as any[];
      if (inlineComments.length > 0) {
        result.inlineComments = inlineComments
          .map(
            (c: any) =>
              `**${c.user?.login ?? "unknown"}** on \`${c.path}${c.line ? `:${c.line}` : ""}\`:\n${c.body ?? ""}`,
          )
          .join("\n\n");
      }
    }
  } catch {}

  return result;
}

// ── List open PRs ───────────────────────────────────────────────────────────

export async function listOpenPrs(workspaceId: string | undefined, repoId?: string) {
  // Get repos for workspace
  let repoList: (typeof repos.$inferSelect)[];
  if (repoId) {
    const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
    if (repo && workspaceId && repo.workspaceId !== workspaceId) {
      repoList = [];
    } else {
      repoList = repo ? [repo] : [];
    }
  } else if (workspaceId) {
    repoList = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
  } else {
    repoList = await db.select().from(repos);
  }

  if (repoList.length === 0) return [];

  const githubToken = await getGitHubToken({ server: true }).catch(() => null);
  if (!githubToken) return [];

  const headers = buildGitHubHeaders(githubToken);

  // Get existing review drafts to cross-reference
  const existingDrafts = await db.select().from(reviewDrafts);
  const draftMap = new Map(
    existingDrafts.map((d) => [`${d.repoOwner}/${d.repoName}#${d.prNumber}`, d]),
  );

  const allPrs: any[] = [];

  for (const repo of repoList) {
    try {
      const match = repo.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!match) continue;
      const [, owner, repoName] = match;

      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/pulls?state=open&per_page=50&sort=updated&direction=desc`,
        { headers },
      );
      if (!res.ok) {
        logger.warn({ repo: repo.fullName, status: res.status }, "Failed to fetch PRs");
        continue;
      }

      const prs = (await res.json()) as any[];

      for (const pr of prs) {
        const draftKey = `${owner}/${repoName}#${pr.number}`;
        const existingDraft = draftMap.get(draftKey);

        allPrs.push({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body ?? "",
          state: pr.state,
          draft: pr.draft ?? false,
          url: pr.html_url,
          headSha: pr.head?.sha,
          baseBranch: pr.base?.ref,
          author: pr.user?.login ?? null,
          assignees: (pr.assignees ?? []).map((a: any) => a.login),
          labels: (pr.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
          repo: {
            id: repo.id,
            fullName: repo.fullName,
            repoUrl: repo.repoUrl,
          },
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          reviewDraft: existingDraft
            ? {
                id: existingDraft.id,
                taskId: existingDraft.taskId,
                state: existingDraft.state,
                verdict: existingDraft.verdict,
              }
            : null,
        });
      }
    } catch (err) {
      logger.warn({ err, repo: repo.fullName }, "Error fetching PRs");
    }
  }

  // Sort: un-reviewed first, then by updated date
  allPrs.sort((a, b) => {
    if (a.reviewDraft && !b.reviewDraft) return 1;
    if (!a.reviewDraft && b.reviewDraft) return -1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return allPrs;
}

// ── Launch PR Review ────────────────────────────────────────────────────────

export async function launchPrReview(input: {
  prUrl: string;
  workspaceId?: string;
  createdBy?: string;
}) {
  const parsed = parsePrUrl(input.prUrl);
  if (!parsed)
    throw new Error("Invalid PR URL — expected format: https://github.com/owner/repo/pull/123");

  const { owner, repo: repoName, prNumber } = parsed;
  const repoUrl = normalizeRepoUrl(`https://github.com/${owner}/${repoName}`);

  // Validate repo is configured
  const { getRepoByUrl } = await import("./repo-service.js");
  const repoConfig = await getRepoByUrl(repoUrl, input.workspaceId);
  if (!repoConfig) {
    throw new Error(`Repository ${owner}/${repoName} is not configured in Optio. Add it first.`);
  }

  // Get GitHub token and fetch PR context
  const token = input.createdBy
    ? await getGitHubToken({ userId: input.createdBy })
    : await getGitHubToken({ server: true });

  const prContext = await fetchPrContext(owner, repoName, prNumber, token);
  if (!prContext.headSha) throw new Error("Could not determine PR head SHA");

  // Create the task
  const task = await taskService.createTask({
    title: `Review: PR #${prNumber} - ${prContext.prTitle}`,
    prompt: `Review PR #${prNumber} in ${owner}/${repoName}`,
    repoUrl,
    agentType: "claude-code",
    metadata: { prUrl: input.prUrl, prNumber },
    createdBy: input.createdBy,
    workspaceId: input.workspaceId ?? null,
  });

  // Set taskType to pr_review
  await db
    .update(tasks)
    .set({ taskType: "pr_review", prUrl: input.prUrl, prNumber })
    .where(eq(tasks.id, task.id));

  // Create review draft row
  const [draft] = await db
    .insert(reviewDrafts)
    .values({
      taskId: task.id,
      prUrl: input.prUrl,
      prNumber,
      repoOwner: owner,
      repoName,
      headSha: prContext.headSha,
      state: "drafting",
    })
    .returning();

  // Build the review prompt
  const reviewTemplate = repoConfig.reviewPromptTemplate ?? DEFAULT_PR_REVIEW_PROMPT_TEMPLATE;
  const fullRepoName = `${owner}/${repoName}`;

  const renderedPrompt = renderPromptTemplate(reviewTemplate, {
    PR_NUMBER: String(prNumber),
    TASK_FILE: REVIEW_TASK_FILE_PATH,
    REPO_NAME: fullRepoName,
    TASK_TITLE: prContext.prTitle,
    TEST_COMMAND: repoConfig.testCommand ?? "",
    OUTPUT_PATH: PR_REVIEW_OUTPUT_PATH,
  });

  // Build review context file
  const contextParts = [
    `# Review Context`,
    ``,
    `## PR #${prNumber}: ${prContext.prTitle}`,
    `- URL: ${input.prUrl}`,
    `- Author: unknown`,
    `- Base: ${repoConfig.defaultBranch}`,
  ];

  if (prContext.prBody) {
    contextParts.push(``, `## PR Description`, ``, prContext.prBody);
  }
  if (prContext.existingReviews) {
    contextParts.push(``, `## Existing Reviews`, ``, prContext.existingReviews);
  }
  if (prContext.prComments) {
    contextParts.push(``, `## PR Discussion`, ``, prContext.prComments);
  }
  if (prContext.inlineComments) {
    contextParts.push(``, `## Inline Code Comments`, ``, prContext.inlineComments);
  }

  const reviewContext = contextParts.join("\n");

  // Queue the task
  await taskService.transitionTask(task.id, TaskState.QUEUED, "pr_review_requested");
  await taskQueue.add(
    "process-task",
    {
      taskId: task.id,
      reviewOverride: {
        renderedPrompt,
        taskFileContent: reviewContext,
        taskFilePath: REVIEW_TASK_FILE_PATH,
        claudeModel: repoConfig.reviewModel ?? "sonnet",
      },
    },
    {
      jobId: task.id,
      priority: 10,
    },
  );

  logger.info({ taskId: task.id, prNumber, owner, repo: repoName }, "PR review assistant launched");

  return { task: { ...task, taskType: "pr_review", prUrl: input.prUrl, prNumber }, draft };
}

// ── Parse Review Output ─────────────────────────────────────────────────────

export async function parseReviewOutput(taskId: string) {
  const [draft] = await db.select().from(reviewDrafts).where(eq(reviewDrafts.taskId, taskId));

  if (!draft) {
    logger.warn({ taskId }, "No review draft found for task");
    return;
  }

  // Search task logs for the review JSON output
  const logs = await db
    .select({ content: taskLogs.content, logType: taskLogs.logType })
    .from(taskLogs)
    .where(eq(taskLogs.taskId, taskId));

  let parsed: { verdict?: string; summary?: string; fileComments?: any[] } | null = null;

  // Try to find JSON in tool_result logs first, then in all logs
  const allContent = logs.map((l) => l.content).join("\n");

  // Try extracting JSON from a code block or raw content
  const jsonPatterns = [
    // JSON in a code block
    /```(?:json)?\s*\n?(\{[\s\S]*?"verdict"[\s\S]*?\})\s*\n?```/,
    // Raw JSON object with verdict field (greedy to capture nested objects like fileComments)
    /(\{[\s\S]*?"verdict"\s*:\s*"[^"]*"[\s\S]*\})\s*$/m,
    // Simpler fallback
    /(\{[^{}]*"verdict"\s*:\s*"[^"]*"[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/,
  ];

  for (const pattern of jsonPatterns) {
    const match = allContent.match(pattern);
    if (match) {
      try {
        parsed = JSON.parse(match[1]);
        break;
      } catch {
        // Try cleaning common issues
        try {
          const cleaned = match[1].replace(/,\s*([}\]])/g, "$1");
          parsed = JSON.parse(cleaned);
          break;
        } catch {}
      }
    }
  }

  // Update the draft
  const updates: Record<string, unknown> = {
    state: "ready",
    updatedAt: new Date(),
  };

  if (parsed?.verdict && ["approve", "request_changes", "comment"].includes(parsed.verdict)) {
    updates.verdict = parsed.verdict;
  }
  if (parsed?.summary) {
    updates.summary = parsed.summary;
  }
  if (parsed?.fileComments && Array.isArray(parsed.fileComments)) {
    updates.fileComments = parsed.fileComments;
  }

  // If we couldn't parse structured JSON, fall back to the task's result summary
  // which now contains the agent's actual output text (not just "Agent completed successfully")
  if (!updates.summary) {
    const task = await taskService.getTask(taskId);
    if (
      task?.resultSummary &&
      !/^Agent (completed successfully|exited with code \d+)$/.test(task.resultSummary)
    ) {
      updates.summary = task.resultSummary;
    }
  }

  await db.update(reviewDrafts).set(updates).where(eq(reviewDrafts.id, draft.id));

  logger.info({ taskId, draftId: draft.id, hasStructuredOutput: !!parsed }, "Review output parsed");
}

// ── Get Review Draft ────────────────────────────────────────────────────────

export async function getReviewDraft(taskId: string) {
  const [draft] = await db.select().from(reviewDrafts).where(eq(reviewDrafts.taskId, taskId));
  return draft ?? null;
}

// ── Update Review Draft ─────────────────────────────────────────────────────

export async function updateReviewDraft(
  draftId: string,
  updates: {
    summary?: string;
    verdict?: string;
    fileComments?: Array<{ path: string; line?: number; side?: string; body: string }>;
  },
) {
  const [draft] = await db.select().from(reviewDrafts).where(eq(reviewDrafts.id, draftId));
  if (!draft) throw new Error("Review draft not found");
  if (!["ready", "stale"].includes(draft.state)) {
    throw new Error(`Cannot edit draft in ${draft.state} state`);
  }

  const setFields: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.summary !== undefined) setFields.summary = updates.summary;
  if (updates.verdict !== undefined) setFields.verdict = updates.verdict;
  if (updates.fileComments !== undefined) setFields.fileComments = updates.fileComments;

  const [updated] = await db
    .update(reviewDrafts)
    .set(setFields)
    .where(eq(reviewDrafts.id, draftId))
    .returning();

  return updated;
}

// ── Submit Review to GitHub ─────────────────────────────────────────────────

export async function submitReviewToGitHub(draftId: string, userId?: string) {
  const [draft] = await db.select().from(reviewDrafts).where(eq(reviewDrafts.id, draftId));
  if (!draft) throw new Error("Review draft not found");
  if (!["ready", "stale"].includes(draft.state)) {
    throw new Error(`Cannot submit draft in ${draft.state} state`);
  }

  const token = userId ? await getGitHubToken({ userId }) : await getGitHubToken({ server: true });

  const headers = buildGitHubHeaders(token);

  // Map verdict to GitHub event
  const eventMap: Record<string, string> = {
    approve: "APPROVE",
    request_changes: "REQUEST_CHANGES",
    comment: "COMMENT",
  };
  const event = eventMap[draft.verdict ?? "comment"] ?? "COMMENT";

  // Build the review body
  const body: Record<string, unknown> = {
    body: draft.summary ?? "Review by Optio",
    event,
  };

  // Add file comments if any (GitHub expects specific format)
  if (draft.fileComments && draft.fileComments.length > 0) {
    body.comments = draft.fileComments
      .filter((c: any) => c.path && c.body)
      .map((c: any) => ({
        path: c.path,
        body: c.body,
        ...(c.line ? { line: c.line } : { position: 1 }),
        ...(c.side ? { side: c.side } : {}),
      }));
  }

  const res = await fetch(
    `https://api.github.com/repos/${draft.repoOwner}/${draft.repoName}/pulls/${draft.prNumber}/reviews`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${errBody}`);
  }

  const reviewData = (await res.json()) as any;

  // Update draft state
  const [updated] = await db
    .update(reviewDrafts)
    .set({
      state: "submitted",
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(reviewDrafts.id, draftId))
    .returning();

  logger.info({ draftId, prNumber: draft.prNumber, event }, "Review submitted to GitHub");

  return { draft: updated, reviewUrl: reviewData.html_url };
}

// ── Re-review ───────────────────────────────────────────────────────────────

export async function reReview(taskId: string, userId?: string, workspaceId?: string) {
  const [draft] = await db.select().from(reviewDrafts).where(eq(reviewDrafts.taskId, taskId));
  if (!draft) throw new Error("No review draft found for task");

  return launchPrReview({
    prUrl: draft.prUrl,
    workspaceId,
    createdBy: userId,
  });
}

// ── Merge PR ────────────────────────────────────────────────────────────────

export async function mergePr(input: {
  prUrl: string;
  mergeMethod: "merge" | "squash" | "rebase";
  userId?: string;
}) {
  const parsed = parsePrUrl(input.prUrl);
  if (!parsed) throw new Error("Invalid PR URL");

  const token = input.userId
    ? await getGitHubToken({ userId: input.userId })
    : await getGitHubToken({ server: true });

  const headers = buildGitHubHeaders(token);

  const res = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/merge`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ merge_method: input.mergeMethod }),
    },
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Merge failed (${res.status}): ${errBody}`);
  }

  logger.info({ prNumber: parsed.prNumber, method: input.mergeMethod }, "PR merged via Optio");
  return { merged: true };
}

// ── Get PR Status ───────────────────────────────────────────────────────────

export async function getPrStatus(prUrl: string) {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) throw new Error("Invalid PR URL");

  const token = await getGitHubToken({ server: true });
  const headers = buildGitHubHeaders(token);

  const prRes = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}`,
    { headers },
  );
  if (!prRes.ok) throw new Error(`Failed to fetch PR: ${prRes.status}`);
  const prData = (await prRes.json()) as any;

  // Fetch check runs
  const checksRes = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${prData.head.sha}/check-runs`,
    { headers },
  );
  let checksStatus = "none";
  if (checksRes.ok) {
    const checksData = (await checksRes.json()) as any;
    const checkRuns = checksData.check_runs ?? [];
    if (checkRuns.length > 0) {
      const allComplete = checkRuns.every((r: any) => r.status === "completed");
      const allSuccess = checkRuns.every(
        (r: any) => r.conclusion === "success" || r.conclusion === "skipped",
      );
      checksStatus = !allComplete ? "pending" : allSuccess ? "passing" : "failing";
    }
  }

  // Fetch reviews
  const reviewsRes = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/reviews`,
    { headers },
  );
  let reviewStatus = "none";
  if (reviewsRes.ok) {
    const reviews = (await reviewsRes.json()) as any[];
    const substantive = reviews.filter(
      (r: any) => r.state !== "COMMENTED" && r.state !== "DISMISSED",
    );
    const latest = substantive[substantive.length - 1];
    if (latest) {
      reviewStatus =
        latest.state === "APPROVED"
          ? "approved"
          : latest.state === "CHANGES_REQUESTED"
            ? "changes_requested"
            : "pending";
    } else if (reviews.length > 0) {
      reviewStatus = "pending";
    }
  }

  return {
    checksStatus,
    reviewStatus,
    mergeable: prData.mergeable ?? null,
    prState: prData.merged ? "merged" : prData.state,
    headSha: prData.head?.sha,
  };
}

// ── Mark Draft Stale ────────────────────────────────────────────────────────

export async function markDraftStale(draftId: string) {
  const [updated] = await db
    .update(reviewDrafts)
    .set({ state: "stale", updatedAt: new Date() })
    .where(and(eq(reviewDrafts.id, draftId), eq(reviewDrafts.state, "ready")))
    .returning();

  if (updated) {
    await publishEvent({
      type: "review_draft:stale",
      taskId: updated.taskId,
      timestamp: new Date().toISOString(),
    } as any);
  }

  return updated ?? null;
}
