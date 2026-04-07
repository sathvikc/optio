import { describe, it, expect } from "vitest";
import { ticketProviderConfigSchema } from "./tickets.js";

describe("ticketProviderConfigSchema", () => {
  describe("jira config", () => {
    it("accepts valid Jira config with public baseUrl", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "jira",
        config: {
          baseUrl: "https://mycompany.atlassian.net",
          email: "user@example.com",
          apiToken: "token123",
          projectKey: "PROJ",
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects Jira config with cloud metadata baseUrl", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "jira",
        config: {
          baseUrl: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
          email: "user@example.com",
          apiToken: "token123",
          projectKey: "PROJ",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects Jira config with K8s internal baseUrl", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "jira",
        config: {
          baseUrl: "http://kubernetes.default.svc.cluster.local/",
          email: "user@example.com",
          apiToken: "token123",
          projectKey: "PROJ",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects Jira config with private network baseUrl", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "jira",
        config: {
          baseUrl: "http://10.0.0.5:8080/jira",
          email: "user@example.com",
          apiToken: "token123",
          projectKey: "PROJ",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects Jira config with localhost baseUrl", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "jira",
        config: {
          baseUrl: "http://localhost:8080",
          email: "user@example.com",
          apiToken: "token123",
          projectKey: "PROJ",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects Jira config missing required fields", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "jira",
        config: {
          baseUrl: "https://mycompany.atlassian.net",
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("gitlab config", () => {
    it("accepts valid GitLab config with public host", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "gitlab",
        config: {
          host: "gitlab.com",
          token: "glpat-token123",
          projectPath: "group/project",
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts GitLab config with custom public host", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "gitlab",
        config: {
          host: "gitlab.mycompany.com",
          token: "glpat-token123",
          projectPath: "group/project",
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects GitLab config with localhost host", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "gitlab",
        config: {
          host: "localhost",
          token: "glpat-token123",
          projectPath: "group/project",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects GitLab config with private IP host", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "gitlab",
        config: {
          host: "169.254.169.254",
          token: "glpat-token123",
          projectPath: "group/project",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects GitLab config with K8s internal host", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "gitlab",
        config: {
          host: "gitlab.default.svc.cluster.local",
          token: "glpat-token123",
          projectPath: "group/project",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects GitLab config missing required fields", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "gitlab",
        config: {
          host: "gitlab.com",
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("github config", () => {
    it("accepts valid GitHub config", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "github",
        config: {
          owner: "myorg",
          repo: "myrepo",
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("linear config", () => {
    it("accepts valid Linear config", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "linear",
        config: {
          apiKey: "lin_api_key",
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("notion config", () => {
    it("accepts valid Notion config", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "notion",
        config: {
          apiKey: "ntn_key",
          databaseId: "db-123",
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("unknown source", () => {
    it("rejects unknown source", () => {
      const result = ticketProviderConfigSchema.safeParse({
        source: "unknown",
        config: {},
      });
      expect(result.success).toBe(false);
    });
  });
});
