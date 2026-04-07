import fs from "node:fs";
import type { RedisOptions } from "ioredis";

/**
 * Build the effective Redis URL, injecting the password from the REDIS_PASSWORD
 * env var if it is set and not already present in the URL.
 */
function buildRedisUrl(): string {
  const base = process.env.REDIS_URL ?? "redis://localhost:6379";
  const password = process.env.REDIS_PASSWORD;
  if (!password) return base;

  // If the URL already contains credentials, don't override
  try {
    const parsed = new URL(base);
    if (parsed.password) return base;
    parsed.password = encodeURIComponent(password);
    return parsed.toString();
  } catch {
    // URL constructor doesn't handle rediss:// in all runtimes;
    // fall back to string manipulation
    const scheme = base.startsWith("rediss://") ? "rediss://" : "redis://";
    const rest = base.slice(scheme.length);
    return `${scheme}:${encodeURIComponent(password)}@${rest}`;
  }
}

const redisUrl = buildRedisUrl();

function buildTlsOptions(): RedisOptions["tls"] | undefined {
  // TLS is enabled when the URL uses the rediss:// scheme
  if (!redisUrl.startsWith("rediss://")) {
    return undefined;
  }

  const tlsOpts: NonNullable<RedisOptions["tls"]> = {
    minVersion: "TLSv1.3",
  };

  if (process.env.REDIS_CA_CERT_PATH) {
    tlsOpts.ca = fs.readFileSync(process.env.REDIS_CA_CERT_PATH);
  }

  // Allow disabling server certificate verification for dev/test scenarios
  // where the cert CN may not match (e.g., localhost). Default: verify.
  if (process.env.REDIS_TLS_REJECT_UNAUTHORIZED === "false") {
    tlsOpts.rejectUnauthorized = false;
  }

  return tlsOpts;
}

/** Shared Redis URL used by all consumers. */
export const redisConnectionUrl = redisUrl;

/** TLS options derived from the environment (undefined when TLS is off). */
export const redisTlsOptions = buildTlsOptions();

/**
 * Connection options suitable for BullMQ Queue / Worker constructors.
 * Includes `maxRetriesPerRequest: null` which BullMQ requires for blocking commands.
 */
export function getBullMQConnectionOptions(): {
  url: string;
  maxRetriesPerRequest: null;
  tls?: RedisOptions["tls"];
} {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
    ...(redisTlsOptions ? { tls: redisTlsOptions } : {}),
  };
}
