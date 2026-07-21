import { existsSync, readFileSync } from "node:fs";
import { createOpenAIResponsesAdapter, createFetchOpenAIResponsesClient } from "../lib/server/providers/openaiResponses";
import type { ProviderRunRequest } from "../lib/server/providers/types";

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadLocalEnv() {
  if (!existsSync(".env")) {
    return;
  }

  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1));

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();

const openAIKey = process.env.OPENAI_API_KEY ?? "";
const maxOutputTokens = 64;

if (!openAIKey) {
  console.log("OpenAI smoke skipped: OPENAI_API_KEY is not configured.");
  process.exit(0);
}

const request: ProviderRunRequest = {
  attachmentIds: [],
  attachments: [],
  chatId: "smoke-chat",
  content: {
    blocks: [
      {
        text: "Reply with exactly: AIQSA_OK",
        type: "text"
      }
    ]
  },
  modelCapabilities: {
    nativePdfInput: false,
    nativeSearch: true,
    pdf: true,
    reasoning: true,
    vision: true
  },
  modelId: process.env.AIQSA_DEFAULT_MODEL || "gpt-5.5",
  params: {
    background: true,
    maxOutputTokens,
    reasoning: {
      effort: "none",
      summary: "none"
    },
    stream: false,
    store: true
  },
  prompt: {
    developer: null,
    presetId: null,
    system: "You are running a tiny AIQSA provider adapter smoke test."
  },
  provider: "openai",
  searchStrategy: "search-disabled"
};

async function main() {
  const adapter = createOpenAIResponsesAdapter({
    client: createFetchOpenAIResponsesClient({
      apiKey: openAIKey,
      baseUrl: process.env.OPENAI_BASE_URL
    }),
    pollIntervalMs: 1000,
    pollTimeoutMs: 30_000
  });
  const stream = adapter.stream(request);
  let next = await stream.next();

  while (!next.done) {
    const event = next.value;
    if (event.type === "artifact" && event.data.artifactType === "summary") {
      const payload = event.data.payload as { status?: unknown };
      if (typeof payload.status === "string") {
        console.log(`OpenAI smoke status: ${payload.status}`);
      }
    }

    next = await stream.next();
  }

  console.log(
    JSON.stringify(
      {
        outputPreview: next.value.finalText.slice(0, 80),
        providerResponseIdPresent: Boolean(next.value.providerResponseId),
        usage: next.value.usage
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "OpenAI smoke failed");
  process.exit(1);
});
