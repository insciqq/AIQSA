import { existsSync, readFileSync } from "node:fs";
import { safeExternalHref } from "../lib/domain/links";
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
const searchEnabled = process.env.AIQSA_OPENAI_SMOKE_SEARCH === "1";
const maxOutputTokens = searchEnabled ? 128 : 64;

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
        text: searchEnabled
          ? "Find the official OpenAI home page and answer with one short sentence."
          : "Reply with exactly: AIQSA_OK",
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
    background: false,
    maxOutputTokens,
    reasoning: {
      effort: "none",
      summary: "none"
    },
    stream: false,
    store: false
  },
  prompt: {
    developer: null,
    system: "You are running a tiny AIQSA provider adapter smoke test."
  },
  provider: "openai",
  searchStrategy: searchEnabled ? "openai-native-web-search" : "search-disabled"
};

function safeSourceCount(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value !== "object" || value === null) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + safeSourceCount(entry, seen), 0);
  }
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "url" || key === "href") && typeof entry === "string" && safeExternalHref(entry)) {
      count += 1;
    } else {
      count += safeSourceCount(entry, seen);
    }
  }
  return count;
}

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
  const artifacts: unknown[] = [];
  let next = await stream.next();

  while (!next.done) {
    const event = next.value;
    if (event.type === "artifact") artifacts.push(event.data);
    if (event.type === "artifact" && event.data.artifactType === "summary") {
      const payload = event.data.payload as { status?: unknown };
      if (typeof payload.status === "string") {
        console.log(`OpenAI smoke status: ${payload.status}`);
      }
    }

    next = await stream.next();
  }

  const finalOutputMatched = !searchEnabled && next.value.finalText.trim() === "AIQSA_OK";
  const normalizedSourceCount = safeSourceCount(artifacts) +
    safeSourceCount(next.value.finalProviderResponsePreview);
  const passed = searchEnabled ? normalizedSourceCount > 0 : finalOutputMatched;

  console.log(
    JSON.stringify(
      {
        finalOutputMatched,
        normalizedSourceCount,
        providerResponseIdPresent: Boolean(next.value.providerResponseId),
        searchEnabled,
        status: passed ? "passed" : "failed",
        usage: next.value.usage
      },
      null,
      2
    )
  );
  if (!passed) process.exitCode = 1;
}

main().catch(() => {
  console.error("OpenAI Responses smoke failed.");
  process.exit(1);
});
