import { randomBytes } from "node:crypto";
import type { AuthSignInMethodSetting } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createActiveSignInSettingsCache, decodeActiveSignInSetting, type ActiveSignInSetting } from "./activeSettings";
import { encryptSignInSecrets } from "./secrets";

const key = randomBytes(32);

function row(input: Partial<AuthSignInMethodSetting>): AuthSignInMethodSetting {
  return {
    activatedAt: new Date("2026-10-08T00:00:00.000Z"),
    activatedByUserId: null,
    activeConfig: null,
    activeSecretEnvelope: null,
    activeSecretGeneration: null,
    activeVersion: 1,
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    createdAt: new Date("2026-10-08T00:00:00.000Z"),
    draftConfig: null,
    draftSecretEnvelope: null,
    draftSecretGeneration: null,
    draftTestAt: null,
    draftTestCode: null,
    draftTestVersion: null,
    draftVersion: 1,
    enabled: true,
    healthActiveVersion: null,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    method: "google",
    secretGenerationCounter: 1,
    testedDraftVersion: null,
    ...input
  };
}

describe("active sign-in settings", () => {
  it("decodes an enabled configuration with its decrypted secrets", () => {
    const envelope = encryptSignInSecrets({ generation: 1, key, method: "google", secrets: { clientSecret: "secret-value" } });

    expect(decodeActiveSignInSetting(row({
      activeConfig: { clientId: "client.apps.googleusercontent.com" },
      activeSecretEnvelope: envelope,
      activeSecretGeneration: 1,
      activeVersion: 4
    }), () => key)).toEqual({
      activeVersion: 4,
      method: "google",
      resolved: { config: { clientId: "client.apps.googleusercontent.com" }, secrets: { clientSecret: "secret-value" } }
    });
  });

  it("keeps an enabled but unreadable configuration as an unresolved entry and skips disabled or unknown rows", () => {
    const envelope = encryptSignInSecrets({ generation: 1, key, method: "google", secrets: { clientSecret: "secret-value" } });

    expect(decodeActiveSignInSetting(row({
      activeConfig: { clientId: "client" },
      activeSecretEnvelope: envelope,
      activeSecretGeneration: 1
    }), () => randomBytes(32))?.resolved).toBeNull();
    expect(decodeActiveSignInSetting(row({ activeConfig: { clientId: "client" } }), () => key)?.resolved).toBeNull();
    expect(decodeActiveSignInSetting(row({ enabled: false }), () => key)).toBeNull();
    expect(decodeActiveSignInSetting(row({ method: "github" }), () => key)).toBeNull();
  });

  it("serves one snapshot until it expires or is invalidated, and never caches a failed load", async () => {
    let now = 0;
    const snapshot: ActiveSignInSetting[] = [];
    const load = vi.fn(async () => snapshot);
    const cache = createActiveSignInSettingsCache({ load, now: () => now, ttlMs: 1_000 });

    await cache.get();
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);

    cache.invalidate();
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);

    now = 1_000;
    await cache.get();
    expect(load).toHaveBeenCalledTimes(3);

    load.mockRejectedValueOnce(new Error("database unavailable"));
    cache.invalidate();
    await expect(cache.get()).rejects.toThrow("database unavailable");
    await expect(cache.get()).resolves.toBe(snapshot);
    expect(load).toHaveBeenCalledTimes(5);
  });
});
