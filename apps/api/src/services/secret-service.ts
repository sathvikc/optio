import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets } from "../db/schema.js";
import type { SecretRef } from "@optio/shared";

const ALGORITHM = "aes-256-gcm";

/** Values that must never be accepted as encryption keys. */
const WEAK_KEY_VALUES = new Set([
  "change-me-in-production",
  "changeme",
  "test",
  "secret",
  "password",
  "default",
]);

function getEncryptionKey(): Buffer {
  const key = process.env.OPTIO_ENCRYPTION_KEY;
  if (!key) throw new Error("OPTIO_ENCRYPTION_KEY is not set");
  if (WEAK_KEY_VALUES.has(key.toLowerCase())) {
    throw new Error(
      `OPTIO_ENCRYPTION_KEY is set to a known-weak value ("${key}"). ` +
        "Generate a strong key with: openssl rand -hex 32",
    );
  }
  if (key.length === 64 && /^[0-9a-f]+$/i.test(key)) {
    return Buffer.from(key, "hex");
  }
  return createHash("sha256").update(key).digest();
}

let _encryptionKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (!_encryptionKey) {
    _encryptionKey = getEncryptionKey();
  }
  return _encryptionKey;
}

/**
 * Eagerly validate the encryption key on startup.
 * Call this during server boot to fail fast rather than on first secret access.
 */
export function validateEncryptionKey(): void {
  encryptionKey();
}

/**
 * Build AAD (Additional Authenticated Data) that binds ciphertext to its
 * identifying context in the `secrets` table.  Format: `name|scope|workspaceId`.
 */
export function buildSecretAAD(name: string, scope: string, workspaceId?: string | null): Buffer {
  return Buffer.from(`${name}|${scope}|${workspaceId ?? "global"}`);
}

export function encrypt(
  plaintext: string,
  aad?: Buffer,
): { encrypted: Buffer; iv: Buffer; authTag: Buffer } {
  const key = encryptionKey();
  const iv = randomBytes(12); // NIST SP 800-38D recommended 12-byte IV
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) {
    cipher.setAAD(aad);
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted, iv, authTag };
}

export function decrypt(encrypted: Buffer, iv: Buffer, authTag: Buffer, aad?: Buffer): string {
  const key = encryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  // Legacy rows use 16-byte IV without AAD; new rows use 12-byte IV with AAD.
  // Skip AAD for legacy data to maintain backward compatibility.
  if (aad && iv.length !== 16) {
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

export async function storeSecret(
  name: string,
  value: string,
  scope = "global",
  workspaceId?: string | null,
): Promise<void> {
  const aad = buildSecretAAD(name, scope, workspaceId);
  const { encrypted, iv, authTag } = encrypt(value, aad);

  // Build conditions for lookup
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) {
    conditions.push(eq(secrets.workspaceId, workspaceId));
  } else if (scope !== "global") {
    conditions.push(isNull(secrets.workspaceId));
  }

  // Try update first, then insert
  const existing = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(...conditions));

  if (existing.length > 0) {
    await db
      .update(secrets)
      .set({ encryptedValue: encrypted, iv, authTag, updatedAt: new Date() })
      .where(and(...conditions));
  } else {
    await db.insert(secrets).values({
      name,
      scope,
      encryptedValue: encrypted,
      iv,
      authTag,
      workspaceId: workspaceId ?? undefined,
    });
  }
}

export async function retrieveSecret(
  name: string,
  scope = "global",
  workspaceId?: string | null,
): Promise<string> {
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) {
    conditions.push(eq(secrets.workspaceId, workspaceId));
  } else if (scope !== "global") {
    // For non-global scopes, always apply a workspace filter to prevent
    // cross-workspace secret leakage when workspaceId is omitted.
    conditions.push(isNull(secrets.workspaceId));
  }

  const [secret] = await db
    .select()
    .from(secrets)
    .where(and(...conditions));
  if (!secret) throw new Error(`Secret not found: ${name} (scope: ${scope})`);

  const aad = buildSecretAAD(name, scope, workspaceId);
  return decrypt(secret.encryptedValue, secret.iv, secret.authTag, aad);
}

export async function listSecrets(
  scope?: string,
  workspaceId?: string | null,
): Promise<SecretRef[]> {
  const conditions = [];
  if (scope) conditions.push(eq(secrets.scope, scope));
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(secrets)
          .where(and(...conditions))
      : db.select().from(secrets);
  const rows = await query;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function deleteSecret(
  name: string,
  scope = "global",
  workspaceId?: string | null,
): Promise<void> {
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));
  await db.delete(secrets).where(and(...conditions));
}

/**
 * Retrieve a secret with workspace-then-global fallback.
 * If workspaceId is provided, tries workspace-scoped first, then global.
 */
export async function retrieveSecretWithFallback(
  name: string,
  scope = "global",
  workspaceId?: string | null,
): Promise<string> {
  if (workspaceId) {
    try {
      return await retrieveSecret(name, scope, workspaceId);
    } catch {
      // Not found in workspace — fall through to global
    }
  }
  return retrieveSecret(name, scope);
}

export async function resolveSecretsForTask(
  requiredSecrets: string[],
  scope = "global",
  workspaceId?: string | null,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const name of requiredSecrets) {
    if (scope !== "global") {
      // Try repo-scoped secret first, fall back to global
      try {
        resolved[name] = await retrieveSecretWithFallback(name, scope, workspaceId);
        continue;
      } catch {
        // Not found at repo scope — fall through to global
      }
    }
    resolved[name] = await retrieveSecretWithFallback(name, "global", workspaceId);
  }
  return resolved;
}
