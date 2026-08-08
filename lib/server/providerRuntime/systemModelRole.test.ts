import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError, type ProviderAdmissionRole } from "./admission";
import {
  createSystemModelRoleResolver,
  SYSTEM_MODEL_ABSENT,
  SYSTEM_MODEL_UNAVAILABLE
} from "./systemModelRole";

const role = {
  credentialSource: "user",
  modelConfiguration: {
    adapterKind: "openai_responses_compatible",
    capabilities: {},
    defaultParams: {}
  },
  snapshot: { providerModelId: "model-1" }
} as unknown as ProviderAdmissionRole;

function database(policy: unknown) {
  return {
    systemModelPolicy: {
      findUnique: vi.fn().mockResolvedValue(policy)
    }
  } as unknown as PrismaClient;
}

describe("system model role resolver", () => {
  it("returns the stable absent code for a missing or empty installation role", async () => {
    const loadRole = vi.fn();
    await expect(createSystemModelRoleResolver(database(null), { loadRole }).resolve())
      .resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });
    await expect(createSystemModelRoleResolver(database({
      providerModelId: null,
      updatedByUserId: null,
      version: 1
    }), { loadRole }).resolve()).resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("fails closed when the credential administrator is gone or inactive", async () => {
    const loadRole = vi.fn();
    await expect(createSystemModelRoleResolver(database({
      providerModelId: "model-1",
      updatedByUserId: null,
      version: 2
    }), { loadRole }).resolve()).resolves.toEqual({ code: SYSTEM_MODEL_UNAVAILABLE, ok: false });
    expect(loadRole).not.toHaveBeenCalled();
  });

  it.each(["disabled", "deleted"])(
    "normalizes an unavailable %s target without substituting",
    async () => {
      const loadRole = vi.fn().mockRejectedValue(
        new ProviderAdmissionError("model_not_available")
      );
      await expect(createSystemModelRoleResolver(database({
        providerModelId: "model-1",
        updatedByUserId: "admin-1",
        version: 3
      }), { loadRole }).resolve()).resolves.toEqual({
        code: SYSTEM_MODEL_UNAVAILABLE,
        ok: false
      });
      expect(loadRole).toHaveBeenCalledWith(expect.anything(), {
        providerModelId: "model-1",
        userId: "admin-1"
      });
    }
  );

  it("returns the exact deployment role and credential principal", async () => {
    const loadRole = vi.fn().mockResolvedValue(role);
    await expect(createSystemModelRoleResolver(database({
      providerModelId: "model-1",
      updatedByUserId: "admin-1",
      version: 7
    }), { loadRole }).resolve()).resolves.toEqual({
      credentialOwnerUserId: "admin-1",
      ok: true,
      policyVersion: 7,
      providerModelId: "model-1",
      role
    });
  });
});
