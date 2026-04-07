export type { AgentAdapter } from "./types.js";
export { ClaudeCodeAdapter } from "./claude-code.js";
export { CodexAdapter } from "./codex.js";
export { CopilotAdapter } from "./copilot.js";
export { OpenCodeAdapter } from "./opencode.js";
export { GeminiAdapter } from "./gemini.js";

import type { AgentAdapter } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { CopilotAdapter } from "./copilot.js";
import { OpenCodeAdapter } from "./opencode.js";
import { GeminiAdapter } from "./gemini.js";

const adapters: Record<string, AgentAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
  copilot: new CopilotAdapter(),
  gemini: new GeminiAdapter(),
};

// OpenCode is experimental — only register when explicitly enabled
if (process.env.OPTIO_OPENCODE_ENABLED === "true") {
  adapters.opencode = new OpenCodeAdapter();
}

export function getAdapter(type: string): AgentAdapter {
  const adapter = adapters[type];
  if (!adapter) {
    if (type === "opencode" && process.env.OPTIO_OPENCODE_ENABLED !== "true") {
      throw new Error(
        "OpenCode adapter is disabled. Set OPTIO_OPENCODE_ENABLED=true to enable it.",
      );
    }
    throw new Error(`Unknown agent type: ${type}. Available: ${Object.keys(adapters).join(", ")}`);
  }
  return adapter;
}

export function getAvailableAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}
