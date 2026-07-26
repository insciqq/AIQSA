export const providerTemplateIds = Object.freeze({
  anthropicConnection: "00000000-0000-4000-8000-000000001103",
  fakeConnection: "00000000-0000-4000-8000-000000001101",
  fakeModel: "00000000-0000-4000-8000-000000001201",
  openAiConnection: "00000000-0000-4000-8000-000000001102",
  openRouterConnection: "00000000-0000-4000-8000-000000001104"
});

export const providerModelTemplateIds = Object.freeze({
  "anthropic:claude-opus-4-8": "00000000-0000-4000-8000-000000001206",
  "fake:fake-qsa": providerTemplateIds.fakeModel,
  "openai:gpt-5.5": "00000000-0000-4000-8000-000000001202",
  "openai:gpt-5.6-luna": "00000000-0000-4000-8000-000000001205",
  "openai:gpt-5.6-sol": "00000000-0000-4000-8000-000000001203",
  "openai:gpt-5.6-terra": "00000000-0000-4000-8000-000000001204",
  "openrouter:anthropic/claude-opus-4.8": "00000000-0000-4000-8000-000000001207",
  "openrouter:google/gemini-3.5-flash": "00000000-0000-4000-8000-000000001208",
  "openrouter:perplexity/sonar-pro-search": "00000000-0000-4000-8000-000000001210",
  "openrouter:~google/gemini-pro-latest": "00000000-0000-4000-8000-000000001209"
} as const);

export type ProviderModelTemplateKey = keyof typeof providerModelTemplateIds;

export function providerModelTemplateId(templateKey: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(providerModelTemplateIds, templateKey)
    ? providerModelTemplateIds[templateKey as ProviderModelTemplateKey]
    : undefined;
}

export const providerConnectionTemplates = Object.freeze([
  Object.freeze({
    config: Object.freeze({ allowPrivateNetwork: true, apiRoot: "http://127.0.0.1" }),
    displayName: "Fake QSA",
    enabled: true,
    family: "fake",
    id: providerTemplateIds.fakeConnection,
    templateKey: "fake"
  }),
  Object.freeze({
    config: Object.freeze({ allowPrivateNetwork: false, apiRoot: "https://api.openai.com/v1" }),
    displayName: "OpenAI",
    enabled: false,
    family: "openai",
    id: providerTemplateIds.openAiConnection,
    templateKey: "openai"
  }),
  Object.freeze({
    config: Object.freeze({ allowPrivateNetwork: false, apiRoot: "https://api.anthropic.com/v1" }),
    displayName: "Anthropic",
    enabled: false,
    family: "anthropic",
    id: providerTemplateIds.anthropicConnection,
    templateKey: "anthropic"
  }),
  Object.freeze({
    config: Object.freeze({ allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" }),
    displayName: "OpenRouter",
    enabled: false,
    family: "openrouter",
    id: providerTemplateIds.openRouterConnection,
    templateKey: "openrouter"
  })
]);
