import { existsSync, readFileSync } from "node:fs";
import {
  createFetchOpenRouterChatClient,
  createOpenRouterPerplexitySearchAdapter
} from "../lib/server/providers/openRouterChat";
import type { ProviderSearchRequest } from "../lib/server/providers/types";

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

const openRouterKey = process.env.OPENROUTER_API_KEY ?? "";
const searchModelId =
  process.env.AIQSA_DEFAULT_SEARCH_MODEL || "perplexity/sonar-pro-search";

if (!openRouterKey) {
  console.log("OpenRouter smoke skipped: OPENROUTER_API_KEY is not configured.");
  process.exit(0);
}

const request: ProviderSearchRequest = {
  answerModelId: process.env.AIQSA_DEFAULT_MODEL || "gpt-5.5",
  answerProvider: "openai",
  attachmentIds: [],
  attachments: [],
  chatId: "smoke-chat",
  content: {
    blocks: [
      {
        text: "What is the official OpenRouter model id for Sonar Pro Search? Reply very briefly.",
        type: "text"
      }
    ]
  },
  modelCapabilities: {
    nativePdfInput: false,
    nativeSearch: true,
    pdf: false,
    reasoning: false,
    vision: false
  },
  modelId: searchModelId,
  params: {
    search: {
      maxOutputTokens: 64,
      temperature: 0
    }
  },
  prompt: {
    developer: null,
    presetId: null,
    system: "You are running a tiny AIQSA OpenRouter Perplexity smoke test."
  },
  provider: "openrouter",
  searchModelId,
  searchPolicy: {
    controls: {
      maxOutputTokens: {
        defaultValue: 8192,
        maxValue: 8192
      },
      temperature: {
        defaultValue: 1,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    },
    defaultParams: {
      maxOutputTokens: 64,
      provider: {
        allowFallbacks: true,
        dataCollection: "deny",
        order: ["perplexity"],
        requireParameters: false,
        sort: "throughput",
        zdr: false
      },
      reasoning: {
        exclude: true
      },
      stream: false,
      temperature: 0
    },
    modelId: searchModelId,
    provider: "openrouter",
    strategyId: "perplexity-tool-search"
  },
  searchStrategy: "perplexity-tool-search",
  strategyId: "perplexity-tool-search"
};

async function main() {
  const adapter = createOpenRouterPerplexitySearchAdapter({
    client: createFetchOpenRouterChatClient({
      apiKey: openRouterKey,
      appTitle: process.env.OPENROUTER_APP_TITLE || "AIQSA",
      baseUrl: process.env.OPENROUTER_BASE_URL,
      httpReferer: process.env.OPENROUTER_HTTP_REFERER
    })
  });
  const result = await adapter.search(request);

  console.log(
    JSON.stringify(
      {
        artifactTypes: result.artifacts
          .filter((artifact) => artifact.type === "artifact")
          .map((artifact) => artifact.data.artifactType),
        outputPreview: result.finalText.slice(0, 160),
        providerResponseIdPresent: Boolean(result.providerResponseId),
        usage: result.usage
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "OpenRouter smoke failed");
  process.exit(1);
});
