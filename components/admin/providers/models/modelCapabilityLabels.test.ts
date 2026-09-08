import { describe, expect, it } from "vitest";
import type { AdminProviderTestEvidence } from "@/lib/contracts/adminProviders";
import { fixtureCheck, fixtureConnection, fixtureCredential, fixtureModel } from "@/components/admin/providers/providerFixtures";
import { modelCapabilityLabels } from "./modelChips";

const opus = fixtureModel({ connectionId: "conn-anthropic", displayName: "Claude Opus 5", id: "opus-5" });
const capableOpus = {
  ...opus,
  activeConfig: {
    ...opus.activeConfig!,
    adapterKind: "anthropic_messages" as const,
    capabilities: { ...opus.activeConfig!.capabilities, toolCalling: true, vision: true },
    upstreamModelId: "claude-opus-5"
  }
};

function evidence(overrides: Partial<AdminProviderTestEvidence> = {}): AdminProviderTestEvidence {
  return {
    detail: "ok",
    method: "tiny_generation",
    selectedProviders: [],
    upstreamModelId: "claude-opus-5",
    ...overrides
  };
}

describe("modelCapabilityLabels", () => {
  it("shows only the capabilities the current check verified for this model and key", () => {
    const connection = fixtureConnection({
      activeChecks: [
        fixtureCheck({
          credentialId: "cred-primary",
          evidence: evidence({
            compatibility: {
              directPdf: "verified",
              forcedToolCall: "verified",
              modelAccess: "verified",
              probeVersion: 1,
              streaming: "verified",
              structuredOutput: "not_supported",
              usage: "verified",
              vision: "verified"
            }
          }),
          providerModelId: "opus-5"
        })
      ],
      credentials: [fixtureCredential({ id: "cred-primary", label: "Primary" }), fixtureCredential({ id: "cred-research", label: "Research" })],
      defaultCredentialId: "cred-primary",
      displayName: "Anthropic",
      family: "anthropic",
      id: "conn-anthropic",
      models: [capableOpus]
    });

    expect(modelCapabilityLabels({ connection, credentialId: null, modelId: "opus-5" })).toEqual(["Tools", "PDF", "Images", "Stream"]);
    for (const stale of [
      { ...connection, activeVersion: 2 },
      { ...connection, models: [{ ...capableOpus, activeVersion: 2 }] },
      { ...connection, credentials: [fixtureCredential({ id: "cred-primary", label: "Primary", enabled: false })] },
      { ...connection, activeChecks: [{ ...connection.activeChecks[0]!, credentialVersionId: "old-key-version" }] }
    ]) {
      expect(modelCapabilityLabels({ connection: stale, credentialId: null, modelId: "opus-5" })).toEqual([]);
    }
  });

  it("prefers the group's own key, accepts legacy per-capability evidence and hides unknown or failed checks", () => {
    const connection = fixtureConnection({
      activeChecks: [
        fixtureCheck({
          credentialId: "cred-primary",
          evidence: evidence({
            pdfInput: { adapterKind: "anthropic_messages", probeVersion: 1, upstreamModelId: "claude-opus-5", verified: true },
            structuredOutput: { adapterKind: "openrouter_chat_completions", probeVersion: 4, upstreamModelId: "claude-opus-5", verified: true }
          }),
          providerModelId: "opus-5"
        }),
        fixtureCheck({
          credentialId: "cred-research",
          evidence: evidence({
            forcedToolCall: { adapterKind: "anthropic_messages", probeVersion: 1, upstreamModelId: "claude-opus-5", verified: true }
          }),
          providerModelId: "opus-5"
        }),
        fixtureCheck({ credentialId: "cred-primary", evidence: evidence(), providerModelId: "sonnet-5", status: "unavailable" })
      ],
      credentials: [fixtureCredential({ id: "cred-primary", label: "Primary" }), fixtureCredential({ id: "cred-research", label: "Research" })],
      defaultCredentialId: "cred-primary",
      displayName: "Anthropic",
      family: "anthropic",
      id: "conn-anthropic",
      models: [capableOpus, { ...capableOpus, id: "sonnet-5" }]
    });

    // Default key: Direct PDF matches this adapter; the JSON evidence belongs to another adapter.
    expect(modelCapabilityLabels({ connection, credentialId: null, modelId: "opus-5" })).toEqual(["PDF"]);
    expect(modelCapabilityLabels({ connection, credentialId: "cred-unchecked", modelId: "opus-5" })).toEqual([]);
    // Group override key: its own check speaks for the model.
    expect(modelCapabilityLabels({ connection, credentialId: "cred-research", modelId: "opus-5" })).toEqual(["Tools"]);
    expect(modelCapabilityLabels({ connection, credentialId: null, modelId: "sonnet-5" })).toEqual([]);
    expect(modelCapabilityLabels({ connection, credentialId: null, modelId: "missing" })).toEqual([]);
    expect(modelCapabilityLabels({ connection: null, credentialId: null, modelId: "opus-5" })).toEqual([]);
  });
});
