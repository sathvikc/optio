/**
 * PR Review primitive — first-class sibling of Repo Tasks and Standalone
 * Tasks. A `pr_reviews` row is a review record attached to a single PR.
 * Each agent execution (initial review, re-review, chat turn) is a
 * `pr_review_runs` row.
 */

export enum PrReviewState {
  QUEUED = "queued",
  WAITING_CI = "waiting_ci",
  REVIEWING = "reviewing",
  READY = "ready",
  STALE = "stale",
  SUBMITTED = "submitted",
  CANCELLED = "cancelled",
  FAILED = "failed",
}

export enum PrReviewRunState {
  QUEUED = "queued",
  PROVISIONING = "provisioning",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export type PrReviewRunKind = "initial" | "rereview" | "chat";

export type PrReviewVerdict = "approve" | "request_changes" | "comment";

export type PrReviewOrigin = "manual" | "auto";

export type PrReviewControlIntent = "cancel" | "rereview";

export interface PrReviewFileComment {
  path: string;
  line?: number;
  side?: string;
  body: string;
}

/**
 * Valid state transitions for `pr_reviews`. Unlike repo tasks, pr_reviews
 * can cycle back to reviewing from submitted/stale when the PR advances
 * and the user asks for a re-review.
 */
const PR_REVIEW_TRANSITIONS: Record<PrReviewState, PrReviewState[]> = {
  [PrReviewState.QUEUED]: [
    PrReviewState.WAITING_CI,
    PrReviewState.REVIEWING,
    PrReviewState.CANCELLED,
    PrReviewState.FAILED,
  ],
  [PrReviewState.WAITING_CI]: [
    PrReviewState.REVIEWING,
    PrReviewState.CANCELLED,
    PrReviewState.FAILED,
  ],
  [PrReviewState.REVIEWING]: [PrReviewState.READY, PrReviewState.FAILED, PrReviewState.CANCELLED],
  [PrReviewState.READY]: [
    PrReviewState.SUBMITTED,
    PrReviewState.STALE,
    PrReviewState.REVIEWING, // user-initiated rereview
    PrReviewState.CANCELLED,
  ],
  [PrReviewState.STALE]: [
    PrReviewState.REVIEWING, // auto or manual rereview
    PrReviewState.SUBMITTED,
    PrReviewState.CANCELLED,
  ],
  [PrReviewState.SUBMITTED]: [
    PrReviewState.STALE, // PR got new commits after submit
    PrReviewState.REVIEWING, // re-review fired
  ],
  [PrReviewState.CANCELLED]: [],
  [PrReviewState.FAILED]: [
    PrReviewState.QUEUED, // user retry
    PrReviewState.CANCELLED,
  ],
};

export function canTransitionPrReview(from: PrReviewState, to: PrReviewState): boolean {
  return PR_REVIEW_TRANSITIONS[from].includes(to);
}

export const NON_TERMINAL_PR_REVIEW_STATES: PrReviewState[] = [
  PrReviewState.QUEUED,
  PrReviewState.WAITING_CI,
  PrReviewState.REVIEWING,
  PrReviewState.READY,
  PrReviewState.STALE,
  PrReviewState.SUBMITTED, // submitted isn't fully terminal — PR may advance
  PrReviewState.FAILED, // failed can be retried
];
