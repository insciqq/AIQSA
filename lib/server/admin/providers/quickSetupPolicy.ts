import type {
  AdminProviderQuickSetupCandidate,
  AdminProviderQuickSetupProviderId,
  AdminProviderQuickSetupSelection
} from "../../../contracts/adminProviderQuickSetup";
import {
  defaultProviderModels,
  type ProviderModelCatalogEntry
} from "../../../domain/catalog";
import {
  providerConnectionTemplates,
  providerModelTemplateId,
  type ProviderModelTemplateKey
} from "../../../domain/providerTemplates";
import {
  DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";

export const ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION = 4;

type QuickSetupCandidateDefinition = Readonly<{
  candidateId: string;
  recommended: boolean;
  templateKey: ProviderModelTemplateKey;
}>;

export type AdminProviderQuickSetupPolicyCandidate = QuickSetupCandidateDefinition & Readonly<{
  configuration: ProviderModelConfiguration;
  displayName: string;
  model: ProviderModelCatalogEntry;
  modelId: string;
  provider: AdminProviderQuickSetupProviderId;
}>;

export type AdminProviderQuickSetupPolicy = Readonly<{
  candidates: readonly AdminProviderQuickSetupPolicyCandidate[];
  connection: Readonly<{
    configuration: ProviderConnectionConfiguration;
    displayName: string;
    id: string;
    templateKey: AdminProviderQuickSetupProviderId;
  }>;
  provider: AdminProviderQuickSetupProviderId;
  version: number;
}>;

const candidateDefinitions: Readonly<Record<
  AdminProviderQuickSetupProviderId,
  readonly QuickSetupCandidateDefinition[]
>> = Object.freeze({
  anthropic: Object.freeze([
    Object.freeze({
      candidateId: "p2-a1",
      recommended: true,
      templateKey: "anthropic:claude-opus-5"
    }),
    Object.freeze({
      candidateId: "p2-a2",
      recommended: false,
      templateKey: "anthropic:claude-sonnet-5"
    })
  ]),
  gemini: Object.freeze([
    Object.freeze({
      candidateId: "p2-g1",
      recommended: true,
      templateKey: "gemini:gemini-3.6-flash"
    }),
    Object.freeze({
      candidateId: "p2-g2",
      recommended: false,
      templateKey: "gemini:gemini-3.5-flash"
    }),
    Object.freeze({
      candidateId: "p2-g3",
      recommended: false,
      templateKey: "gemini:gemini-3.5-flash-lite"
    }),
    Object.freeze({
      candidateId: "p2-g4",
      recommended: false,
      templateKey: "gemini:gemini-3.1-pro-preview"
    })
  ]),
  openai: Object.freeze([
    Object.freeze({
      candidateId: "p2-o1",
      recommended: true,
      templateKey: "openai:gpt-5.6-terra"
    }),
    Object.freeze({
      candidateId: "p2-o2",
      recommended: false,
      templateKey: "openai:gpt-5.6-luna"
    }),
    Object.freeze({
      candidateId: "p2-o3",
      recommended: false,
      templateKey: "openai:gpt-5.6-sol"
    })
  ]),
  openrouter: Object.freeze([
    Object.freeze({
      candidateId: "p1-r1",
      recommended: true,
      templateKey: "openrouter:anthropic/claude-opus-4.8"
    }),
    Object.freeze({
      candidateId: "p1-r2",
      recommended: false,
      templateKey: "openrouter:google/gemini-3.5-flash"
    }),
    Object.freeze({
      candidateId: "p1-r3",
      recommended: false,
      templateKey: "openrouter:~google/gemini-pro-latest"
    })
  ])
});

function modelTemplate(templateKey: ProviderModelTemplateKey): ProviderModelCatalogEntry {
  const [provider, ...modelParts] = templateKey.split(":");
  const modelId = modelParts.join(":");
  const model = defaultProviderModels.find(
    (candidate) => candidate.provider === provider && candidate.modelId === modelId
  );
  if (!model) throw new Error("provider_quick_setup_policy_model_missing");
  return model;
}

export function providerModelConfigurationFromCatalogEntry(
  model: ProviderModelCatalogEntry
): ProviderModelConfiguration {
  if (model.adapterKind === "fake") {
    throw new Error("provider_quick_setup_policy_model_invalid");
  }
  const routeProvider = model.defaultParams.provider;
  const routeOnly = routeProvider && typeof routeProvider === "object" &&
    !Array.isArray(routeProvider)
    ? (routeProvider as Record<string, unknown>).only
    : null;
  const selectedProviders = Array.isArray(routeOnly)
    ? [...new Set(routeOnly.filter((value): value is string =>
        typeof value === "string" && Boolean(value.trim())
      ).map((value) => value.trim()))]
    : [];

  return {
    adapterKind: model.adapterKind,
    answerSelectable: true,
    capabilities: {
      ...model.capabilities,
      contextWindow: model.contextWindow
    },
    defaultParams: model.defaultParams,
    ...(model.provider === "openrouter"
      ? {
          openRouterRouting: selectedProviders.length > 0
            ? { mode: "only_selected" as const, providers: selectedProviders }
            : { mode: "automatic" as const, providers: [] }
        }
      : {}),
    upstreamModelId: model.upstreamModelId
  };
}

function createPolicy(provider: AdminProviderQuickSetupProviderId): AdminProviderQuickSetupPolicy {
  const connection = providerConnectionTemplates.find(
    (candidate) => candidate.templateKey === provider
  );
  if (!connection || connection.family !== provider) {
    throw new Error("provider_quick_setup_policy_connection_missing");
  }
  return {
    candidates: candidateDefinitions[provider].map((definition) => {
      const model = modelTemplate(definition.templateKey);
      const modelId = providerModelTemplateId(definition.templateKey);
      if (!modelId) throw new Error("provider_quick_setup_policy_model_id_missing");
      return Object.freeze({
        ...definition,
        configuration: providerModelConfigurationFromCatalogEntry(model),
        displayName: model.displayName,
        model,
        modelId,
        provider
      });
    }),
    connection: {
      configuration: {
        ...connection.config,
        responseTimeoutMs: DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS
      },
      displayName: connection.displayName,
      id: connection.id,
      templateKey: provider
    },
    provider,
    version: ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION
  };
}

const policies = Object.freeze({
  anthropic: createPolicy("anthropic"),
  gemini: createPolicy("gemini"),
  openai: createPolicy("openai"),
  openrouter: createPolicy("openrouter")
});

export function adminProviderQuickSetupPolicy(
  provider: AdminProviderQuickSetupProviderId
): AdminProviderQuickSetupPolicy {
  return policies[provider];
}

export type AdminProviderQuickSetupPolicyDecision =
  | Readonly<{ candidate: AdminProviderQuickSetupPolicyCandidate; kind: "selected" }>
  | Readonly<{ candidates: AdminProviderQuickSetupCandidate[]; kind: "selection_required" }>
  | Readonly<{ kind: "selection_invalid" }>
  | Readonly<{ kind: "unsupported_catalog" }>;

export function decideAdminProviderQuickSetupModel(input: Readonly<{
  modelIds: readonly string[];
  policy: AdminProviderQuickSetupPolicy;
  selectedModel?: AdminProviderQuickSetupSelection;
}>): AdminProviderQuickSetupPolicyDecision {
  const observed = new Set(input.modelIds);
  if (input.selectedModel) {
    const candidate = input.policy.version === input.selectedModel.policyVersion
      ? input.policy.candidates.find(
          (entry) => entry.candidateId === input.selectedModel?.candidateId
        )
      : null;
    if (!candidate || !observed.has(candidate.configuration.upstreamModelId)) {
      return { kind: "selection_invalid" };
    }
    return { candidate, kind: "selected" };
  }

  const recommendation = input.policy.candidates.find(
    (candidate) => candidate.recommended && observed.has(candidate.configuration.upstreamModelId)
  );
  if (recommendation) return { candidate: recommendation, kind: "selected" };

  const candidates = input.policy.candidates
    .filter((candidate) => !candidate.recommended && observed.has(candidate.configuration.upstreamModelId))
    .map(({ candidateId, displayName }) => ({ candidateId, displayName }));
  return candidates.length > 0
    ? { candidates, kind: "selection_required" }
    : { kind: "unsupported_catalog" };
}
