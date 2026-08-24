import { describe, expect, it } from "vitest";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS } from "../../contracts/adminProviderQuickSetup";
import { normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import { adminProviderQuickSetupPolicy } from "../admin/providers/quickSetupPolicy";
import { codeOwnedProviderModelDraftConfig } from "./codeOwnedCatalog";

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
});
