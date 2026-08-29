import {
  providerModelTemplateId,
  type ProviderModelTemplateKey
} from "../../../domain/providerTemplates";
import {
  automaticRerankerRoutePresets,
  rerankerModelConfiguration,
  type RerankerModelPreset
} from "../../../domain/rerankerModels";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";

export type ApprovedRerankerDeployment = Readonly<{
  configuration: ProviderModelConfiguration;
  displayName: string;
  preset: RerankerModelPreset;
  providerModelId: string;
  templateKey: ProviderModelTemplateKey;
}>;

export const approvedRerankerDeployments: readonly ApprovedRerankerDeployment[] =
  Object.freeze(automaticRerankerRoutePresets.map((preset) => {
    const templateKey = `openrouter:${preset.upstreamModelId}` as ProviderModelTemplateKey;
    const providerModelId = providerModelTemplateId(templateKey);
    if (!providerModelId) throw new Error("approved_reranker_template_missing");
    return Object.freeze({
      configuration: rerankerModelConfiguration(preset),
      displayName: preset.displayName,
      preset,
      providerModelId,
      templateKey
    });
  }));

const approvedProviderModelIds = new Set(
  approvedRerankerDeployments.map(({ providerModelId }) => providerModelId)
);

export function isApprovedRerankerProviderModelId(
  providerModelId: string
): boolean {
  return approvedProviderModelIds.has(providerModelId);
}

export function approvedRerankerDeploymentByProviderModelId(
  providerModelId: string
): ApprovedRerankerDeployment | undefined {
  return approvedRerankerDeployments.find(
    (deployment) => deployment.providerModelId === providerModelId
  );
}
