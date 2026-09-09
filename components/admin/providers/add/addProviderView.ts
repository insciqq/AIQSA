import type { AdminProviderReasoningChoice } from "@/components/admin/adminProviderReasoning";
import { reasoningForChoice } from "@/components/admin/adminProviderReasoning";
import { providerFamilyLabel } from "@/components/admin/providers/providerListView";
import type { AdminProviderQuickSetupSubmit } from "@/components/admin/adminProviderQuickSetupApi";
import {
  ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
  MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS,
  type AdminProviderCustomDiscoveredModel,
  type AdminProviderCustomDiscoveryRequest,
  type AdminProviderCustomProtocol,
  type AdminProviderCustomSetupRequest
} from "@/lib/contracts/adminProviderCustomSetup";
import {
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS,
  type AdminProviderQuickSetupProviderId,
  type AdminProviderQuickSetupSelection
} from "@/lib/contracts/adminProviderQuickSetup";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS,
  type AdminProviderConnection
} from "@/lib/contracts/adminProviders";
import { compatibleReasoningRequestMappingDefault } from "@/lib/contracts/providerReasoningRequestMapping";
import { providerConnectionTemplates } from "@/lib/domain/providerTemplates";

/** Pure view rules for the Add provider sheet (PRD 5.3). */

export type AddProviderFamily = AdminProviderQuickSetupProviderId | "custom";

export type AddProviderTile = Readonly<{
  family: AddProviderFamily;
  label: string;
  subtitle?: string;
}>;

/** The six tiles in artboard order; only Custom carries a protocol subtitle. */
export const ADD_PROVIDER_TILES: readonly AddProviderTile[] = [
  ...ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.map((family) => ({
    family,
    label: providerFamilyLabel(family)
  })),
  { family: "custom", label: "Custom", subtitle: "OpenAI-compatible" }
];

export type BuiltInForm = Readonly<{
  allowPrivateNetwork: boolean;
  apiRoot: string;
  name: string;
  responseTimeoutSeconds: string;
  secret: string;
}>;

export type CustomForm = Readonly<{
  allowPrivateNetwork: boolean;
  apiRoot: string;
  manualModelId: string;
  name: string;
  noKey: boolean;
  protocol: AdminProviderCustomProtocol;
  reasoningChoice: AdminProviderReasoningChoice;
  reasoningEffortPath: string;
  reasoningModePath: string;
  responseTimeoutSeconds: string;
  secret: string;
  selectedModelIds: readonly string[];
}>;

const DEFAULT_TIMEOUT = String(ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS);

/** The vendor endpoint a built-in family uses unless Advanced overrides it. */
export function vendorEndpoint(family: AdminProviderQuickSetupProviderId): string {
  return providerConnectionTemplates.find((template) => template.family === family)?.config.apiRoot ?? "";
}

export function familyConnections(
  connections: readonly AdminProviderConnection[],
  family: AdminProviderQuickSetupProviderId
): readonly AdminProviderConnection[] {
  return connections.filter((connection) => connection.family === family);
}

export function nameTaken(name: string, connections: readonly AdminProviderConnection[]): boolean {
  const wanted = name.trim().toLowerCase();
  return wanted.length > 0 &&
    connections.some((connection) => connection.displayName.trim().toLowerCase() === wanted);
}

/**
 * The prefilled name: the family name for a first connection, and a numbered
 * name (`OpenAI · 2`) once the family already has one (PRD 5.3).
 */
export function suggestedConnectionName(
  family: AdminProviderQuickSetupProviderId,
  connections: readonly AdminProviderConnection[]
): string {
  const label = providerFamilyLabel(family);
  if (familyConnections(connections, family).length === 0 && !nameTaken(label, connections)) return label;
  for (let ordinal = 2; ordinal < 100; ordinal += 1) {
    const candidate = `${label} · ${ordinal}`;
    if (!nameTaken(candidate, connections)) return candidate;
  }
  return "";
}

export function initialBuiltInForm(
  family: AdminProviderQuickSetupProviderId,
  connections: readonly AdminProviderConnection[]
): BuiltInForm {
  return {
    allowPrivateNetwork: false,
    apiRoot: vendorEndpoint(family),
    name: suggestedConnectionName(family, connections),
    responseTimeoutSeconds: DEFAULT_TIMEOUT,
    secret: ""
  };
}

export function initialCustomForm(): CustomForm {
  return {
    allowPrivateNetwork: false,
    apiRoot: "",
    manualModelId: "",
    name: "",
    noKey: false,
    protocol: "chat_completions",
    reasoningChoice: "automatic",
    reasoningEffortPath: compatibleReasoningRequestMappingDefault("chat_completions").effortPath,
    reasoningModePath: compatibleReasoningRequestMappingDefault("chat_completions").modePath ?? "",
    responseTimeoutSeconds: DEFAULT_TIMEOUT,
    secret: "",
    selectedModelIds: []
  };
}

export function urlProtocol(value: string): string | null {
  try {
    return new URL(value.trim()).protocol;
  } catch {
    return null;
  }
}

