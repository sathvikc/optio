import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

// Mock fs at the top level — vi.mock is hoisted
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

// Capture the original env so we can restore it
const originalEnv = { ...process.env };

describe("redis-config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.readFileSync).mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns plain URL with no TLS when REDIS_URL uses redis:// scheme", async () => {
    process.env.REDIS_URL = "redis://myhost:6379";
    delete process.env.REDIS_PASSWORD;
    const { redisConnectionUrl, redisTlsOptions, getBullMQConnectionOptions } =
      await import("./redis-config.js");

    expect(redisConnectionUrl).toBe("redis://myhost:6379");
    expect(redisTlsOptions).toBeUndefined();

    const opts = getBullMQConnectionOptions();
    expect(opts.url).toBe("redis://myhost:6379");
    expect(opts.maxRetriesPerRequest).toBeNull();
    expect(opts.tls).toBeUndefined();
  });

  it("defaults to redis://localhost:6379 when REDIS_URL is not set", async () => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_PASSWORD;
    const { redisConnectionUrl, redisTlsOptions } = await import("./redis-config.js");

    expect(redisConnectionUrl).toBe("redis://localhost:6379");
    expect(redisTlsOptions).toBeUndefined();
  });

  it("enables TLS with minVersion TLSv1.3 when REDIS_URL uses rediss:// scheme", async () => {
    process.env.REDIS_URL = "rediss://secure-redis:6380";
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_CA_CERT_PATH;
    delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;

    const { redisTlsOptions, getBullMQConnectionOptions } = await import("./redis-config.js");

    expect(redisTlsOptions).toBeDefined();
    expect(redisTlsOptions!.minVersion).toBe("TLSv1.3");
    expect(redisTlsOptions!.ca).toBeUndefined();
    expect(redisTlsOptions!.rejectUnauthorized).toBeUndefined();

    const opts = getBullMQConnectionOptions();
    expect(opts.tls).toEqual(redisTlsOptions);
  });

  it("reads CA cert from file when REDIS_CA_CERT_PATH is set", async () => {
    process.env.REDIS_URL = "rediss://secure-redis:6380";
    process.env.REDIS_CA_CERT_PATH = "/etc/redis-tls/ca.crt";
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;

    const mockCert = Buffer.from("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----");
    vi.mocked(fs.readFileSync).mockReturnValue(mockCert);

    const { redisTlsOptions } = await import("./redis-config.js");

    expect(redisTlsOptions).toBeDefined();
    expect(redisTlsOptions!.ca).toEqual(mockCert);
    expect(redisTlsOptions!.minVersion).toBe("TLSv1.3");
    expect(fs.readFileSync).toHaveBeenCalledWith("/etc/redis-tls/ca.crt");
  });

  it("disables certificate verification when REDIS_TLS_REJECT_UNAUTHORIZED=false", async () => {
    process.env.REDIS_URL = "rediss://secure-redis:6380";
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_CA_CERT_PATH;

    const { redisTlsOptions } = await import("./redis-config.js");

    expect(redisTlsOptions).toBeDefined();
    expect(redisTlsOptions!.rejectUnauthorized).toBe(false);
  });

  it("getBullMQConnectionOptions always includes maxRetriesPerRequest: null", async () => {
    process.env.REDIS_URL = "redis://plain:6379";
    delete process.env.REDIS_PASSWORD;
    const { getBullMQConnectionOptions } = await import("./redis-config.js");
    const opts = getBullMQConnectionOptions();
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  describe("password injection", () => {
    it("injects REDIS_PASSWORD into URL when set", async () => {
      process.env.REDIS_URL = "redis://myhost:6379";
      process.env.REDIS_PASSWORD = "s3cret";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("redis://:s3cret@myhost:6379");
    });

    it("injects password into rediss:// URL", async () => {
      process.env.REDIS_URL = "rediss://secure-redis:6380";
      process.env.REDIS_PASSWORD = "tls-pass";
      delete process.env.REDIS_CA_CERT_PATH;
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("rediss://:tls-pass@secure-redis:6380");
    });

    it("does not override password already present in URL", async () => {
      process.env.REDIS_URL = "redis://:existing@myhost:6379";
      process.env.REDIS_PASSWORD = "ignored";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("redis://:existing@myhost:6379");
    });

    it("URL-encodes special characters in password", async () => {
      process.env.REDIS_URL = "redis://myhost:6379";
      process.env.REDIS_PASSWORD = "p@ss:word/test";
      const { redisConnectionUrl } = await import("./redis-config.js");
      // The URL should contain the encoded password
      expect(redisConnectionUrl).toContain("p%40ss%3Aword%2Ftest");
      expect(redisConnectionUrl).toContain("@myhost:6379");
    });

    it("does not inject password when REDIS_PASSWORD is empty", async () => {
      process.env.REDIS_URL = "redis://myhost:6379";
      process.env.REDIS_PASSWORD = "";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("redis://myhost:6379");
    });
  });
});
