"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Loader2,
  GitPullRequest,
  GitBranch,
  Eye,
  Check,
  AlertTriangle,
  Clock,
  User,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  Zap,
  GitMerge,
} from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";

export default function ReviewsPage() {
  usePageTitle("Reviews");
  const router = useRouter();
  const [prs, setPrs] = useState<any[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [merging, setMerging] = useState<number | null>(null);
  const [prUrl, setPrUrl] = useState("");
  const [submittingUrl, setSubmittingUrl] = useState(false);

  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .listPullRequests({ repoId: selectedRepo || undefined })
      .then((res) => setPrs(res.pullRequests))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedRepo]);

  const handleReview = async (pr: any) => {
    setReviewing(pr.number);
    try {
      const res = await api.createPrReview({ prUrl: pr.url });
      toast.success(`Review started for PR #${pr.number}`);
      router.push(`/reviews/${res.review.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to start review");
    }
    setReviewing(null);
  };

  const handleApproveAndMerge = async (pr: any) => {
    if (!confirm(`Approve and merge PR #${pr.number}? This skips agent review.`)) return;
    setMerging(pr.number);
    try {
      if (pr.review?.id) {
        try {
          await api.updatePrReview(pr.review.id, {
            verdict: "approve",
            summary: "Approved by user",
          });
          await api.submitPrReview(pr.review.id);
        } catch {
          // Already submitted or not editable — proceed with merge.
        }
      }
      await api.mergePullRequest({ prUrl: pr.url, mergeMethod: "squash" });
      toast.success(`PR #${pr.number} merged`);
      const res = await api.listPullRequests({ repoId: selectedRepo || undefined });
      setPrs(res.pullRequests);
    } catch (err: any) {
      toast.error(err.message || "Failed to merge PR");
    } finally {
      setMerging(null);
    }
  };

  const handleUrlSubmit = async () => {
    if (!prUrl.trim()) return;
    setSubmittingUrl(true);
    try {
      const res = await api.createPrReview({ prUrl: prUrl.trim() });
      toast.success("Review started");
      router.push(`/reviews/${res.review.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to start review");
    }
    setSubmittingUrl(false);
  };

  const stateBadge = (review: any) => {
    if (!review) return null;
    const styles: Record<string, string> = {
      queued: "bg-warning/10 text-warning",
      waiting_ci: "bg-bg text-text-muted border border-border",
      reviewing: "bg-warning/10 text-warning",
      ready: "bg-success/10 text-success",
      stale: "bg-error/10 text-error",
      submitted: "bg-info/10 text-info",
      cancelled: "bg-bg text-text-muted",
      failed: "bg-error/10 text-error",
    };
    const labels: Record<string, string> = {
      queued: "Queued",
      waiting_ci: "Waiting for CI",
      reviewing: "Reviewing...",
      ready: "Draft Ready",
      stale: "Stale",
      submitted: "Submitted",
      cancelled: "Cancelled",
      failed: "Failed",
    };
    return (
      <span
        className={cn(
          "text-[10px] px-1.5 py-0.5 rounded-md font-medium",
          styles[review.state] ?? "bg-bg text-text-muted",
        )}
      >
        {labels[review.state] ?? review.state}
      </span>
    );
  };

  const verdictBadge = (review: any) => {
    if (!review?.verdict) return null;
    const config: Record<string, { icon: any; cls: string; label: string }> = {
      approve: {
        icon: ThumbsUp,
        cls: "bg-success/10 text-success border-success/30",
        label: "Approve",
      },
      request_changes: {
        icon: ThumbsDown,
        cls: "bg-error/10 text-error border-error/30",
        label: "Request Changes",
      },
      comment: {
        icon: MessageSquare,
        cls: "bg-info/10 text-info border-info/30",
        label: "Comment",
      },
    };
    const c = config[review.verdict];
    if (!c) return null;
    const Icon = c.icon;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-medium border",
          c.cls,
        )}
      >
        <Icon className="w-3 h-3" />
        {c.label}
      </span>
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-bold tracking-tight">PR Reviews</h1>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <input
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
          placeholder="Paste a PR URL to review (e.g., https://github.com/owner/repo/pull/123)"
          className="flex-1 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none"
        />
        <button
          onClick={handleUrlSubmit}
          disabled={submittingUrl || !prUrl.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {submittingUrl ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
          Review
        </button>
      </div>

      {repos.length > 1 && (
        <div className="mb-4">
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="px-3 py-1.5 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
          >
            <option value="">All repos</option>
            {repos.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading pull requests from GitHub...
        </div>
      ) : prs.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <GitPullRequest className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No open pull requests found</p>
          <p className="text-xs mt-1">
            {repos.length === 0
              ? "Add a repo first in the Repos settings."
              : "Pull requests will appear here from your configured repos."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {prs.map((pr: any) => (
            <div
              key={`${pr.repo.fullName}-${pr.number}`}
              className="p-3 rounded-lg border border-border bg-bg-card"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium hover:text-primary transition-colors truncate"
                    >
                      {pr.title}
                    </a>
                    <span className="text-xs text-text-muted shrink-0">#{pr.number}</span>
                    {pr.draft && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-bg text-text-muted border border-border">
                        Draft
                      </span>
                    )}
                    {pr.review && stateBadge(pr.review)}
                    {pr.review && verdictBadge(pr.review)}
                    {pr.review?.origin === "auto" && (
                      <span
                        title="Automatically reviewed by Optio"
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary"
                      >
                        <Zap className="w-3 h-3" />
                        Auto
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                      <GitBranch className="w-3 h-3" />
                      {pr.repo.fullName}
                    </span>
                    {pr.author && (
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {pr.author}
                      </span>
                    )}
                    <span>{formatRelativeTime(pr.updatedAt)}</span>
                  </div>
                  {pr.labels && pr.labels.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5">
                      {pr.labels.map((label: string) => (
                        <span
                          key={label}
                          className="text-[10px] px-1.5 py-0.5 rounded-full border border-border bg-bg text-text-muted"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  {pr.review ? (
                    <Link
                      href={`/reviews/${pr.review.id}`}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs",
                        pr.review.state === "stale"
                          ? "bg-error/10 text-error hover:bg-error/20"
                          : pr.review.state === "submitted"
                            ? "bg-info/10 text-info hover:bg-info/20"
                            : pr.review.state === "waiting_ci" ||
                                pr.review.state === "reviewing" ||
                                pr.review.state === "queued"
                              ? "bg-bg text-text-muted border border-border hover:bg-bg-card"
                              : "bg-success/10 text-success hover:bg-success/20",
                      )}
                    >
                      {pr.review.state === "stale" ? (
                        <AlertTriangle className="w-3 h-3" />
                      ) : pr.review.state === "reviewing" ||
                        pr.review.state === "waiting_ci" ||
                        pr.review.state === "queued" ? (
                        <Clock className="w-3 h-3" />
                      ) : (
                        <Check className="w-3 h-3" />
                      )}
                      View Review
                    </Link>
                  ) : (
                    <button
                      onClick={() => handleReview(pr)}
                      disabled={reviewing === pr.number}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50"
                    >
                      {reviewing === pr.number ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Eye className="w-3 h-3" />
                      )}
                      Review with Optio
                    </button>
                  )}
                  <button
                    onClick={() => handleApproveAndMerge(pr)}
                    disabled={merging === pr.number}
                    title="Approve and merge without using the agent"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-success/10 text-success hover:bg-success/20 text-xs disabled:opacity-50"
                  >
                    {merging === pr.number ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <GitMerge className="w-3 h-3" />
                    )}
                    Approve & Merge
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
