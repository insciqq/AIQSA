import { describe, expect, it } from "vitest";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { mergeSystemRoleEvidence } from "./systemRoleEvidence";

const current: AdminProviderTestEvidence = {
  method: "tiny_generation", detail: "ok", upstreamModelId: "fixture", selectedProviders: ["Selected route"],
  compatibility: { probeVersion: 2, toolCalling: "verified", directPdf: "verified", vision: "verified", structuredOutput: "verified",
    forcedToolCall: "verified", modelAccess: "verified", streaming: "verified", usage: "verified" },
  structuredOutput: { adapterKind: "openai_responses_native", probeVersion: 2, upstreamModelId: "fixture", verified: true },
  forcedToolCall: { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "fixture", verified: true },
  pdfInput: { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "fixture", verified: true },
  visionInput: { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "fixture", verified: true }
};
describe("independent role evidence", () => {
  it("preserves ordinary tools when a Memory check rejects forced calls", () => {
    const next = { ...current, forcedToolCall: undefined, compatibility: { ...current.compatibility!,
      forcedToolCall: "not_supported" as const, toolCalling: "not_supported" as const } };
    const merged = mergeSystemRoleEvidence(current, next, "memory");
    expect(merged.compatibility).toMatchObject({ toolCalling: "verified", structuredOutput: "verified", forcedToolCall: "not_supported" });
    expect(merged).not.toHaveProperty("forcedToolCall");
  });
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
  it("adds Vision proof to a quick-setup catalog check without losing its verified PDF route", () => {
    const catalog: AdminProviderTestEvidence = {
      method: "models_catalog", detail: "ok", upstreamModelId: current.upstreamModelId,
      selectedProviders: current.selectedProviders, pdfInput: current.pdfInput
    };
    const merged = mergeSystemRoleEvidence(catalog, current, "vision");
    expect(merged.pdfInput).toEqual(current.pdfInput);
    expect(merged.visionInput).toEqual(current.visionInput);
    expect(merged.compatibility).toMatchObject({ modelAccess: "verified", directPdf: "verified",
      vision: "verified", structuredOutput: "not_supported", forcedToolCall: "not_supported", streaming: "not_supported" });
    expect(merged).not.toHaveProperty("structuredOutput");
    expect(merged).not.toHaveProperty("forcedToolCall");
    expect(catalog).not.toHaveProperty("compatibility");
  });
  it("does not grant untested capabilities when a catalog-only deployment fails a Vision probe", () => {
    const catalog: AdminProviderTestEvidence = {
      method: "models_catalog", detail: "ok", upstreamModelId: current.upstreamModelId,
      selectedProviders: current.selectedProviders
    };
    const merged = mergeSystemRoleEvidence(catalog, { ...current, visionInput: undefined,
      compatibility: { ...current.compatibility!, vision: "not_supported" } }, "vision");
    expect(merged.compatibility).toMatchObject({ modelAccess: "verified", directPdf: "not_supported",
      vision: "not_supported", structuredOutput: "not_supported", forcedToolCall: "not_supported", streaming: "not_supported" });
    expect(merged).not.toHaveProperty("visionInput");
    expect(merged).not.toHaveProperty("pdfInput");
  });
});
