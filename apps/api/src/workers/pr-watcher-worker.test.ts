import { describe, it, expect } from "vitest";
import {
  determineCheckStatus,
  determineReviewStatus,
  determinePrAction,
} from "./pr-watcher-worker.js";

describe("determineCheckStatus", () => {
  it("returns none for empty check runs", () => {
    expect(determineCheckStatus([])).toBe("none");
  });

  it("returns pending when some checks are still running", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
  });

  it("returns passing when all checks succeed", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ]),
    ).toBe("passing");
  });

  it("treats skipped as passing", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("passing");
  });

  it("returns failing when any check fails", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failing");
  });
});

describe("determineReviewStatus", () => {
  it("returns none for no reviews", () => {
    expect(determineReviewStatus([])).toEqual({ status: "none", comments: "" });
  });

  it("returns approved for APPROVED review", () => {
    expect(determineReviewStatus([{ state: "APPROVED", body: "LGTM" }])).toEqual({
      status: "approved",
      comments: "",
    });
  });

  it("returns changes_requested with body", () => {
    expect(determineReviewStatus([{ state: "CHANGES_REQUESTED", body: "Fix the tests" }])).toEqual({
      status: "changes_requested",
      comments: "Fix the tests",
    });
  });

  it("ignores COMMENTED and DISMISSED reviews for status", () => {
    expect(
      determineReviewStatus([{ state: "COMMENTED", body: "Nice work" }, { state: "DISMISSED" }]),
    ).toEqual({ status: "pending", comments: "" });
  });

  it("uses latest substantive review", () => {
    expect(
      determineReviewStatus([
        { state: "CHANGES_REQUESTED", body: "Fix X" },
        { state: "APPROVED", body: "Fixed" },
      ]),
    ).toEqual({ status: "approved", comments: "" });
  });
});

describe("determinePrAction", () => {
  const defaults = {
    prState: "open",
    prMerged: false,
    mergeable: true,
    checksStatus: "none",
    prevChecksStatus: null as string | null,
    reviewStatus: "none",
    autoMerge: false,
    autoResume: false,
    reviewEnabled: false,
    reviewTrigger: "on_ci_pass",
    hasReviewSubtask: false,
    blockingSubtasksComplete: true,
  };

  it("completes on PR merge", () => {
    expect(determinePrAction({ ...defaults, prMerged: true })).toEqual({
      action: "complete",
      detail: "pr_merged",
    });
  });

  it("fails on PR close without merge", () => {
    expect(determinePrAction({ ...defaults, prState: "closed" })).toEqual({
      action: "fail",
      detail: "pr_closed",
    });
  });

  it("resumes on merge conflicts when autoResume is on", () => {
    expect(
      determinePrAction({
        ...defaults,
        mergeable: false,
        autoResume: true,
      }),
    ).toEqual({ action: "resume_conflicts" });
  });

  it("marks needs_attention on merge conflicts when autoResume is off", () => {
    expect(determinePrAction({ ...defaults, mergeable: false })).toEqual({
      action: "needs_attention",
      detail: "merge_conflicts",
    });
  });

  it("does not re-trigger conflict resume if already handling", () => {
    expect(
      determinePrAction({
        ...defaults,
        mergeable: false,
        autoResume: true,
        prevChecksStatus: "conflicts",
      }),
    ).toEqual({ action: "none" });
  });

  it("resumes on CI failure when autoResume is on", () => {
    expect(
      determinePrAction({
        ...defaults,
        checksStatus: "failing",
        prevChecksStatus: "passing",
        autoResume: true,
      }),
    ).toEqual({ action: "resume_ci_failure" });
  });

  it("does not re-trigger CI resume if already failing", () => {
    expect(
      determinePrAction({
        ...defaults,
        checksStatus: "failing",
        prevChecksStatus: "failing",
        autoResume: true,
      }),
    ).toEqual({ action: "none" });
  });

  it("launches review when CI passes and review enabled with on_ci_pass", () => {
    expect(
      determinePrAction({
        ...defaults,
        checksStatus: "passing",
        prevChecksStatus: "pending",
        reviewEnabled: true,
        reviewTrigger: "on_ci_pass",
      }),
    ).toEqual({ action: "launch_review" });
  });

  it("does not launch review if one already exists", () => {
    const result = determinePrAction({
      ...defaults,
      checksStatus: "passing",
      prevChecksStatus: "pending",
      reviewEnabled: true,
      reviewTrigger: "on_ci_pass",
      hasReviewSubtask: true,
    });
    expect(result.action).not.toBe("launch_review");
  });

  it("launches review on PR open when trigger is on_pr", () => {
    expect(
      determinePrAction({
        ...defaults,
        prevChecksStatus: null,
        reviewEnabled: true,
        reviewTrigger: "on_pr",
      }),
    ).toEqual({ action: "launch_review" });
  });

  it("auto-merges when CI passing and autoMerge on and subtasks done", () => {
    expect(
      determinePrAction({
        ...defaults,
        checksStatus: "passing",
        autoMerge: true,
        blockingSubtasksComplete: true,
      }),
    ).toEqual({ action: "auto_merge" });
  });

  it("does not auto-merge when blocking subtasks pending", () => {
    const result = determinePrAction({
      ...defaults,
      checksStatus: "passing",
      autoMerge: true,
      blockingSubtasksComplete: false,
    });
    expect(result.action).not.toBe("auto_merge");
  });

  it("resumes on review changes requested when autoResume is on", () => {
    expect(
      determinePrAction({
        ...defaults,
        reviewStatus: "changes_requested",
        autoResume: true,
      }),
    ).toEqual({ action: "resume_review" });
  });

  it("marks needs_attention on review changes when autoResume is off", () => {
    expect(
      determinePrAction({
        ...defaults,
        reviewStatus: "changes_requested",
      }),
    ).toEqual({ action: "needs_attention", detail: "review_changes_requested" });
  });

  it("returns none when nothing actionable", () => {
    expect(determinePrAction(defaults)).toEqual({ action: "none" });
  });
});
