import { describe, it, expect } from "vitest";
import { classifyError } from "./error-classifier.js";

describe("classifyError", () => {
  it("classifies ImagePullBackOff as image error", () => {
    const result = classifyError("Failed to pull image: ImagePullBackOff");
    expect(result.category).toBe("image");
    expect(result.title).toBe("Container image not found");
    expect(result.retryable).toBe(true);
  });

  it("classifies ErrImagePull as image error", () => {
    const result = classifyError("Error: ErrImagePull for optio-agent:latest");
    expect(result.category).toBe("image");
  });

  it("classifies pod timeout", () => {
    const result = classifyError(
      'Timed out waiting for pod "optio-task-abc" to reach Running state after 120s',
    );
    expect(result.category).toBe("timeout");
    expect(result.title).toBe("Pod startup timed out");
    expect(result.retryable).toBe(true);
  });

  it("classifies missing secret", () => {
    const result = classifyError("Secret not found: ANTHROPIC_API_KEY (scope: global)");
    expect(result.category).toBe("auth");
    expect(result.title).toContain("ANTHROPIC_API_KEY");
  });

  it("classifies invalid state transition", () => {
    const result = classifyError(
      "InvalidTransitionError: Invalid state transition: failed -> provisioning",
    );
    expect(result.category).toBe("state");
    expect(result.retryable).toBe(true);
  });

  it("classifies OOM kill", () => {
    const result = classifyError("Container was OOMKilled");
    expect(result.category).toBe("resource");
  });

  it("classifies rate limit", () => {
    const result = classifyError("API returned 429 too many requests");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("API rate limit exceeded");
  });

  it("classifies network error", () => {
    const result = classifyError("ECONNREFUSED connecting to api.anthropic.com");
    expect(result.category).toBe("network");
  });

  it("classifies exit code", () => {
    const result = classifyError("Exit code: 1");
    expect(result.category).toBe("agent");
    expect(result.title).toContain("1");
  });

  it("returns unknown for unrecognized errors", () => {
    const result = classifyError("Something completely unexpected happened");
    expect(result.category).toBe("unknown");
    expect(result.description).toBe("Something completely unexpected happened");
    expect(result.retryable).toBe(true);
  });

  it("handles null/undefined input", () => {
    expect(classifyError(null).category).toBe("unknown");
    expect(classifyError(undefined).category).toBe("unknown");
    expect(classifyError("").category).toBe("unknown");
  });
});
