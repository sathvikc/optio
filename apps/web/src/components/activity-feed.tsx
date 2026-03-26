"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { StateBadge } from "./state-badge";
import { cn, formatRelativeTime } from "@/lib/utils";
import { MessageSquare, Send, Loader2, Pencil, Trash2, X, Check } from "lucide-react";
import { toast } from "sonner";

interface ActivityItem {
  type: "comment" | "event";
  id: string;
  taskId: string;
  createdAt: string;
  // Comment fields
  content?: string;
  user?: { id: string; displayName: string; avatarUrl?: string | null };
  // Event fields
  fromState?: string;
  toState?: string;
  trigger?: string;
  message?: string;
  userId?: string;
}

const STATE_DOT_COLORS: Record<string, string> = {
  running: "bg-primary",
  provisioning: "bg-info",
  queued: "bg-info",
  pending: "bg-text-muted",
  completed: "bg-success",
  pr_opened: "bg-success",
  failed: "bg-error",
  cancelled: "bg-text-muted",
  needs_attention: "bg-warning",
};

export function ActivityFeed({ taskId }: { taskId: string }) {
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await api.getTaskActivity(taskId);
      setActivity(res.activity);
    } catch {
      // silent fail
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll for updates every 10 seconds
  useEffect(() => {
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleAddComment = async () => {
    if (!newComment.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.addTaskComment(taskId, newComment.trim());
      setNewComment("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add comment");
    }
    setSubmitting(false);
  };

  const handleUpdate = async (commentId: string) => {
    if (!editContent.trim()) return;
    try {
      await api.updateTaskComment(taskId, commentId, editContent.trim());
      setEditingId(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update comment");
    }
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm("Delete this comment?")) return;
    try {
      await api.deleteTaskComment(taskId, commentId);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete comment");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading activity...
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {/* Activity items */}
      {activity.map((item, i) => {
        const isLast = i === activity.length - 1;

        if (item.type === "event") {
          const dotColor = STATE_DOT_COLORS[item.toState ?? ""] ?? "bg-text-muted";
          return (
            <div key={`event-${item.id}`} className="flex items-start gap-3">
              <div className="flex flex-col items-center">
                <div className={cn("w-2 h-2 rounded-full mt-2 shrink-0", dotColor)} />
                {!isLast && <div className="w-px flex-1 mt-1 bg-border/60" />}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <div className="flex items-center gap-2 flex-wrap">
                  {item.fromState && (
                    <>
                      <StateBadge state={item.fromState} showDot={false} />
                      <span className="text-text-muted/40 text-xs">&rarr;</span>
                    </>
                  )}
                  <StateBadge state={item.toState!} showDot={false} />
                  {item.user && (
                    <span className="text-[11px] text-text-muted/60">
                      by {item.user.displayName}
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-muted/70 mt-1 font-medium">
                  {item.trigger?.replace(/_/g, " ")}
                  {item.message && (
                    <span className="font-normal text-text-muted/50"> &mdash; {item.message}</span>
                  )}
                </div>
                <div className="text-[11px] text-text-muted/40 mt-0.5 tabular-nums">
                  {formatRelativeTime(item.createdAt)}
                </div>
              </div>
            </div>
          );
        }

        // Comment item
        const isEditing = editingId === item.id;
        return (
          <div key={`comment-${item.id}`} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <div className="w-2 h-2 rounded-full mt-2 shrink-0 bg-info" />
              {!isLast && <div className="w-px flex-1 mt-1 bg-border/60" />}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <div className="rounded-md border border-border bg-bg-card p-2.5">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="w-3 h-3 text-info" />
                    <span className="text-xs font-medium text-text">
                      {item.user?.displayName ?? "System"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {item.user && !isEditing && (
                      <>
                        <button
                          onClick={() => {
                            setEditingId(item.id);
                            setEditContent(item.content ?? "");
                          }}
                          className="p-0.5 rounded hover:bg-bg-hover text-text-muted/50 hover:text-text-muted"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="p-0.5 rounded hover:bg-error/10 text-text-muted/50 hover:text-error"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                    <span className="text-[11px] text-text-muted/40 tabular-nums">
                      {formatRelativeTime(item.createdAt)}
                    </span>
                  </div>
                </div>
                {isEditing ? (
                  <div className="space-y-1.5">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="w-full px-2 py-1.5 rounded bg-bg border border-border text-xs focus:outline-none focus:border-primary resize-y"
                      rows={3}
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleUpdate(item.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-primary text-white text-xs hover:bg-primary-hover btn-press transition-all"
                      >
                        <Check className="w-3 h-3" />
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-bg-hover text-text-muted text-xs"
                      >
                        <X className="w-3 h-3" />
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-text/80 whitespace-pre-wrap">{item.content}</p>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {activity.length === 0 && (
        <div className="text-center text-text-muted/40 text-sm py-6">No activity yet</div>
      )}

      {/* Add comment input */}
      <div className="pt-3 border-t border-border mt-2">
        <div className="flex gap-2">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAddComment();
            }}
            placeholder="Add a comment..."
            rows={2}
            className="flex-1 px-3 py-1.5 rounded-lg bg-bg border border-border text-xs focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
          />
          <button
            onClick={handleAddComment}
            disabled={!newComment.trim() || submitting}
            className="self-end px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed btn-press transition-all"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
        <p className="text-[10px] text-text-muted/40 mt-1">Cmd+Enter to submit</p>
      </div>
    </div>
  );
}
