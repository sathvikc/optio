import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, repos } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import { retrieveSecret } from "../services/secret-service.js";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "./task-worker.js";
import { logger } from "../logger.js";

const connectionOpts = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  maxRetriesPerRequest: null,
};

/** Determine overall CI check status from GitHub check runs. */
export function determineCheckStatus(
  checkRuns: { status: string; conclusion: string | null }[],
): "none" | "pending" | "passing" | "failing" {
  if (checkRuns.length === 0) return "none";
  const allComplete = checkRuns.every((r) => r.status === "completed");
  const allSuccess = checkRuns.every(
    (r) => r.conclusion === "success" || r.conclusion === "skipped",
  );
  if (!allComplete) return "pending";
  if (allSuccess) return "passing";
  return "failing";
}

/** Determine review status from GitHub PR reviews. */
export function determineReviewStatus(reviews: { state: string; body?: string }[]): {
  status: string;
  comments: string;
} {
  if (reviews.length === 0) return { status: "none", comments: "" };
  const substantive = reviews.filter((r) => r.state !== "COMMENTED" && r.state !== "DISMISSED");
  const latest = substantive[substantive.length - 1];
  if (latest) {
    if (latest.state === "APPROVED") return { status: "approved", comments: "" };
    if (latest.state === "CHANGES_REQUESTED")
      return { status: "changes_requested", comments: latest.body || "" };
  }
  if (reviews.some((r) => r.state === "COMMENTED")) return { status: "pending", comments: "" };
  return { status: "none", comments: "" };
}

/** Determine what action the PR watcher should take for a task. */
export function determinePrAction(opts: {
  prState: string;
  prMerged: boolean;
  mergeable: boolean | null;
  checksStatus: string;
  prevChecksStatus: string | null;
  reviewStatus: string;
  autoMerge: boolean;
  autoResume: boolean;
  reviewEnabled: boolean;
  reviewTrigger: string;
  hasReviewSubtask: boolean;
  blockingSubtasksComplete: boolean;
}): { action: string; detail?: string } {
  // PR merged
  if (opts.prMerged) return { action: "complete", detail: "pr_merged" };

  // PR closed without merge
  if (opts.prState === "closed") return { action: "fail", detail: "pr_closed" };

  // Merge conflicts
  if (
    opts.mergeable === false &&
    opts.prState === "open" &&
    opts.prevChecksStatus !== "conflicts"
  ) {
    if (opts.autoResume) return { action: "resume_conflicts" };
    return { action: "needs_attention", detail: "merge_conflicts" };
  }

  // CI just started failing
  if (
    opts.checksStatus === "failing" &&
    opts.prevChecksStatus !== "failing" &&
    opts.prState === "open"
  ) {
    if (opts.autoResume) return { action: "resume_ci_failure" };
    return { action: "needs_attention", detail: "ci_failing" };
  }

  // CI just passed — trigger review if configured
  if (
    opts.checksStatus === "passing" &&
    opts.prevChecksStatus !== "passing" &&
    opts.prState === "open" &&
    opts.reviewEnabled &&
    opts.reviewTrigger === "on_ci_pass" &&
    !opts.hasReviewSubtask
  ) {
    return { action: "launch_review" };
  }

  // First PR detection — trigger review on PR open if configured
  if (
    opts.prevChecksStatus === null &&
    opts.prState === "open" &&
    opts.reviewEnabled &&
    opts.reviewTrigger === "on_pr" &&
    !opts.hasReviewSubtask
  ) {
    return { action: "launch_review" };
  }

  // Auto-merge: CI passing + subtasks done + autoMerge enabled
  if (opts.checksStatus === "passing" && opts.prState === "open" && opts.autoMerge) {
    if (opts.blockingSubtasksComplete) return { action: "auto_merge" };
  }

  // Review changes requested
  if (opts.reviewStatus === "changes_requested") {
    if (opts.autoResume) return { action: "resume_review" };
    return { action: "needs_attention", detail: "review_changes_requested" };
  }

  return { action: "none" };
}

export const prWatcherQueue = new Queue("pr-watcher", { connection: connectionOpts });

