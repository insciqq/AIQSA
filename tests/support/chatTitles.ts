import type { ChatTitleWork } from "@/lib/server/chats/titleGeneration";

export function chatTitleWork(overrides: Partial<ChatTitleWork> = {}): ChatTitleWork {
  return {
    answerText: "TCP guarantees delivery; UDP trades that for latency.",
    chatId: "chat-1", expectedTitle: "Explain TCP versus UDP", questionText: "Explain TCP versus UDP",
    reasoningEffort: null, runId: "run-1", titleRevision: 0, userId: "user-1",
    providerSnapshot: {
      connection: { allowPrivateNetwork: false, apiRoot: "https://titles.example.test/v1",
        authenticationMode: "bearer", responseTimeoutMs: 8_000 },
      connectionDisplayName: "Title test", connectionId: "title-connection",
      credentialId: "title-credential", credentialVersionId: "title-credential-version",
      model: { adapterKind: "openai_responses_native", answerSelectable: true,
        capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false,
          reasoning: false, streaming: true, structuredOutput: true, vision: false },
        defaultParams: {}, modelClass: "answer", upstreamModelId: "title-test" },
      modelDisplayName: "Title test", providerFamily: "openai", providerModelId: "title-model", version: 1
    },
    ...overrides
  };
}
