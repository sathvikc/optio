import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraTicketProvider } from "./jira.js";
import type { JiraProviderConfig } from "./jira.js";

vi.mock("@optio/shared/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@optio/shared/ssrf")>();
  return {
    ...actual,
    assertSsrfSafe: vi.fn(),
  };
});

vi.mock("jira.js", () => {
  return {
    Version3Client: vi.fn().mockImplementation(() => ({
      issueSearch: {
        searchForIssuesUsingJqlEnhancedSearch: vi.fn().mockResolvedValue({ issues: [] }),
      },
      issueComments: {
        addComment: vi.fn().mockResolvedValue({}),
        getComments: vi.fn().mockResolvedValue({ comments: [] }),
      },
      issues: {
        getTransitions: vi.fn().mockResolvedValue({ transitions: [] }),
        doTransition: vi.fn().mockResolvedValue({}),
      },
    })),
  };
});

import { assertSsrfSafe, SsrfError } from "@optio/shared/ssrf";

const mockAssertSsrfSafe = assertSsrfSafe as ReturnType<typeof vi.fn>;

function baseConfig(): JiraProviderConfig {
  return {
    baseUrl: "https://test.atlassian.net",
    email: "test@example.com",
    apiToken: "test-token",
  };
}

beforeEach(() => {
  mockAssertSsrfSafe.mockReset();
  mockAssertSsrfSafe.mockResolvedValue(undefined);
});

describe("JiraTicketProvider SSRF protection", () => {
  it("calls assertSsrfSafe with baseUrl before fetching tickets", async () => {
    const provider = new JiraTicketProvider();
    await provider.fetchActionableTickets(baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });

  it("throws SsrfError when baseUrl resolves to private address", async () => {
    mockAssertSsrfSafe.mockRejectedValueOnce(
      new SsrfError("DNS resolved evil.example.com to private address 169.254.169.254"),
    );

    const provider = new JiraTicketProvider();
    const config: JiraProviderConfig = {
      ...baseConfig(),
      baseUrl: "http://evil.example.com",
    };

    await expect(provider.fetchActionableTickets(config)).rejects.toThrow(SsrfError);
  });

  it("calls assertSsrfSafe before fetching comments", async () => {
    const provider = new JiraTicketProvider();
    await provider.fetchTicketComments("TEST-123", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });

  it("calls assertSsrfSafe before adding a comment", async () => {
    const provider = new JiraTicketProvider();
    await provider.addComment("TEST-123", "comment", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });

  it("calls assertSsrfSafe before updating state", async () => {
    const provider = new JiraTicketProvider();
    await provider.updateState("TEST-123", "closed", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });
});
