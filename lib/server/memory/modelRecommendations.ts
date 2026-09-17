import type { AdminMemoryModelRecommendation } from "../../contracts/adminSystemModelPolicy";
import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { loadInstallationAnswerProviderRole, ProviderAdmissionError, type AdmissionPrisma, type ProviderAdmissionRole } from "../providerRuntime/admission";
import { systemModelRoleEligible } from "../providerRuntime/systemModelCapabilities";
import { normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";

// Curated working-case evidence, not a vendor ranking or a claim of benchmark
// parity. A different transport/model needs its own qualification. Installed
// credential and capability evidence is independently revalidated below.
// Order also defines the one-time bootstrap preference among eligible targets.
export const MEMORY_MODEL_RECOMMENDATIONS = [{
  id: "deepseek-flash-none-memory-v1",
  modelName: "DeepSeek V4.1 Flash (DeepSeek API)",
  upstreamModelId: "deepseek-flash",
  adapterKind: "deepseek_responses_native",
  reasoningEffort: "none",
  minimumOutputTokens: 8192,
  minimumContextWindow: 16384,
  // Includes the original rejected digest and repeated working-case attempts;
  // diagnostic probes are excluded. This is not a perfect-reliability claim.
  evidence: { revision: "memory-working-cases-20260917-deepseek-flash-v1", passedCases: 22, totalCases: 23,
    latencyP50Ms: 1320, latencyP95Ms: 2731 }
}, {
  id: "gemini-flash-native-low-memory-v2",
  modelName: "Gemini 3.8 Flash (Gemini API)",
  upstreamModelId: "gemini-3.8-flash",
  adapterKind: "gemini_interactions_native",
  reasoningEffort: "low",
  minimumOutputTokens: 8192,
  minimumContextWindow: 16384,
  // Working cases with the extraction schema projection. Earlier incompatible
  // schema trials are separate evidence, not successful qualification runs.
  evidence: { revision: "memory-working-cases-20260917-native-gemini38-compatible-v2", passedCases: 18, totalCases: 18,
    latencyP50Ms: 1932, latencyP95Ms: 5297 }
}, {
  id: "gemini-flash-openrouter-low-memory-v2",
  modelName: "Gemini 3.8 Flash (OpenRouter / Google AI Studio)",
  upstreamModelId: "google/gemini-3.8-flash",
  adapterKind: "openrouter_chat_completions",
  openRouterProvider: "google-ai-studio",
  reasoningEffort: "low",
  minimumOutputTokens: 8192,
  minimumContextWindow: 16384,
  evidence: { revision: "memory-working-cases-20260917-openrouter-gemini38-compatible-v2", passedCases: 18, totalCases: 18,
    latencyP50Ms: 1530, latencyP95Ms: 3516 }
}, {
  id: "terra-low-memory-v1",
  modelName: "GPT-5.6 Terra",
  upstreamModelId: "gpt-5.6-terra",
  adapterKind: "openai_responses_compatible",
  reasoningEffort: "low",
  minimumOutputTokens: 8192,
  minimumContextWindow: 16384,
  evidence: { revision: "memory-working-cases-20260917-v2", passedCases: 5, totalCases: 5,
    latencyP50Ms: 3311, latencyP95Ms: 13481 }
}] as const;

type Recommendation = typeof MEMORY_MODEL_RECOMMENDATIONS[number];
type Model = { id: string; displayName: string; connectionId: string; activeConfig: unknown };

export function memoryRecommendationRejection(
  role: ProviderAdmissionRole, recommendation: Recommendation
): AdminMemoryModelRecommendation["unavailableReason"] {
  const model = role.snapshot.model;
  if (model.adapterKind !== recommendation.adapterKind || model.upstreamModelId !== recommendation.upstreamModelId ||
    !systemModelRoleEligible(role, "memory")) return "verification_required";
  if ("openRouterProvider" in recommendation &&
    (model.openRouterRouting?.mode !== "only_selected" ||
      model.openRouterRouting.providers.length !== 1 ||
      model.openRouterRouting.providers[0] !== recommendation.openRouterProvider)) return "verification_required";
  if (!model.capabilities.reasoning ||
    !supportsConfiguredReasoningEffort(model, role.snapshot.providerFamily, recommendation.reasoningEffort)) return "reasoning_unavailable";
  const outputTokens = Math.min(model.capabilities.maxOutputTokens ?? Infinity,
    maxOutputTokensFromParams(model.defaultParams) ?? model.capabilities.defaultMaxOutputTokens ?? 0);
  if (outputTokens < recommendation.minimumOutputTokens ||
    (model.capabilities.contextWindow ?? 0) < recommendation.minimumContextWindow) return "budget_too_small";
  return null;
}

export function memoryRecommendationMatches(
  role: ProviderAdmissionRole, id: string, effort: string | null
): boolean {
  const recommendation = MEMORY_MODEL_RECOMMENDATIONS.find((entry) => entry.id === id);
  return Boolean(recommendation && effort === recommendation.reasoningEffort &&
    memoryRecommendationRejection(role, recommendation) === null);
}

export async function listMemoryModelRecommendations(
  db: AdmissionPrisma, models: readonly Model[], loadRole = loadInstallationAnswerProviderRole
): Promise<AdminMemoryModelRecommendation[]> {
  const result: AdminMemoryModelRecommendation[] = [];
  for (const recommendation of MEMORY_MODEL_RECOMMENDATIONS) {
    const matching = models.filter((row) => {
      try {
        const config = normalizeProviderModelConfiguration(row.activeConfig);
        return config.adapterKind === recommendation.adapterKind && config.upstreamModelId === recommendation.upstreamModelId;
      } catch { return false; }
    }).sort((a, b) => a.id.localeCompare(b.id));
    const base = { id: recommendation.id, modelName: recommendation.modelName,
      reasoningEffort: recommendation.reasoningEffort, evidence: { ...recommendation.evidence } };
    if (!matching.length) result.push({ ...base, providerModelId: null, connectionId: null,
      displayName: recommendation.modelName, unavailableReason: "not_installed" });
    for (const row of matching) {
      let unavailableReason: AdminMemoryModelRecommendation["unavailableReason"];
      try { unavailableReason = memoryRecommendationRejection(await loadRole(db, { providerModelId: row.id }), recommendation); }
      catch (error) {
        if (!(error instanceof ProviderAdmissionError)) throw error;
        unavailableReason = "verification_required";
      }
      result.push({ ...base, providerModelId: row.id, connectionId: row.connectionId,
        displayName: row.displayName, unavailableReason });
    }
  }
  return result;
}