export function timeoutSeconds(value: string): number | null {
  if (!/^\d+$/u.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) &&
    seconds >= ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS &&
    seconds <= ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS
    ? seconds
    : null;
}

/** The default name for a custom endpoint, from its host (matches the server default). */
export function customNameFor(apiRoot: string): string {
  try {
    const hostname = new URL(apiRoot.trim()).hostname;
    return hostname ? `Custom · ${hostname}` : "";
  } catch {
    return "";
  }
}

/** Whether the built-in Advanced fields still equal the vendor defaults. */
export function builtInOverridesDefault(form: BuiltInForm, family: AdminProviderQuickSetupProviderId): boolean {
  return form.apiRoot.trim() === vendorEndpoint(family) &&
    !form.allowPrivateNetwork &&
    form.responseTimeoutSeconds.trim() === DEFAULT_TIMEOUT;
}

export type BuiltInValidation =
  | Readonly<{ body: AdminProviderQuickSetupSubmit; ok: true }>
  | Readonly<{ field: "apiRoot" | "name" | "secret" | "timeout"; message: string; ok: false }>;

export function builtInRequest(input: Readonly<{
  connections: readonly AdminProviderConnection[];
  expectedState: string;
  family: AdminProviderQuickSetupProviderId;
  form: BuiltInForm;
  selectedModel?: AdminProviderQuickSetupSelection;
}>): BuiltInValidation {
  const { form } = input;
  // The name is required only once the family already has a connection (PRD 5.3).
  const name = form.name.trim() ||
    (familyConnections(input.connections, input.family).length === 0 ? providerFamilyLabel(input.family) : "");
  if (!name) return { field: "name", message: "Enter a name for this connection.", ok: false };
  if (nameTaken(name, input.connections)) {
    return { field: "name", message: "Another provider already has this name. Choose a different one.", ok: false };
  }
  if (!form.secret.trim()) return { field: "secret", message: "Enter the API key.", ok: false };
  const protocol = urlProtocol(form.apiRoot);
  if (!protocol || (protocol !== "https:" && protocol !== "http:")) {
    return { field: "apiRoot", message: "Enter the endpoint as a full URL.", ok: false };
  }
  if (protocol === "http:" && !form.allowPrivateNetwork) {
    return { field: "apiRoot", message: "A public endpoint needs HTTPS. Turn on Private network for a local one.", ok: false };
  }
  const seconds = timeoutSeconds(form.responseTimeoutSeconds);
  if (seconds === null) {
    return {
      field: "timeout",
      message: `Response timeout must be ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS} to ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS} seconds.`,
      ok: false
    };
  }
  return {
    body: {
      ...(builtInOverridesDefault(form, input.family)
        ? {}
        : {
            configuration: {
              allowPrivateNetwork: form.allowPrivateNetwork,
              apiRoot: form.apiRoot.trim(),
              responseTimeoutSeconds: seconds
            }
          }),
      connectionDisplayName: name,
      expectedState: input.expectedState,
      provider: input.family,
      secret: form.secret.trim(),
      ...(input.selectedModel ? { selectedModel: input.selectedModel } : {})
    },
    ok: true
  };
}

export type DiscoveredModelHint = Readonly<{ hint: string; supported: boolean }>;

/** A short capability hint per discovered id; ids that are not chat models cannot be selected. */
export function discoveredModelHint(model: AdminProviderCustomDiscoveredModel): DiscoveredModelHint {
  const id = model.id.toLowerCase();
  if (/embed/u.test(id)) return { hint: "embeddings", supported: false };
  if (/rerank/u.test(id)) return { hint: "reranking", supported: false };
  if (/whisper|\btts\b|speech|audio|transcri|moderation|dall-e|image-|imagen|stable-diffusion/u.test(id)) {
    return { hint: "not supported", supported: false };
  }
  const parts: string[] = [];
  if (model.capabilities.reasoning) parts.push("reasoning");
  if (model.capabilities.toolCalling !== undefined) parts.push(model.capabilities.toolCalling ? "tools" : "tools off");
  if (model.capabilities.vision !== undefined) parts.push(model.capabilities.vision ? "images" : "images off");
  if (model.capabilities.parallelToolCalls !== undefined) parts.push(model.capabilities.parallelToolCalls ? "parallel calls" : "parallel calls off");
  if (model.capabilities.contextWindow) parts.push(`${Math.round(model.capabilities.contextWindow / 1000)}k context`);
  if (model.capabilities.maxOutputTokens) parts.push(`${model.capabilities.maxOutputTokens.toLocaleString("en-US")} max output`);
  if (model.capabilities.defaultMaxOutputTokens) parts.push(`${model.capabilities.defaultMaxOutputTokens.toLocaleString("en-US")} default output`);
  return { hint: parts.length ? parts.join(" · ") : "chat", supported: true };
}

