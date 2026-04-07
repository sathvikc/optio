import { createCipheriv, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the database module before importing the service
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock the schema to return simple column references
vi.mock("../db/schema.js", () => ({
  secrets: {
    id: "secrets.id",
    name: "secrets.name",
    scope: "secrets.scope",
    workspaceId: "secrets.workspace_id",
    encryptedValue: "secrets.encrypted_value",
    iv: "secrets.iv",
    authTag: "secrets.auth_tag",
    createdAt: "secrets.created_at",
    updatedAt: "secrets.updated_at",
  },
}));

import { db } from "../db/client.js";

// Set encryption key before importing the service (it caches on first access)
const TEST_KEY = "a".repeat(64); // 64-char hex string
process.env.OPTIO_ENCRYPTION_KEY = TEST_KEY;

/** Simulate legacy encryption: 16-byte IV, no AAD (pre-fix format). */
function legacyEncrypt(plaintext: string) {
  const key = Buffer.from(TEST_KEY, "hex");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { encrypted, iv, authTag: cipher.getAuthTag() };
}

describe("secret-service", () => {
  let encrypt: typeof import("./secret-service.js").encrypt;
  let decrypt: typeof import("./secret-service.js").decrypt;
  let buildSecretAAD: typeof import("./secret-service.js").buildSecretAAD;
  let storeSecret: typeof import("./secret-service.js").storeSecret;
  let retrieveSecret: typeof import("./secret-service.js").retrieveSecret;
  let listSecrets: typeof import("./secret-service.js").listSecrets;
  let deleteSecret: typeof import("./secret-service.js").deleteSecret;
  let resolveSecretsForTask: typeof import("./secret-service.js").resolveSecretsForTask;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./secret-service.js");
    encrypt = mod.encrypt;
    decrypt = mod.decrypt;
    buildSecretAAD = mod.buildSecretAAD;
    storeSecret = mod.storeSecret;
    retrieveSecret = mod.retrieveSecret;
    listSecrets = mod.listSecrets;
    deleteSecret = mod.deleteSecret;
    resolveSecretsForTask = mod.resolveSecretsForTask;
  });

  describe("encryption round-trip", () => {
    it("stores and retrieves a secret with correct decryption", async () => {
      const secretValue = "my-super-secret-api-key-12345";
      let capturedEncrypted: Buffer;
      let capturedIv: Buffer;
      let capturedAuthTag: Buffer;

      const selectMock = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      (db.select as any) = selectMock;

      const insertMock = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedEncrypted = vals.encryptedValue;
          capturedIv = vals.iv;
          capturedAuthTag = vals.authTag;
          return Promise.resolve();
        }),
      });
      (db.insert as any) = insertMock;

      await storeSecret("API_KEY", secretValue);

      expect(capturedEncrypted!).toBeInstanceOf(Buffer);
      expect(capturedIv!).toBeInstanceOf(Buffer);
      expect(capturedIv!.length).toBe(12); // NIST-recommended 12-byte IV
      expect(capturedAuthTag!).toBeInstanceOf(Buffer);
      expect(capturedEncrypted!.toString("utf8")).not.toBe(secretValue);

      const selectForRetrieve = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "test-id",
              name: "API_KEY",
              scope: "global",
              encryptedValue: capturedEncrypted!,
              iv: capturedIv!,
              authTag: capturedAuthTag!,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        }),
      });
      (db.select as any) = selectForRetrieve;

      const result = await retrieveSecret("API_KEY");
      expect(result).toBe(secretValue);
    });

    it("handles multi-line secret values", async () => {
      const multiLine = "line1\nline2\nline3\nspecial chars: !@#$%^&*()";
      let captured: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("MULTI", multiLine);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { encryptedValue: captured!.encrypted, iv: captured!.iv, authTag: captured!.authTag },
            ]),
        }),
      });

      const result = await retrieveSecret("MULTI");
      expect(result).toBe(multiLine);
    });

    it("handles unicode secret values", async () => {
      const unicode = "秘密のキー 🔑 пароль";
      let captured: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("UNICODE", unicode);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { encryptedValue: captured!.encrypted, iv: captured!.iv, authTag: captured!.authTag },
            ]),
        }),
      });

      const result = await retrieveSecret("UNICODE");
      expect(result).toBe(unicode);
    });

    it("decrypts legacy secrets encrypted with 16-byte IV and no AAD", async () => {
      // Simulate a legacy row stored before the AAD migration
      const { encrypted, iv, authTag } = legacyEncrypt("old-api-key");

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ encryptedValue: encrypted, iv, authTag }]),
        }),
      });

      // retrieveSecret should handle legacy 16-byte IV rows gracefully
      const result = await retrieveSecret("OLD_KEY");
      expect(result).toBe("old-api-key");
    });
  });

  describe("encrypt/decrypt IV and AAD", () => {
    it("uses 12-byte IV (NIST SP 800-38D recommended)", () => {
      const { iv } = encrypt("test-value");
      expect(iv.length).toBe(12);
    });

    it("encrypts and decrypts with AAD", () => {
      const aad = Buffer.from("API_KEY|global|global");
      const { encrypted, iv, authTag } = encrypt("secret-value", aad);
      const result = decrypt(encrypted, iv, authTag, aad);
      expect(result).toBe("secret-value");
    });

    it("fails to decrypt with wrong AAD", () => {
      const aad = Buffer.from("API_KEY|global|ws-1");
      const wrongAad = Buffer.from("API_KEY|global|ws-2");
      const { encrypted, iv, authTag } = encrypt("secret-value", aad);
      expect(() => decrypt(encrypted, iv, authTag, wrongAad)).toThrow();
    });

    it("fails to decrypt when AAD is expected but missing", () => {
      const aad = Buffer.from("API_KEY|global|global");
      const { encrypted, iv, authTag } = encrypt("secret-value", aad);
      // Decrypting without AAD on 12-byte IV data should fail
      expect(() => decrypt(encrypted, iv, authTag)).toThrow();
    });

    it("handles legacy 16-byte IV data without AAD (backward compat)", () => {
      const { encrypted, iv, authTag } = legacyEncrypt("legacy-secret");
      expect(iv.length).toBe(16);
      // decrypt with AAD provided should still work for 16-byte IV (legacy mode)
      const aad = Buffer.from("name|scope|global");
      const result = decrypt(encrypted, iv, authTag, aad);
      expect(result).toBe("legacy-secret");
    });

    it("handles legacy 16-byte IV data without any AAD argument", () => {
      const { encrypted, iv, authTag } = legacyEncrypt("legacy-secret");
      const result = decrypt(encrypted, iv, authTag);
      expect(result).toBe("legacy-secret");
    });

    it("encrypts without AAD when none provided", () => {
      const { encrypted, iv, authTag } = encrypt("no-aad-value");
      expect(iv.length).toBe(12);
      const result = decrypt(encrypted, iv, authTag);
      expect(result).toBe("no-aad-value");
    });
  });

  describe("buildSecretAAD", () => {
    it("builds AAD from name, scope, and workspaceId", () => {
      const aad = buildSecretAAD("API_KEY", "global", "ws-123");
      expect(aad.toString()).toBe("API_KEY|global|ws-123");
    });

    it("uses 'global' when workspaceId is null", () => {
      const aad = buildSecretAAD("TOKEN", "repo-scope", null);
      expect(aad.toString()).toBe("TOKEN|repo-scope|global");
    });

    it("uses 'global' when workspaceId is undefined", () => {
      const aad = buildSecretAAD("TOKEN", "repo-scope");
      expect(aad.toString()).toBe("TOKEN|repo-scope|global");
    });
  });

  describe("storeSecret", () => {
    it("updates existing secret when one already exists", async () => {
      const updateSetMock = vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "existing-id" }]),
        }),
      });
      (db.update as any) = vi.fn().mockReturnValue({ set: updateSetMock });

      await storeSecret("EXISTING_KEY", "new-value");
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new secret when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      await storeSecret("NEW_KEY", "value");
      expect(db.insert).toHaveBeenCalled();
    });

    it("uses custom scope when provided", async () => {
      let capturedScope: string;

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedScope = vals.scope;
          return Promise.resolve();
        }),
      });

      await storeSecret("KEY", "val", "https://github.com/owner/repo");
      expect(capturedScope!).toBe("https://github.com/owner/repo");
    });
  });

  describe("retrieveSecret", () => {
    it("throws when secret is not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      await expect(retrieveSecret("MISSING")).rejects.toThrow("Secret not found: MISSING");
    });

    it("includes scope in error message", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      await expect(retrieveSecret("KEY", "my-repo")).rejects.toThrow(
        "Secret not found: KEY (scope: my-repo)",
      );
    });

    it("applies isNull workspace filter for non-global scope without workspaceId", async () => {
      // Encrypt with appropriate AAD for this context
      const aad = buildSecretAAD("TOKEN", "repo-scope", null);
      const { encrypted, iv, authTag } = encrypt("val", aad);

      const whereMock = vi.fn().mockResolvedValue([{ encryptedValue: encrypted, iv, authTag }]);
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: whereMock }),
      });

      const result = await retrieveSecret("TOKEN", "repo-scope");
      expect(result).toBe("val");
      // The where clause should have been called (with 3 conditions: name, scope, isNull)
      expect(whereMock).toHaveBeenCalled();
    });
  });

  describe("listSecrets", () => {
    it("returns secrets without values", async () => {
      const mockRows = [
        {
          id: "1",
          name: "KEY_A",
          scope: "global",
          encryptedValue: Buffer.from("x"),
          iv: Buffer.from("x"),
          authTag: Buffer.from("x"),
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-02"),
        },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(mockRows) }),
      });

      const result = await listSecrets("global");
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty("encryptedValue");
      expect(result[0].name).toBe("KEY_A");
    });

    it("returns all secrets when no scope filter", async () => {
      const mockRows = [
        {
          id: "1",
          name: "KEY",
          scope: "global",
          encryptedValue: Buffer.from("x"),
          iv: Buffer.from("x"),
          authTag: Buffer.from("x"),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(mockRows),
      });

      const result = await listSecrets();
      expect(result).toHaveLength(1);
    });
  });

  describe("deleteSecret", () => {
    it("calls delete with correct name and scope", async () => {
      const whereMock = vi.fn().mockResolvedValue(undefined);
      (db.delete as any) = vi.fn().mockReturnValue({ where: whereMock });

      await deleteSecret("MY_KEY", "my-scope");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("resolveSecretsForTask", () => {
    it("falls back to global when repo-scoped secret is not found", async () => {
      let capturedGlobal: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedGlobal = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("API_KEY", "global-key-value");

      let resolveCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            resolveCallCount++;
            if (resolveCallCount === 1) return Promise.resolve([]);
            return Promise.resolve([
              {
                encryptedValue: capturedGlobal!.encrypted,
                iv: capturedGlobal!.iv,
                authTag: capturedGlobal!.authTag,
              },
            ]);
          }),
        }),
      }));

      const result = await resolveSecretsForTask(["API_KEY"], "https://github.com/owner/repo");
      expect(result.API_KEY).toBe("global-key-value");
    });

    it("uses repo-scoped secret when available", async () => {
      let capturedRepo: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedRepo = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("TOKEN", "repo-specific-token", "https://github.com/owner/repo");

      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              encryptedValue: capturedRepo!.encrypted,
              iv: capturedRepo!.iv,
              authTag: capturedRepo!.authTag,
            },
          ]),
        }),
      }));

      const result = await resolveSecretsForTask(["TOKEN"], "https://github.com/owner/repo");
      expect(result.TOKEN).toBe("repo-specific-token");
    });
  });
});
