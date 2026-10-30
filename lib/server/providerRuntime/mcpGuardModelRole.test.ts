import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ProviderAdmissionError, type ProviderAdmissionRole } from "./admission";
import { createMcpGuardModelRoleResolver } from "./mcpGuardModelRole";

function fixture() {
  const policy = { mcpGuardProviderModelId: "vision" as string | null, mcpGuardReasoningEffort: "low" as string | null,
    chatPdfProviderModelId: "pdf", chatPdfNativeProviderModelId: "native", providerModelId: "utility", version: 7 };
  const db = { systemModelPolicy: { findUnique: vi.fn(async () => policy) } } as unknown as PrismaClient;
  const role = { verifiedVisionInput: false, verifiedStructuredOutput: true, verifiedForcedToolCall: false,
    snapshot: { providerModelId: "vision", credentialVersionId: "exact-key-version", providerFamily: "openai_compatible",
      model: { adapterKind: "openai_responses_compatible", capabilities: { vision: true, reasoning: true,
        reasoningEfforts: ["low", "high"] }, defaultParams: {}, upstreamModelId: "fixture" } }
  } as unknown as ProviderAdmissionRole;
  const loadRole = vi.fn(async () => role);
  return { policy, db, role, loadRole, resolver: createMcpGuardModelRoleResolver(db, loadRole) };
}

describe("independent MCP guard admission", () => {
  it("pins the exact installation deployment with verified structured output, without requiring tools or vision", async () => {
    const f = fixture();
    expect(await f.resolver.resolve()).toEqual({ ok: true, credentialScope: "installation", providerModelId: "vision",
      reasoningEffort: "low", policyVersion: 7, role: f.role });
    expect(f.loadRole).toHaveBeenCalledExactlyOnceWith(f.db, { providerModelId: "vision" });
  });
  it("preserves explicit clear and never borrows a PDF or utility assignment", async () => {
    const f = fixture(); f.policy.mcpGuardProviderModelId = null; f.policy.mcpGuardReasoningEffort = null;
    expect(await f.resolver.resolve()).toEqual({ ok: false, code: "system_model_absent" });
    expect(f.loadRole).not.toHaveBeenCalled();
  });
  it("rejects configured structured output without independent proof and unsupported reasoning", async () => {
    const f = fixture();
    f.loadRole.mockResolvedValue({ ...f.role, verifiedStructuredOutput: undefined });
    expect(await f.resolver.resolve()).toEqual({ ok: false, code: "system_model_unavailable" });
    f.loadRole.mockResolvedValue(f.role); f.policy.mcpGuardReasoningEffort = "invalid";
    expect(await f.resolver.resolve()).toEqual({ ok: false, code: "system_model_unavailable" });
  });
  it("retains unavailable assignment when installation admission rejects disabled or revoked authority", async () => {
    const f = fixture();
    f.loadRole.mockRejectedValue(new ProviderAdmissionError("model_not_available"));
    expect(await f.resolver.resolve()).toEqual({ ok: false, code: "system_model_unavailable" });
    expect(f.policy.mcpGuardProviderModelId).toBe("vision");
    expect(f.loadRole).toHaveBeenCalledTimes(1);
  });
});
