import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AdmissionPrisma } from "./admission";
import { createMcpGuardPlanResolver, decodeAcceptedMcpGuardPlan } from "./mcpGuardPlan";
import type { SystemModelRoleResolution } from "./systemModelRole";

const accepted = { version: 1, available: true, policyVersion: 7, reasoningEffort: null, verifiedStructuredOutput: true,
  authority: { connectionId: "connection", connectionVersion: 1, credentialId: "credential", credentialVersionId: "version", modelVersion: 2, providerModelId: "model" },
  snapshot: { version: 1, connectionId: "connection", connectionDisplayName: "Connection", credentialId: "credential", credentialVersionId: "version",
    modelDisplayName: "Model", providerModelId: "model", providerFamily: "openai_compatible",
    connection: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 60000 },
    model: { adapterKind: "openai_responses_compatible", answerSelectable: true, capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: false, structuredOutput: true },
      defaultParams: {}, modelClass: "answer", upstreamModelId: "vision" } } };

describe("accepted MCP guard plan", () => {
  it("decodes immutable exact deployment and rejects missing proof, tuple mismatch and unknown authority fields", () => {
    expect(decodeAcceptedMcpGuardPlan(accepted)).toEqual(accepted);
    expect(decodeAcceptedMcpGuardPlan({ ...accepted, verifiedStructuredOutput: false })).toBeNull();
    expect(decodeAcceptedMcpGuardPlan({ ...accepted, authority: { ...accepted.authority, credentialVersionId: "other" } })).toBeNull();
    expect(decodeAcceptedMcpGuardPlan({ ...accepted, secret: "not-allowed" })).toBeNull();
    expect(decodeAcceptedMcpGuardPlan({ ...accepted, reasoningEffort: "unsupported" })).toBeNull();
  });
  it("preserves precise unavailable state without borrowing another role", async () => {
    const resolve = vi.fn(async (): Promise<SystemModelRoleResolution> => ({ ok: false, code: "system_model_absent" }));
    const resolver = createMcpGuardPlanResolver({} as AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">, resolve);
    expect(await resolver()).toEqual({ version: 1, available: false, code: "mcp_guard_model_absent" });
    resolve.mockResolvedValue({ ok: false, code: "system_model_unavailable" });
    expect(await resolver()).toEqual({ version: 1, available: false, code: "mcp_guard_model_unavailable" });
  });
});
