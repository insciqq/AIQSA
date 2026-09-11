import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { chatTitleWork } from "@/tests/support/chatTitles";
import { ProviderAdmissionError, type ProviderAdmissionRole } from "./admission";
import { createChatTitleModelRoleResolver } from "./chatTitleModelRole";
import { systemModelRoleEligible } from "./systemModelCapabilities";

const snapshot = chatTitleWork().providerSnapshot;
const role = { credentialSource: "default", snapshot, modelConfiguration: snapshot.model, verifiedStructuredOutput: true } as ProviderAdmissionRole;
const policy = { providerModelId: "memory-model", reasoningEffort: "high", version: 2,
  chatTitleProviderModelId: snapshot.providerModelId, chatTitleReasoningEffort: null };
function database(value: unknown) {
  return { systemModelPolicy: { findUnique: vi.fn().mockResolvedValue(value) } } as unknown as PrismaClient;
}

describe("independent title role admission", () => {
  it("accepts structured output without Memory's forced tool capability or reasoning override", async () => {
    const load = vi.fn().mockResolvedValue(role);
    expect(systemModelRoleEligible(role, "memory")).toBe(false);
    await expect(createChatTitleModelRoleResolver(database(policy), load).resolve()).resolves.toMatchObject({
      ok: true, providerModelId: snapshot.providerModelId, reasoningEffort: null, role
    });
    expect(load).toHaveBeenCalledExactlyOnceWith(expect.anything(), { providerModelId: snapshot.providerModelId });
  });

  it.each([null, { ...policy, chatTitleProviderModelId: null }])("does not resolve another role when unassigned", async (value) => {
    const load = vi.fn();
    await expect(createChatTitleModelRoleResolver(database(value), load).resolve()).resolves.toMatchObject({ ok: false });
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["model_not_available", "credential_default_missing"] as const)("does not substitute an unavailable %s", async (code) => {
    const load = vi.fn().mockRejectedValue(new ProviderAdmissionError(code));
    await expect(createChatTitleModelRoleResolver(database(policy), load).resolve()).resolves.toMatchObject({ ok: false });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("requires current structured evidence and a supported independent reasoning value", async () => {
    await expect(createChatTitleModelRoleResolver(database(policy), vi.fn().mockResolvedValue({ ...role, verifiedStructuredOutput: undefined })).resolve())
      .resolves.toMatchObject({ ok: false });
    await expect(createChatTitleModelRoleResolver(database({ ...policy, chatTitleReasoningEffort: "max" }), vi.fn().mockResolvedValue(role)).resolve())
      .resolves.toMatchObject({ ok: false });
  });
});
