import { describe, expect, it } from "vitest";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS } from "../../contracts/adminProviderQuickSetup";
import { normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import { adminProviderQuickSetupPolicy } from "../admin/providers/quickSetupPolicy";
import { codeOwnedProviderModelDraftConfig } from "./codeOwnedCatalog";
import { approvedRerankerDeployments } from "../admin/providers/approvedRerankers";
import { automaticRerankerRoutePresets } from "../../domain/rerankerModels";

describe("code-owned provider catalog", () => {
  it("seeds every Quick Setup candidate with the canonical model draft", () => {
    for (const provider of ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS) {
      for (const candidate of adminProviderQuickSetupPolicy(provider).candidates) {
        expect(normalizeProviderModelConfiguration(
          codeOwnedProviderModelDraftConfig(candidate.model)
        )).toEqual(normalizeProviderModelConfiguration(candidate.configuration));
      }
    }
  });

  it("owns one stable OpenRouter deployment for every automatic reranker route slot", () => {
    expect(approvedRerankerDeployments.map((deployment) => ({
      modelClass: normalizeProviderModelConfiguration(deployment.configuration).modelClass,
      providerModelId: deployment.providerModelId,
      upstreamModelId: deployment.configuration.upstreamModelId
    }))).toEqual(automaticRerankerRoutePresets.map((preset) => ({
      modelClass: "reranker",
      providerModelId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      upstreamModelId: preset.upstreamModelId
    })));
  });
});
