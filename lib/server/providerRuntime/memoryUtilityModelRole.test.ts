import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError, type ProviderAdmissionRole } from "./admission";
import { createMemoryUtilityModelRoleResolver } from "./memoryUtilityModelRole";

const role = {
  verifiedStructuredOutput: true, verifiedForcedToolCall: true, credentialSource: "default",
  snapshot: { model: { capabilities: { reasoning: true, reasoningEfforts: ["low", "high"] } },
    providerModelId: "memory-model" }
} as unknown as ProviderAdmissionRole;

function database(policy: unknown) {
  const systemRead = vi.fn(() => { throw new Error("System policy must not govern Memory"); });
  const db = { memoryUtilityModelPolicy: { findUnique: vi.fn().mockResolvedValue(policy) },
    systemModelPolicy: { findUnique: systemRead } } as unknown as PrismaClient;
  return { db, systemRead };
}

describe("independent Memory utility assignment", () => {
  it.each([null, { providerModelId: null, reasoningEffort: null, version: 8 }])(
    "keeps absent and explicitly cleared Memory assignments local without a System fallback",
    async (policy) => {
      const { db, systemRead } = database(policy);
      const loadRole = vi.fn();
      expect(await createMemoryUtilityModelRoleResolver(db, { loadRole }).resolve())
        .toEqual({ ok: false, code: "system_model_absent" });
      expect(loadRole).not.toHaveBeenCalled();
      expect(systemRead).not.toHaveBeenCalled();
    }
  );

  it("uses the exact Memory model, reasoning and independent policy version", async () => {
    const { db, systemRead } = database({ providerModelId: "memory-model", reasoningEffort: "low", version: 7 });
    const loadRole = vi.fn().mockResolvedValue(role);
    expect(await createMemoryUtilityModelRoleResolver(db, { loadRole }).resolve()).toEqual({
      credentialScope: "installation", ok: true, policyVersion: 7,
      providerModelId: "memory-model", reasoningEffort: "low", role
    });
    expect(loadRole).toHaveBeenCalledExactlyOnceWith(db, { providerModelId: "memory-model" });
    expect(systemRead).not.toHaveBeenCalled();
  });

  it.each(["verifiedStructuredOutput", "verifiedForcedToolCall"])(
    "does not activate an assignment without current %s evidence", async (capability) => {
      const { db } = database({ providerModelId: "memory-model", reasoningEffort: null, version: 7 });
      const loadRole = vi.fn().mockResolvedValue({ ...role, [capability]: false });
      expect(await createMemoryUtilityModelRoleResolver(db, { loadRole }).resolve())
        .toEqual({ ok: false, code: "system_model_unavailable" });
    }
  );

  it("rejects an unavailable installation credential and unsupported reasoning without substitution", async () => {
    const { db, systemRead } = database({ providerModelId: "memory-model", reasoningEffort: "xhigh", version: 7 });
    const loadRole = vi.fn().mockResolvedValueOnce(role)
      .mockRejectedValueOnce(new ProviderAdmissionError("credential_default_missing"));
    const resolver = createMemoryUtilityModelRoleResolver(db, { loadRole });
    expect(await resolver.resolve()).toEqual({ ok: false, code: "system_model_unavailable" });
    expect(await resolver.resolve()).toEqual({ ok: false, code: "system_model_unavailable" });
    expect(systemRead).not.toHaveBeenCalled();
  });
});
