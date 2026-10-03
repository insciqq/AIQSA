// Publisher namespaces identify the model's author; provider slugs identify the
// serving company. They are deliberately distinct (for example qwen/alibaba).
// Slugs are checked against OpenRouter's providers catalog. A mapping alone
// never authorizes a route: the exact model's discovered endpoint must match.
const NATIVE_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["anthropic"],
  cohere: ["cohere"],
  deepseek: ["deepseek"],
  google: ["google-ai-studio", "google-vertex"],
  mistralai: ["mistral"],
  moonshotai: ["moonshotai"],
  openai: ["openai"],
  perplexity: ["perplexity"],
  qwen: ["alibaba"],
  typesafe: ["typesafe"],
  voyageai: ["voyageai"],
  "x-ai": ["xai"]
};

export type NativeProviderEndpoint = Readonly<{
  tag: string;
  supportedParameters: readonly string[];
  maxCompletionTokens?: number;
  supportsToolChoice?: Readonly<{ required?: boolean; function?: boolean }>;
}>;

export type NativeProviderResolution =
  | { available: true; provider: string }
  | { available: false; reason: "publisher_unknown" | "native_unavailable" | "native_incompatible";
      mismatch?: { provider: string; missingParameters: readonly string[]; outputLimit?: number; forcedToolChoice?: true } };

/** The caller must discover endpoints for this exact model and credential.
 * Return the endpoint's actual tag, including any variant, without inventing
 * a slug from display names or silently permitting other serving companies. */
export function resolveOpenRouterNativeProvider(input: {
  modelId: string;
  endpoints: readonly NativeProviderEndpoint[];
  requiredParameters?: readonly string[];
  maxOutputTokens?: number;
  requireForcedToolChoice?: boolean;
}): NativeProviderResolution {
  const parts = input.modelId.split("/");
  const native = parts.length === 2 && parts[1] && Object.hasOwn(NATIVE_PROVIDERS, parts[0]!) ? NATIVE_PROVIDERS[parts[0]!] : undefined;
  if (!native) return { available: false, reason: "publisher_unknown" };
  let found = false;
  let mismatch: Extract<NativeProviderResolution, { available: false }>["mismatch"];
  for (const slug of native) {
    const endpoints = input.endpoints.filter(({ tag }) => tag.toLowerCase().split("/")[0] === slug)
      .sort((a, b) => Number(b.tag.toLowerCase() === slug) - Number(a.tag.toLowerCase() === slug) || a.tag.localeCompare(b.tag));
    found ||= endpoints.length > 0;
    const compatible = endpoints.find((endpoint) => {
      const missingParameters = (input.requiredParameters ?? []).filter((parameter) => !endpoint.supportedParameters.includes(parameter));
      const outputLimited = input.maxOutputTokens !== undefined && endpoint.maxCompletionTokens !== undefined &&
        endpoint.maxCompletionTokens < input.maxOutputTokens;
      const forcedUnsupported = input.requireForcedToolChoice &&
        (endpoint.supportsToolChoice?.required === false || endpoint.supportsToolChoice?.function === false);
      if (!missingParameters.length && !outputLimited && !forcedUnsupported) return true;
      mismatch ??= { provider: endpoint.tag, missingParameters,
        ...(outputLimited ? { outputLimit: endpoint.maxCompletionTokens } : {}),
        ...(forcedUnsupported ? { forcedToolChoice: true } : {}) };
      return false;
    });
    if (compatible) return { available: true, provider: compatible.tag };
  }
  return { available: false, reason: found ? "native_incompatible" : "native_unavailable", ...(mismatch ? { mismatch } : {}) };
}

/** True when the endpoint serves an OpenRouter `provider.only` entry: the exact
 * tag, or any variant of a bare provider slug (`deepseek` serves `deepseek/fp8`). */
export function openRouterEndpointServesProvider(endpointTag: string, provider: string): boolean {
  const tag = endpointTag.toLowerCase();
  const wanted = provider.toLowerCase();
  return tag === wanted || !wanted.includes("/") && tag.split("/")[0] === wanted;
}

/** Each parameter set is one request kind sent with `require_parameters`, so
 * at least one selected endpoint must list every parameter of that set.
 * Returns the parameters the closest selected endpoint lacks for unmet sets. */
export function openRouterSelectedProvidersMissingParameters(input: {
  providers: readonly string[];
  endpoints: readonly NativeProviderEndpoint[];
  parameterSets: readonly (readonly string[])[];
}): string[] {
  const served = input.endpoints.filter(({ tag }) =>
    input.providers.some((provider) => openRouterEndpointServesProvider(tag, provider)));
  const missing = new Set<string>();
  for (const parameters of input.parameterSets) {
    const gaps = served.map((endpoint) => parameters.filter((parameter) => !endpoint.supportedParameters.includes(parameter)));
    if (gaps.some((gap) => gap.length === 0)) continue;
    const closest = gaps.reduce<readonly string[]>((best, gap) => gap.length < best.length ? gap : best, parameters);
    for (const parameter of closest) missing.add(parameter);
  }
  return [...missing];
}
