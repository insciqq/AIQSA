export const providerTemplateIds = Object.freeze({
  anthropicConnection: "00000000-0000-4000-8000-000000001103",
  fakeConnection: "00000000-0000-4000-8000-000000001101",
  fakeModel: "00000000-0000-4000-8000-000000001201",
  geminiConnection: "00000000-0000-4000-8000-000000001105",
  openAiConnection: "00000000-0000-4000-8000-000000001102",
  openRouterConnection: "00000000-0000-4000-8000-000000001104"
});

export const providerModelTemplateIds = Object.freeze({
  "anthropic:claude-opus-5": "00000000-0000-4000-8000-000000001211",
  "anthropic:claude-opus-4-8": "00000000-0000-4000-8000-000000001206",
  "anthropic:claude-sonnet-5": "00000000-0000-4000-8000-000000001212",
  "fake:fake-qsa": providerTemplateIds.fakeModel,
  "gemini:gemini-3.1-pro-preview": "00000000-0000-4000-8000-000000001216",
  "gemini:gemini-3.5-flash": "00000000-0000-4000-8000-000000001214",
  "gemini:gemini-3.5-flash-lite": "00000000-0000-4000-8000-000000001215",
  "gemini:gemini-3.6-flash": "00000000-0000-4000-8000-000000001213",
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
    config: Object.freeze({
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1",
      authenticationMode: "none" as const,
      responseTimeoutMs: 300_000
    }),
    displayName: "Fake QSA",
    enabled: false,
    family: "fake",
    id: providerTemplateIds.fakeConnection,
    templateKey: "fake"
  }),
  Object.freeze({
    config: Object.freeze({
      allowPrivateNetwork: false,
      apiRoot: "https://api.openai.com/v1",
      authenticationMode: "bearer" as const,
      responseTimeoutMs: 300_000
    }),
    displayName: "OpenAI",
    enabled: false,
    family: "openai",
    id: providerTemplateIds.openAiConnection,
    templateKey: "openai"
  }),
  Object.freeze({
    config: Object.freeze({
      allowPrivateNetwork: false,
      apiRoot: "https://api.anthropic.com/v1",
      authenticationMode: "bearer" as const,
      responseTimeoutMs: 300_000
    }),
    displayName: "Anthropic",
    enabled: false,
    family: "anthropic",
    id: providerTemplateIds.anthropicConnection,
    templateKey: "anthropic"
  }),
  Object.freeze({
    config: Object.freeze({
      allowPrivateNetwork: false,
      apiRoot: "https://generativelanguage.googleapis.com/v1",
      authenticationMode: "bearer" as const,
      responseTimeoutMs: 300_000
    }),
    displayName: "Gemini",
    enabled: false,
    family: "gemini",
    id: providerTemplateIds.geminiConnection,
    templateKey: "gemini"
  }),
  Object.freeze({
    config: Object.freeze({
      allowPrivateNetwork: false,
      apiRoot: "https://openrouter.ai/api/v1",
      authenticationMode: "bearer" as const,
      responseTimeoutMs: 300_000
    }),
    displayName: "OpenRouter",
    enabled: false,
    family: "openrouter",
    id: providerTemplateIds.openRouterConnection,
    templateKey: "openrouter"
  })
]);
