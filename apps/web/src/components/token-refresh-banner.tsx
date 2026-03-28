"use client";

import { useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

const COPY_COMMAND = `security find-generic-password -s "Claude Code-credentials" -w | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" | pbcopy`;

export function TokenRefreshBanner() {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      await api.createSecret({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: token.trim() });
      toast.success("Token updated — tasks will use it on next run");
      setToken("");
    } catch {
      toast.error("Failed to save token");
    }
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
        <span className="text-sm font-medium text-text-heading">OAuth token expired</span>
        <span className="text-xs text-text-muted">
          — tasks will fail until a new token is provided
        </span>
      </div>

      <div>
        <p className="text-xs text-text-muted mb-1.5">Run this in a terminal to copy your token:</p>
        <div className="relative group">
          <pre className="text-[11px] font-mono bg-bg-card border border-border rounded-md px-3 py-2.5 overflow-x-auto select-all whitespace-pre-wrap break-all">
            {COPY_COMMAND}
          </pre>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(COPY_COMMAND);
              toast.success("Command copied to clipboard");
            }}
            className="absolute top-1.5 right-1.5 px-2 py-1 rounded bg-bg-hover text-text-muted hover:text-text text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
          >
            Copy
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste token here"
          className="flex-1 px-3 py-1.5 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary font-mono"
        />
        <button
          onClick={handleSave}
          disabled={!token.trim() || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? (
            "Saving..."
          ) : token.trim() ? (
            <>
              <Check className="w-3 h-3" />
              Save Token
            </>
          ) : (
            "Save Token"
          )}
        </button>
      </div>
    </div>
  );
}
