import { existsSync, readFileSync } from "node:fs";
import { createProviderSafeFetch } from "../lib/server/providers/providerSafeFetch";
import { createProviderRuntimeBinding } from "../lib/server/providers/runtimeFactory";
import type { ProviderRunRequest } from "../lib/server/providers/types";
import { runProviderToolLoop } from "../lib/server/runs/providerToolLoop";

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

function loadLocalEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!process.env[key]) {
      process.env[key] = unquoteEnvValue(trimmed.slice(separatorIndex + 1));
    }
  }
}

loadLocalEnv();

const apiKey = process.env.GEMINI_API_KEY ?? "";
if (!apiKey) {
  console.log("Gemini smoke skipped: GEMINI_API_KEY is not configured.");
  process.exit(0);
}

const apiRoot = "https://generativelanguage.googleapis.com/v1beta/openai";
const modelId = process.env.AIQSA_GEMINI_SMOKE_MODEL || "gemini-3.6-flash";
const maxOutputTokens = 64;
const connection = {
  allowPrivateNetwork: false,
  apiRoot
};
const modelCapabilities = {
  nativePdfInput: false,
  nativeSearch: false,
  parallelToolCalls: false,
  pdf: true,
  reasoning: true,
  streaming: true,
  toolCalling: true,
  vision: true
};
const defaultParams = {
  maxTokens: maxOutputTokens,
  reasoning: { effort: "minimal" },
  stream: true
};
const smokeTool = {
  capability: "mcp" as const,
  description: "Return the fixed AIQSA tool-loop smoke marker.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      marker: { enum: ["AIQSA_TOOL_OK"], type: "string" }
    },
    required: ["marker"],
    type: "object"
  },
  name: "aiqsa_smoke_marker",
  strict: false
};

const request: ProviderRunRequest = {
  attachmentIds: [],
  attachments: [],
  chatId: "smoke-chat",
  content: {
    blocks: [{
      text: "Call aiqsa_smoke_marker exactly once. After its result, reply exactly AIQSA_TOOL_OK.",
      type: "text"
    }]
  },
  modelCapabilities,
  modelId,
  params: defaultParams,
  prompt: {
    developer: null,
    presetId: null,
    system: [
      "This is a tiny deterministic AIQSA provider tool-loop smoke test.",
      "On the first round, call aiqsa_smoke_marker exactly once with marker AIQSA_TOOL_OK.",
      "Do not answer before the tool result. After the result, reply exactly AIQSA_TOOL_OK."
    ].join(" ")
  },
  provider: "gemini",
  searchStrategy: "search-disabled",
  tools: [smokeTool]
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function thoughtSignature(value: unknown): string | null {
  const messages = Array.isArray(value) ? value : [value];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.extra_content) ||
        !isRecord(call.extra_content.google)) {
        continue;
      }
      const signature = call.extra_content.google.thought_signature;
      if (typeof signature === "string" && signature) return signature;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const runtime = createProviderRuntimeBinding({
    options: {
      allowFake: false,
      fetchFn: createProviderSafeFetch({ configuration: connection })
    },
    secret: apiKey,
    snapshot: {
      connection,
      connectionDisplayName: "Gemini smoke",
      connectionId: "gemini-smoke-connection",
      credentialId: "gemini-smoke-credential",
      credentialVersionId: "gemini-smoke-credential-version",
      model: {
        adapterKind: "openai_chat_completions_compatible",
        capabilities: modelCapabilities,
        defaultParams,
        upstreamModelId: modelId
      },
      modelDisplayName: modelId,
      providerFamily: "gemini",
      providerModelId: "gemini-smoke-model",
      version: 1
    }
  });
  if (!runtime.toolBridge) throw new Error("gemini_smoke_tool_bridge_missing");

  let firstRoundSignature: string | null = null;
  let signatureRoundTrip = false;
  let toolArgumentsMatched = false;
  let toolExecutions = 0;
  const outcome = await runProviderToolLoop({
    adapter: runtime.adapter,
    beforeProviderRound({ request: roundRequest, round }) {
      if (round > 1 && firstRoundSignature) {
        signatureRoundTrip = thoughtSignature(roundRequest.providerToolMessages) ===
          firstRoundSignature;
      }
    },
    bridge: runtime.toolBridge,
    budgets: {
      maxConcurrency: 1,
      maxToolCalls: 1,
      maxToolRounds: 1,
      providerRoundTimeoutMs: 30_000,
      toolCallTimeoutMs: 5_000
    },
    async executeTool(call) {
      toolExecutions += 1;
      toolArgumentsMatched = call.name === smokeTool.name &&
        call.arguments.marker === "AIQSA_TOOL_OK";
      return {
        status: "complete",
        value: {
          callId: call.id,
          content: [{ text: "AIQSA_TOOL_OK", type: "text" }],
          name: call.name,
          status: "complete"
        }
      };
    },
    initialRequest: request,
    onProviderResult({ result, round }) {
      if (round === 1) {
        firstRoundSignature = thoughtSignature(result.providerToolCallMessage);
      }
    },
    parallelToolCalls: false,
    tools: [smokeTool]
  });

  const finalOutputMatched = outcome.status === "complete" &&
    outcome.final.finalText.trim() === "AIQSA_TOOL_OK";
  const passed = outcome.status === "complete" && toolExecutions === 1 &&
    toolArgumentsMatched && Boolean(firstRoundSignature) && signatureRoundTrip &&
    finalOutputMatched;

  console.log(JSON.stringify({
    finalOutputMatched,
    providerResponseIdPresent: outcome.status === "complete" &&
      Boolean(outcome.final.providerResponseId),
    signaturePresent: Boolean(firstRoundSignature),
    signatureRoundTrip,
    status: passed ? "passed" : "failed",
    toolArgumentsMatched,
    toolExecutions
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(() => {
  console.error("Gemini tool-loop smoke failed.");
  process.exit(1);
});
