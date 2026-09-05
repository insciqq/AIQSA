import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError, type ProviderAdmissionRole } from "./admission";
import {
  createSystemModelRoleResolver,
  SYSTEM_MODEL_ABSENT,
  SYSTEM_MODEL_UNAVAILABLE
} from "./systemModelRole";

const role = {
  verifiedStructuredOutput: true,
  verifiedForcedToolCall: true,
  credentialSource: "default",
  modelConfiguration: {
    adapterKind: "openai_responses_compatible",
    capabilities: { reasoning: true, reasoningEfforts: ["low", "xhigh"] },
    defaultParams: {}
  },
  snapshot: {
    model: { capabilities: { reasoning: true, reasoningEfforts: ["low", "xhigh"] } },
    providerModelId: "model-1"
  }
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
      reasoningEffort: null,
      updatedByUserId: null,
      version: 1
    }), { loadRole }).resolve()).resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });
    expect(loadRole).not.toHaveBeenCalled();
  });

  it.each([
    { authorState: "inactive", updatedByUserId: "admin-inactive" },
    { authorState: "demoted", updatedByUserId: "admin-demoted" },
    { authorState: "deleted", updatedByUserId: null }
  ])(
    "resolves through installation authority when the policy author is $authorState",
    async ({ updatedByUserId }) => {
      const loadRole = vi.fn().mockResolvedValue(role);
      await expect(createSystemModelRoleResolver(database({
        providerModelId: "model-1",
        reasoningEffort: "xhigh",
        updatedByUserId,
        version: 2
      }), { loadRole }).resolve()).resolves.toEqual({
        credentialScope: "installation",
        ok: true,
        policyVersion: 2,
        providerModelId: "model-1",
        reasoningEffort: "xhigh",
        role
      });
      expect(loadRole).toHaveBeenCalledWith(expect.anything(), {
        providerModelId: "model-1"
      });
    }
  );

  it.each([
    ["target", "model_not_available"],
    ["installation credential", "credential_default_missing"]
  ] as const)(
    "normalizes an unavailable %s without substituting",
    async (_subject, code) => {
      const loadRole = vi.fn().mockRejectedValue(
        new ProviderAdmissionError(code)
      );
      await expect(createSystemModelRoleResolver(database({
        providerModelId: "model-1",
        reasoningEffort: null,
        updatedByUserId: "admin-1",
        version: 3
      }), { loadRole }).resolve()).resolves.toEqual({
        code: SYSTEM_MODEL_UNAVAILABLE,
        ok: false
      });
      expect(loadRole).toHaveBeenCalledWith(expect.anything(), {
        providerModelId: "model-1"
      });
    }
  );

  it("returns the exact deployment role and installation credential scope", async () => {
    const loadRole = vi.fn().mockResolvedValue(role);
    await expect(createSystemModelRoleResolver(database({
      providerModelId: "model-1",
      reasoningEffort: "xhigh",
      updatedByUserId: "admin-1",
      version: 7
    }), { loadRole }).resolve()).resolves.toEqual({
      credentialScope: "installation",
      ok: true,
      policyVersion: 7,
      providerModelId: "model-1",
      reasoningEffort: "xhigh",
      role
    });
  });

  it("fails closed when a retained reasoning effort is no longer advertised", async () => {
    const loadRole = vi.fn().mockResolvedValue(role);
    await expect(createSystemModelRoleResolver(database({
      providerModelId: "model-1",
      reasoningEffort: "max",
      updatedByUserId: "admin-1",
      version: 8
    }), { loadRole }).resolve()).resolves.toEqual({
      code: SYSTEM_MODEL_UNAVAILABLE,
      ok: false
    });
  });
});
