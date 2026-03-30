import {
  TaskState,
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  REVIEW_TASK_FILE_PATH,
  renderPromptTemplate,
} from "@optio/shared";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { logger } from "../logger.js";

/**
 * Fetch PR description, reviews, and comments from GitHub to give the
 * review agent richer context about the PR being reviewed.
 */
async function fetchPrContext(
  owner: string,
  repo: string,
  prNumber: number,
  createdBy: string | null,
): Promise<{
  prDescription: string;
  existingReviews: string;
  prComments: string;
  inlineComments: string;
}> {
  const result = { prDescription: "", existingReviews: "", prComments: "", inlineComments: "" };
  try {
    const { getGitHubToken } = await import("./github-token-service.js");
    const token = createdBy
      ? await getGitHubToken({ userId: createdBy })
      : await getGitHubToken({ server: true });
    const headers = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Optio",
      Accept: "application/vnd.github.v3+json",
    };

    // Fetch PR description
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers,
    });
    if (prRes.ok) {
      const prData = (await prRes.json()) as any;
      result.prDescription = prData.body ?? "";
    }

    // Fetch existing reviews (summaries)
    const reviewsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      { headers },
    );
    if (reviewsRes.ok) {
      const reviews = (await reviewsRes.json()) as any[];
      const withBody = reviews.filter((r: any) => r.body && r.body.trim());
      if (withBody.length > 0) {
        result.existingReviews = withBody
          .map((r: any) => `**${r.user?.login ?? "unknown"}** (${r.state}):\n${r.body}`)
          .join("\n\n");
      }
    }

    // Fetch general PR discussion comments (issue comments endpoint)
    const issueCommentsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=30`,
      { headers },
    );
    if (issueCommentsRes.ok) {
      const comments = (await issueCommentsRes.json()) as any[];
      if (comments.length > 0) {
        result.prComments = comments
          .map((c: any) => `**${c.user?.login ?? "unknown"}** (${c.created_at}):\n${c.body ?? ""}`)
          .join("\n\n");
      }
    }

    // Fetch inline review comments (code-level)
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
  } catch (err) {
    logger.warn({ err, owner, repo, prNumber }, "Failed to fetch PR context for review");
  }
  return result;
}

/**
 * Launch a review agent for a task that has an open PR.
 */
export async function launchReview(parentTaskId: string): Promise<string> {
  const parentTask = await taskService.getTask(parentTaskId);
  if (!parentTask) throw new Error("Parent task not found");
  if (!parentTask.prUrl) throw new Error("Parent task has no PR");

  // Parse PR number and owner/repo
  const prMatch = parentTask.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) throw new Error("Cannot parse PR number from URL");
  const [, owner, repo] = prMatch;
  const prNumber = parseInt(prMatch[3], 10);

  // Get repo config
  const { getRepoByUrl } = await import("./repo-service.js");
  const repoConfig = await getRepoByUrl(parentTask.repoUrl);

  // Fetch PR context from GitHub in parallel with subtask creation
  const prContextPromise = fetchPrContext(owner, repo, prNumber, parentTask.createdBy);

  // Create the review task as a subtask
  const { createSubtask } = await import("./subtask-service.js");

  const subtask = await createSubtask({
    parentTaskId,
    title: `Review: ${parentTask.title}`,
    prompt: `Review PR #${prNumber} for: ${parentTask.title}`,
    taskType: "review",
    blocksParent: true,
    agentType: "claude-code",
  });

  const reviewTask = subtask;

  // Build the review prompt
  const reviewTemplate = repoConfig?.reviewPromptTemplate ?? DEFAULT_REVIEW_PROMPT_TEMPLATE;
  const repoName = parentTask.repoUrl.replace(/.*github\.com[/:]/, "").replace(/\.git$/, "");

  const renderedPrompt = renderPromptTemplate(reviewTemplate, {
    PR_NUMBER: String(prNumber),
    TASK_FILE: REVIEW_TASK_FILE_PATH,
    REPO_NAME: repoName,
    TASK_TITLE: parentTask.title,
    TEST_COMMAND: repoConfig?.testCommand ?? "",
  });

  // Build review context file with enriched PR data
  const prContext = await prContextPromise;

  const reviewContextParts = [
    `# Review Context`,
    ``,
    `## Original Task`,
    `**${parentTask.title}**`,
    ``,
    parentTask.prompt,
    ``,
    `## PR`,
    `- URL: ${parentTask.prUrl}`,
    `- Number: #${prNumber}`,
    `- Branch: optio/task-${parentTask.id}`,
  ];

  if (prContext.prDescription) {
    reviewContextParts.push(``, `## PR Description`, ``, prContext.prDescription);
  }

  if (prContext.existingReviews) {
    reviewContextParts.push(``, `## Existing Reviews`, ``, prContext.existingReviews);
  }

  if (prContext.prComments) {
    reviewContextParts.push(``, `## PR Discussion`, ``, prContext.prComments);
  }

  if (prContext.inlineComments) {
    reviewContextParts.push(``, `## Inline Code Comments`, ``, prContext.inlineComments);
  }

  const reviewContext = reviewContextParts.join("\n");

  // Queue the review task
  await taskService.transitionTask(reviewTask.id, TaskState.QUEUED, "review_requested");
  await taskQueue.add(
    "process-task",
    {
      taskId: reviewTask.id,
      // Override the prompt and task file for the review
      reviewOverride: {
        renderedPrompt,
        taskFileContent: reviewContext,
        taskFilePath: REVIEW_TASK_FILE_PATH,
        // Use review model if configured
        claudeModel: repoConfig?.reviewModel ?? "sonnet",
      },
    },
    {
      jobId: `${reviewTask.id}`,
      priority: 10, // Reviews are high priority
    },
  );

  logger.info({ parentTaskId, reviewTaskId: reviewTask.id, prNumber }, "Review agent launched");
  return reviewTask.id;
}