export function startPrWatcherWorker() {
  prWatcherQueue.add(
    "check-prs",
    {},
    {
      repeat: {
        every: parseInt(process.env.OPTIO_PR_WATCH_INTERVAL ?? "30000", 10),
      },
    },
  );

  const worker = new Worker(
    "pr-watcher",
    async () => {
      // Find all tasks with open PRs
      // Watch pr_opened tasks + failed tasks that have a PR (may need auto-merge after CI fix)
      // Only watch coding tasks, NOT review subtasks (avoid recursive reviews)
      const openPrTasks = await db
        .select()
        .from(tasks)
        .where(
          sql`${tasks.state} IN ('pr_opened', 'failed') AND ${tasks.prUrl} IS NOT NULL AND (${tasks.taskType} = 'coding' OR ${tasks.taskType} IS NULL)`,
        );

      if (openPrTasks.length === 0) return;

      let githubToken: string;
      try {
        githubToken = await retrieveSecret("GITHUB_TOKEN");
      } catch {
        return; // No token, can't check PRs
      }

      const headers = {
        Authorization: `Bearer ${githubToken}`,
        "User-Agent": "Optio",
        Accept: "application/vnd.github.v3+json",
      };

      for (const task of openPrTasks) {
        if (!task.prUrl) continue;

        try {
          // Parse owner/repo/number from PR URL
          const match = task.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
          if (!match) continue;
          const [, owner, repo, prNumStr] = match;
          const prNumber = parseInt(prNumStr, 10);

          // Fetch PR data
          const prRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
            { headers },
          );
          if (!prRes.ok) continue;
          const prData = (await prRes.json()) as any;

          // Fetch check runs
          const checksRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/commits/${prData.head.sha}/check-runs`,
            { headers },
          );
          const checksData = checksRes.ok ? ((await checksRes.json()) as any) : { check_runs: [] };

          // Fetch reviews
          const reviewsRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
            { headers },
          );
          const reviewsData = reviewsRes.ok ? ((await reviewsRes.json()) as any[]) : [];

          // Determine check status
          let checksStatus = "none";
          if (checksData.check_runs?.length > 0) {
            const runs = checksData.check_runs;
            const allComplete = runs.every((r: any) => r.status === "completed");
            const allSuccess = runs.every(
              (r: any) => r.conclusion === "success" || r.conclusion === "skipped",
            );
            if (!allComplete) checksStatus = "pending";
            else if (allSuccess) checksStatus = "passing";
            else checksStatus = "failing";
          }

          // Determine review status
          let reviewStatus = "none";
          let reviewComments = "";
          if (reviewsData.length > 0) {
            // Get the latest non-comment review
            const substantiveReviews = reviewsData.filter(
              (r: any) => r.state !== "COMMENTED" && r.state !== "DISMISSED",
            );
            const latest = substantiveReviews[substantiveReviews.length - 1];
            if (latest) {
              if (latest.state === "APPROVED") reviewStatus = "approved";
              else if (latest.state === "CHANGES_REQUESTED") {
                reviewStatus = "changes_requested";
                reviewComments = latest.body || "";
                // Also fetch review comments (inline)
                const commentsRes = await fetch(
                  `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
                  { headers },
                );
                if (commentsRes.ok) {
                  const comments = (await commentsRes.json()) as any[];
                  const recent = comments.slice(-5);
                  if (recent.length > 0) {
                    reviewComments +=
                      "\n\nInline comments:\n" +
                      recent.map((c: any) => `${c.path}:${c.line ?? ""} — ${c.body}`).join("\n");
                  }
                }
              }
            } else if (reviewsData.some((r: any) => r.state === "COMMENTED")) {
              reviewStatus = "pending";
            }
          }

          // Update task
          const updates: Record<string, unknown> = {
            prNumber,
            prState: prData.merged ? "merged" : prData.state,
            prChecksStatus: checksStatus,
            prReviewStatus: reviewStatus,
            updatedAt: new Date(),
          };
          if (reviewComments) {
            updates.prReviewComments = reviewComments;
          }
          await db.update(tasks).set(updates).where(eq(tasks.id, task.id));

          // Trigger review if enabled and CI just passed
          if (
            checksStatus === "passing" &&
            task.prChecksStatus !== "passing" && // State changed to passing
            prData.state === "open"
          ) {
            const [repoConf] = await db.select().from(repos).where(eq(repos.repoUrl, task.repoUrl));

            if (repoConf?.reviewEnabled && repoConf.reviewTrigger === "on_ci_pass") {
              // Check if a review task already exists for this task
              const existingReview = await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(sql`${tasks.parentTaskId} = ${task.id} AND ${tasks.taskType} = 'review'`);

              if (existingReview.length === 0) {
                try {
                  const { launchReview } = await import("../services/review-service.js");
                  await launchReview(task.id);
                  logger.info({ taskId: task.id }, "Auto-launched review agent on CI pass");
                } catch (err) {
                  logger.warn({ err, taskId: task.id }, "Failed to auto-launch review");
                }
              }
            }
          }

          // Also trigger review on PR open if configured
          if (
            task.prChecksStatus === null && // First time seeing this PR
            prData.state === "open"
          ) {
            const [repoConf] = await db.select().from(repos).where(eq(repos.repoUrl, task.repoUrl));

            if (repoConf?.reviewEnabled && repoConf.reviewTrigger === "on_pr") {
              const existingReview = await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(sql`${tasks.parentTaskId} = ${task.id} AND ${tasks.taskType} = 'review'`);

              if (existingReview.length === 0) {
                try {
                  const { launchReview } = await import("../services/review-service.js");
                  await launchReview(task.id);
                  logger.info({ taskId: task.id }, "Auto-launched review agent on PR open");
                } catch (err) {
                  logger.warn({ err, taskId: task.id }, "Failed to auto-launch review");
                }
              }
            }
          }

          // Auto-merge if: CI passing + all review subtasks completed + autoMerge enabled
          // Also handles failed tasks whose PRs are now passing (agent fixed CI and pushed)
          if (checksStatus === "passing" && prData.state === "open") {
            const [repoConf] = await db.select().from(repos).where(eq(repos.repoUrl, task.repoUrl));

            if (repoConf?.autoMerge) {
              const { checkBlockingSubtasks } = await import("../services/subtask-service.js");
              const subtaskStatus = await checkBlockingSubtasks(task.id);

              // Merge if: no blocking subtasks, or all blocking subtasks complete
              if (subtaskStatus.allComplete) {
                try {
                  const mergeRes = await fetch(
                    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
                    {
                      method: "PUT",
                      headers: { ...headers, "Content-Type": "application/json" },
                      body: JSON.stringify({ merge_method: "squash" }),
                    },
                  );

                  if (mergeRes.ok) {
                    await taskService.transitionTask(
                      task.id,
                      TaskState.COMPLETED,
                      "auto_merged",
                      `PR #${prNumber} auto-merged (CI passing, reviews complete)`,
                    );
                    logger.info({ taskId: task.id, prNumber }, "PR auto-merged");
                    continue; // Skip remaining state transitions for this task
                  } else {
                    const body = (await mergeRes.json().catch(() => ({}))) as any;
                    logger.warn(
                      { taskId: task.id, status: mergeRes.status, msg: body.message },
                      "Auto-merge failed",
                    );
                  }
                } catch (err) {
                  logger.warn({ err, taskId: task.id }, "Auto-merge error");
                }
              }
            }
          }

          // Handle merge conflicts — resume agent to rebase
          if (
            prData.mergeable === false &&
            prData.state === "open" &&
            task.prChecksStatus !== "conflicts" // Don't re-trigger if already handling
          ) {
            // Mark the conflict state
            await db
              .update(tasks)
              .set({ prChecksStatus: "conflicts", updatedAt: new Date() })
              .where(eq(tasks.id, task.id));

            const [repoConfig] = await db
              .select()
              .from(repos)
              .where(eq(repos.repoUrl, task.repoUrl));

            if (repoConfig?.autoResume) {
              try {
                await taskService.transitionTask(
                  task.id,
                  TaskState.NEEDS_ATTENTION,
                  "merge_conflicts",
                  "PR has merge conflicts",
                );
                await taskService.transitionTask(
                  task.id,
                  TaskState.QUEUED,
                  "auto_resume_conflicts",
                );
                await taskQueue.add(
                  "process-task",
                  {
                    taskId: task.id,
                    resumeSessionId: task.sessionId,
                    resumePrompt: `Your PR has merge conflicts with the base branch. Please:\n1. Run \`git fetch origin && git rebase origin/main\`\n2. Resolve any conflicts\n3. Run the tests to make sure everything still works\n4. Force-push: \`git push --force-with-lease\``,
                  },
                  { jobId: `${task.id}-conflicts-${Date.now()}` },
                );
                logger.info({ taskId: task.id }, "Auto-resuming agent to fix merge conflicts");
              } catch (err) {
                logger.warn({ err, taskId: task.id }, "Failed to auto-resume for conflicts");
              }
            }
          }

          // Handle failing CI checks — resume agent to fix
          if (
            checksStatus === "failing" &&
            task.prChecksStatus !== "failing" && // State just changed to failing
            prData.state === "open"
          ) {
            const [repoConfig] = await db
              .select()
              .from(repos)
              .where(eq(repos.repoUrl, task.repoUrl));

            if (repoConfig?.autoResume) {
              // Build a summary of which checks failed
              const failedChecks = (checksData.check_runs ?? [])
                .filter((r: any) => r.conclusion === "failure")
                .map((r: any) => r.name)
                .join(", ");

              try {
                await taskService.transitionTask(
                  task.id,
                  TaskState.NEEDS_ATTENTION,
                  "ci_failing",
                  `CI checks failing: ${failedChecks}`,
                );
                await taskService.transitionTask(task.id, TaskState.QUEUED, "auto_resume_ci");
                await taskQueue.add(
                  "process-task",
                  {
                    taskId: task.id,
                    resumeSessionId: task.sessionId,
                    resumePrompt: `CI checks are failing on your PR. The following checks failed: ${failedChecks}\n\nPlease investigate the failures, fix the issues, and push the fixes.`,
                  },
                  { jobId: `${task.id}-ci-fix-${Date.now()}` },
                );
                logger.info(
                  { taskId: task.id, failedChecks },
                  "Auto-resuming agent to fix CI failures",
                );
              } catch (err) {
                logger.warn({ err, taskId: task.id }, "Failed to auto-resume for CI failure");
              }
            }
          }

          // Handle state transitions
          if (prData.merged) {
            // PR merged → complete the task
            try {
              await taskService.transitionTask(
                task.id,
                TaskState.COMPLETED,
                "pr_merged",
                task.prUrl,
              );
              logger.info({ taskId: task.id }, "Task completed via PR merge");
            } catch {
              // May already be completed
            }
          } else if (prData.state === "closed") {
            // PR closed without merge → fail
            try {
              await taskService.transitionTask(
                task.id,
                TaskState.FAILED,
                "pr_closed",
                "PR was closed without merging",
              );
            } catch {}
          } else if (reviewStatus === "changes_requested") {
            // Check if auto-resume is enabled for this repo
            const [repoConfig] = await db
              .select()
              .from(repos)
              .where(eq(repos.repoUrl, task.repoUrl));

            if (repoConfig?.autoResume) {
              // Auto-resume with review feedback
              try {
                await taskService.transitionTask(
                  task.id,
                  TaskState.NEEDS_ATTENTION,
                  "review_changes_requested",
                  reviewComments,
                );
                // Re-queue with resume
                await taskService.transitionTask(task.id, TaskState.QUEUED, "auto_resume_review");
                await taskQueue.add(
                  "process-task",
                  {
                    taskId: task.id,
                    resumeSessionId: task.sessionId,
                    resumePrompt: `A reviewer requested changes on the PR. Please address the following feedback:\n\n${reviewComments}`,
                  },
                  { jobId: `${task.id}-review-${Date.now()}` },
                );
                logger.info({ taskId: task.id }, "Auto-resuming agent with review feedback");
              } catch {}
            } else {
              // Just mark as needs attention
              try {
                await taskService.transitionTask(
                  task.id,
                  TaskState.NEEDS_ATTENTION,
                  "review_changes_requested",
                  reviewComments,
                );
              } catch {}
            }
          }
        } catch (err) {
          logger.warn({ err, taskId: task.id }, "Failed to check PR status");
        }
      }
    },
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "PR watcher failed");
  });

  return worker;
}
