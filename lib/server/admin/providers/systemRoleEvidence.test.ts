import { describe, expect, it } from "vitest";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { mergeSystemRoleEvidence } from "./systemRoleEvidence";

const current: AdminProviderTestEvidence = {
  method: "tiny_generation", detail: "ok", upstreamModelId: "fixture", selectedProviders: ["Selected route"],
  compatibility: { probeVersion: 1, directPdf: "verified", vision: "verified", structuredOutput: "verified",
    forcedToolCall: "verified", modelAccess: "verified", streaming: "verified", usage: "verified" },
  structuredOutput: { adapterKind: "openai_responses_native", probeVersion: 2, upstreamModelId: "fixture", verified: true },
  forcedToolCall: { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "fixture", verified: true },
  pdfInput: { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "fixture", verified: true },
  visionInput: { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "fixture", verified: true }
};
describe("independent role evidence", () => {
  it("removes unsupported Vision evidence while preserving Memory, PDF and ordinary answer admission", () => {
    const next = { ...current, visionInput: undefined, compatibility: { ...current.compatibility!, vision: "not_supported" as const,
      streaming: "not_supported" as const, usage: "not_supported" as const } };
    const merged = mergeSystemRoleEvidence(current, next, "vision");
    expect(merged).toEqual({ ...current, visionInput: undefined,
      compatibility: { ...current.compatibility, vision: "not_supported" } });
    expect(merged).not.toHaveProperty("visionInput");
    expect(current.visionInput?.verified).toBe(true);
  });
  it("cannot merge capability proof across selected provider routes", () => {
    expect(() => mergeSystemRoleEvidence(current, { ...current, selectedProviders: ["Changed route"] }, "memory"))
      .toThrow("system_role_evidence_stale");
  });
});
