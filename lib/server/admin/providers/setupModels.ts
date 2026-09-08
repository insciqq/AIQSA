import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS, type AdminProviderQuickSetupProviderId } from "../../../contracts/adminProviderQuickSetup";
import { embeddingModelConfiguration, embeddingPresetsForFamily } from "../../../domain/embeddingModels";
import { providerModelTemplateId } from "../../../domain/providerTemplates";
import { rerankerModelConfiguration, rerankerPresetsForFamily } from "../../../domain/rerankerModels";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";

type SetupModel = Readonly<{
  configuration: ProviderModelConfiguration;
  displayName: string;
  modelId: string;
  templateKey: string;
  inputTokenPriceMicros: number;
  outputTokenPriceMicros: number;
}>;

/** Code-owned candidates only; availability and capabilities still need exact-key checks. */
export function providerSetupModels(family: string): readonly SetupModel[] {
  if (!ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.includes(family as AdminProviderQuickSetupProviderId)) return [];
  const answers = adminProviderQuickSetupPolicy(family as AdminProviderQuickSetupProviderId).candidates.map((candidate) => ({
    configuration: candidate.configuration,
    displayName: candidate.displayName,
    modelId: candidate.modelId,
    templateKey: candidate.templateKey,
    inputTokenPriceMicros: candidate.model.inputTokenPriceMicros,
    outputTokenPriceMicros: candidate.model.outputTokenPriceMicros
  }));
  const helpers = family === "openrouter" ? [
    ...embeddingPresetsForFamily(family).filter((preset) => preset.default).map((preset) => ({
      configuration: embeddingModelConfiguration(preset), displayName: preset.displayName
    })),
    ...rerankerPresetsForFamily(family).filter((preset) => preset.default).map((preset) => ({
      configuration: rerankerModelConfiguration(preset), displayName: preset.displayName
    }))
  ].map((candidate) => {
    const templateKey = `${family}:${candidate.configuration.upstreamModelId}`;
    const modelId = providerModelTemplateId(templateKey);
    if (!modelId) throw new Error("provider_setup_template_missing");
    return { ...candidate, modelId, templateKey, inputTokenPriceMicros: 0, outputTokenPriceMicros: 0 };
  }) : [];
  return [...answers, ...helpers];
}