export function customDiscoveryRequest(form: CustomForm): AdminProviderCustomDiscoveryRequest | null {
  const seconds = timeoutSeconds(form.responseTimeoutSeconds);
  const protocol = urlProtocol(form.apiRoot);
  if (!protocol || seconds === null) return null;
  const secret = form.secret.trim();
  if (form.noKey ? !form.allowPrivateNetwork || protocol !== "http:" : !secret) return null;
  return {
    allowPrivateNetwork: form.allowPrivateNetwork,
    apiRoot: form.apiRoot.trim(),
    authenticationMode: form.noKey ? "none" : "bearer",
    responseTimeoutSeconds: seconds,
    ...(form.noKey ? {} : { secret })
  };
}

export type CustomValidation =
  | Readonly<{ body: AdminProviderCustomSetupRequest; ok: true }>
  | Readonly<{ field: "apiRoot" | "models" | "name" | "reasoning" | "secret" | "timeout"; message: string; ok: false }>;

export function customRequest(input: Readonly<{
  connections: readonly AdminProviderConnection[];
  discovered: readonly AdminProviderCustomDiscoveredModel[] | null;
  form: CustomForm;
}>): CustomValidation {
  const { discovered, form } = input;
  const protocol = urlProtocol(form.apiRoot);
  if (!protocol || (protocol !== "https:" && protocol !== "http:")) {
    return { field: "apiRoot", message: "Enter the base URL as a full URL, for example https://host/v1.", ok: false };
  }
  if (protocol === "http:" && !form.allowPrivateNetwork) {
    return { field: "apiRoot", message: "A public endpoint needs HTTPS. Turn on Private network for a local one.", ok: false };
  }
  if (form.noKey) {
    if (protocol !== "http:" || !form.allowPrivateNetwork) {
      return { field: "secret", message: "An endpoint without a key must be a private http:// address with Private network on.", ok: false };
    }
    if (form.protocol !== "chat_completions") {
      return { field: "secret", message: "An endpoint without a key must use Chat Completions.", ok: false };
    }
  } else if (!form.secret.trim()) {
    return { field: "secret", message: "Enter the API key, or mark the endpoint as needing no key.", ok: false };
  }
  const name = form.name.trim();
  if (!name) return { field: "name", message: "Enter a name for this connection.", ok: false };
  if (nameTaken(name, input.connections)) {
    return { field: "name", message: "Another provider already has this name. Choose a different one.", ok: false };
  }
  const seconds = timeoutSeconds(form.responseTimeoutSeconds);
  if (seconds === null) {
    return {
      field: "timeout",
      message: `Response timeout must be ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS} to ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS} seconds.`,
      ok: false
    };
  }
  const usesDiscovered = Boolean(discovered?.length);
  const modelIds = usesDiscovered
    ? discovered!.filter(({ id }) => form.selectedModelIds.includes(id)).map(({ id }) => id)
    : [];
  const manualModelId = form.manualModelId.trim();
  if (usesDiscovered ? modelIds.length < 1 : !manualModelId) {
    return {
      field: "models",
      message: usesDiscovered ? "Choose at least one model." : "Find the endpoint's models, or enter a model ID.",
      ok: false
    };
  }
  if (modelIds.length > MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS) {
    return { field: "models", message: `Choose at most ${MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS} models.`, ok: false };
  }
  const selected = (discovered ?? []).filter(({ id }) => modelIds.includes(id));
  const reasoning = form.reasoningChoice === "automatic"
    ? { reasoning: false }
    : reasoningForChoice(form.reasoningChoice, []);
  const perModelCapabilities = Object.fromEntries(selected.map((model) => {
    const capabilities = { ...model.capabilities };
    if (form.reasoningChoice !== "automatic") {
      delete capabilities.defaultReasoningEffort;
      delete capabilities.defaultReasoningMode;
      delete capabilities.reasoningEfforts;
      delete capabilities.reasoningModes;
      Object.assign(capabilities, reasoning);
    }
    return [model.id, capabilities] as const;
  }));
  const usesReasoning = reasoning.reasoning ||
    Object.values(perModelCapabilities).some((capabilities) => capabilities.reasoning === true);
  if (usesReasoning && !form.reasoningEffortPath.trim()) {
    return { field: "reasoning", message: "Enter the reasoning effort field, or turn reasoning off.", ok: false };
  }
  return {
    body: {
      allowPrivateNetwork: form.allowPrivateNetwork,
      apiRoot: form.apiRoot.trim(),
      authenticationMode: form.noKey ? "none" : "bearer",
      capabilities: {
        ...ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
        ...reasoning
      },
      confirmPaidRequest: true,
      connectionDisplayName: name,
      ...(usesDiscovered ? { modelIds, perModelCapabilities } : { modelId: manualModelId }),
      protocol: form.protocol,
      ...(usesReasoning
        ? {
            reasoningRequestMapping: {
              effortPath: form.reasoningEffortPath.trim(),
              ...(form.reasoningModePath.trim() ? { modePath: form.reasoningModePath.trim() } : {})
            }
          }
        : {}),
      responseTimeoutSeconds: seconds,
      ...(form.noKey ? {} : { secret: form.secret.trim() })
    },
    ok: true
  };
}

export function customSaveLabel(count: number): string {
  if (count === 0) return "Test & Save";
  return `Test & Save ${count} ${count === 1 ? "model" : "models"}`;
}
