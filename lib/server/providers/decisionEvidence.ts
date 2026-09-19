import { decisionResponseModelMatches } from "../../domain/decisionModels";
import type { AdminProviderTestEvidence } from "../../contracts/adminProviders";
import type { ProviderModelConfiguration } from "./providerConfiguration";

export function decodeDecisionEvidence(value: unknown): NonNullable<AdminProviderTestEvidence["decisions"]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proof = value as Record<string, unknown>;
  if (proof.probeVersion !== 1 || proof.adapterKind !== "openrouter_decisions" ||
    proof.noul !== true || proof.choice !== true ||
    ![proof.upstreamModelId, proof.servedModelId, proof.provider].every((entry) =>
      typeof entry === "string" && entry.trim() === entry && entry.length > 0 && entry.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(entry))) return null;
  return { probeVersion: 1, adapterKind: "openrouter_decisions", noul: true, choice: true,
    upstreamModelId: proof.upstreamModelId as string, servedModelId: proof.servedModelId as string, provider: proof.provider as string };
}

export function hasVerifiedDecisions(evidence: unknown, model: ProviderModelConfiguration): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || model.modelClass !== "decision" ||
    model.adapterKind !== "openrouter_decisions" || !model.openRouterRouting) return false;
  const record = evidence as Record<string, unknown>;
  const proof = decodeDecisionEvidence(record.decisions);
  return Boolean(proof && record.detail === "ok" &&
    ["tiny_generation", "openrouter_account_catalog"].includes(String(record.method)) &&
    record.upstreamModelId === model.upstreamModelId && proof.upstreamModelId === model.upstreamModelId &&
    JSON.stringify(record.selectedProviders) === JSON.stringify(model.openRouterRouting.providers) &&
    decisionResponseModelMatches(model.upstreamModelId, proof.servedModelId) &&
    (model.openRouterRouting.mode === "automatic" || model.openRouterRouting.providers.some((provider) =>
      provider.toLocaleLowerCase("und") === proof.provider.toLocaleLowerCase("und"))));
}
