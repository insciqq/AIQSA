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
  voyageai: ["voyageai"],
  "x-ai": ["xai"]
};

export type NativeProviderEndpoint = Readonly<{
  tag: string;
  supportedParameters: readonly string[];
  maxCompletionTokens?: number;
}>;

export type NativeProviderResolution =
  | { available: true; provider: string }
  | { available: false; reason: "publisher_unknown" | "native_unavailable" | "native_incompatible" };

/** The caller must discover endpoints for this exact model and credential.
 * Return the endpoint's actual tag, including any variant, without inventing
 * a slug from display names or silently permitting other serving companies. */
export function resolveOpenRouterNativeProvider(input: {
  modelId: string;
  endpoints: readonly NativeProviderEndpoint[];
  requiredParameters?: readonly string[];
  maxOutputTokens?: number;
}): NativeProviderResolution {
  const parts = input.modelId.split("/");
  const native = parts.length === 2 && parts[1] && Object.hasOwn(NATIVE_PROVIDERS, parts[0]!) ? NATIVE_PROVIDERS[parts[0]!] : undefined;
  if (!native) return { available: false, reason: "publisher_unknown" };
  let found = false;
  for (const slug of native) {
    const endpoints = input.endpoints.filter(({ tag }) => tag.toLowerCase().split("/")[0] === slug)
      .sort((a, b) => Number(b.tag.toLowerCase() === slug) - Number(a.tag.toLowerCase() === slug) || a.tag.localeCompare(b.tag));
    found ||= endpoints.length > 0;
    const compatible = endpoints.find((endpoint) =>
      (input.requiredParameters ?? []).every((parameter) => endpoint.supportedParameters.includes(parameter)) &&
      (input.maxOutputTokens === undefined || endpoint.maxCompletionTokens === undefined ||
        endpoint.maxCompletionTokens >= input.maxOutputTokens));
    if (compatible) return { available: true, provider: compatible.tag };
  }
  return { available: false, reason: found ? "native_incompatible" : "native_unavailable" };
}
