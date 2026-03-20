import { describe, it, expect } from "vitest";
import { renderPromptTemplate, renderTaskFile, TASK_FILE_PATH } from "./prompt-template.js";

describe("renderPromptTemplate", () => {
  it("replaces simple variables", () => {
    const result = renderPromptTemplate("Hello {{NAME}}, task {{ID}}", {
      NAME: "world",
      ID: "123",
    });
    expect(result).toBe("Hello world, task 123");
  });

  it("handles missing variables by replacing with empty string", () => {
    const result = renderPromptTemplate("Hello {{NAME}}", {});
    expect(result).toBe("Hello");
  });

  it("handles if/else blocks with truthy value", () => {
    const result = renderPromptTemplate("{{#if AUTO_MERGE}}merge it{{else}}review it{{/if}}", {
      AUTO_MERGE: "true",
    });
    expect(result).toBe("merge it");
  });

  it("handles if/else blocks with falsy value", () => {
    const result = renderPromptTemplate("{{#if AUTO_MERGE}}merge it{{else}}review it{{/if}}", {
      AUTO_MERGE: "false",
    });
    expect(result).toBe("review it");
  });

  it("handles if/else blocks with empty value", () => {
    const result = renderPromptTemplate("{{#if AUTO_MERGE}}merge it{{else}}review it{{/if}}", {
      AUTO_MERGE: "",
    });
    expect(result).toBe("review it");
  });

  it("handles if block without else", () => {
    const result = renderPromptTemplate("start {{#if SHOW}}visible{{/if}} end", { SHOW: "yes" });
    expect(result).toBe("start visible end");
  });

  it("handles if block without else when falsy", () => {
    const result = renderPromptTemplate("start {{#if SHOW}}visible{{/if}} end", { SHOW: "" });
    expect(result).toBe("start  end");
  });

  it("handles multiple variables and conditionals", () => {
    const template = `Task: {{TASK_TITLE}}
Branch: {{BRANCH_NAME}}
{{#if AUTO_MERGE}}Auto-merge enabled{{else}}Manual review{{/if}}`;
    const result = renderPromptTemplate(template, {
      TASK_TITLE: "Fix bug",
      BRANCH_NAME: "optio/task-123",
      AUTO_MERGE: "true",
    });
    expect(result).toContain("Fix bug");
    expect(result).toContain("optio/task-123");
    expect(result).toContain("Auto-merge enabled");
  });
});

describe("renderTaskFile", () => {
  it("renders a basic task file", () => {
    const result = renderTaskFile({
      taskTitle: "Fix the login bug",
      taskBody: "The login form doesn't validate email format.",
      taskId: "abc-123",
    });
    expect(result).toContain("# Fix the login bug");
    expect(result).toContain("The login form doesn't validate email format.");
    expect(result).toContain("abc-123");
  });

  it("includes ticket source when provided", () => {
    const result = renderTaskFile({
      taskTitle: "Fix bug",
      taskBody: "Description",
      taskId: "abc-123",
      ticketSource: "github",
      ticketUrl: "https://github.com/org/repo/issues/42",
    });
    expect(result).toContain("github");
    expect(result).toContain("https://github.com/org/repo/issues/42");
  });
});

describe("TASK_FILE_PATH", () => {
  it("is a relative path", () => {
    expect(TASK_FILE_PATH).not.toMatch(/^\//);
    expect(TASK_FILE_PATH).toContain(".optio/");
  });
});
