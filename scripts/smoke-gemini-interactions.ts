import { existsSync, readFileSync } from "node:fs";
import {
  buildGeminiInteractionsRequest,
  createFetchGeminiInteractionsClient
} from "../lib/server/providers/geminiInteractions";
import { extractGeminiInteractionsUsage } from "../lib/server/providers/geminiInteractionsResponse";
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

const apiRoot = "https://generativelanguage.googleapis.com/v1";
const modelId = process.env.AIQSA_GEMINI_SMOKE_MODEL || "gemini-3.6-flash";
const searchEnabled = process.env.AIQSA_GEMINI_SMOKE_SEARCH === "1";
const attachmentContextEnabled =
  process.env.AIQSA_GEMINI_SMOKE_ATTACHMENT_CONTEXT === "1";
const maxOutputTokens = searchEnabled ? 4_096 : attachmentContextEnabled ? 8 : 64;
const connection = {
  allowPrivateNetwork: false,
  apiRoot,
  authenticationMode: "bearer" as const,
  responseTimeoutMs: 300_000
};
const modelCapabilities = {
  nativePdfInput: false,
  nativeSearch: true,
  parallelToolCalls: false,
  pdf: true,
  reasoning: true,
  streaming: true,
  toolCalling: true,
  vision: true
};
const defaultParams = {
  maxTokens: maxOutputTokens,
  reasoning: { effort: searchEnabled ? "medium" : "minimal" },
  stream: !attachmentContextEnabled
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
      text: searchEnabled
        ? "Find one current news headline from Spain today and answer in one short sentence."
        : attachmentContextEnabled
          ? "Reply with one short word."
        : "Call aiqsa_smoke_marker exactly once. After its result, reply exactly AIQSA_TOOL_OK.",
      type: "text"
    }]
  },
  ...(attachmentContextEnabled
    ? {
        context: {
          messages: [
            {
              content: { blocks: [{ attachmentId: "smoke-prior-image", type: "image" }] },
              id: "prior-attachment-only",
              role: "user"
            },
            {
              content: { blocks: [{ text: "Acknowledged.", type: "text" }] },
              id: "prior-assistant",
              role: "assistant"
            },
            {
              content: { blocks: [{ text: "Reply with one short word.", type: "text" }] },
              id: "current-user",
              role: "user"
            }
          ],
          mode: "branch_path" as const
        },
        forceNonStreaming: true
      }
    : {}),
  knowledgePlan: { baseIds: [] },
  toolMode: "auto",
  modelCapabilities,
  modelId,
  params: defaultParams,
  prompt: {
    developer: null,
    system: searchEnabled
      ? "This is a bounded AIQSA Google Search smoke test. Use Google Search before answering."
      : attachmentContextEnabled
        ? "This is a bounded AIQSA request-shape smoke test."
      : [
          "This is a tiny deterministic AIQSA provider tool-loop smoke test.",
          "On the first round, call aiqsa_smoke_marker exactly once with marker AIQSA_TOOL_OK.",
          "Do not answer before the tool result. After the result, reply exactly AIQSA_TOOL_OK."
        ].join(" ")
  },
  provider: "gemini",
  searchPlan: {
    mode: "all_selected",
    options: searchEnabled ? [{
      adapterKind: "answer_provider_hosted",
      config: {},
      credentialMode: "answer_provider",
      displayName: "Google Search",
      executionModes: ["all_selected"],
      modelId: null,
      optionId: "gemini-google-search",
      protocol: "gemini_google_search",
      provider: "gemini",
      providerModelId: null,
      revisionId: "smoke-gemini-search",
      searchStrategyRowId: "smoke-gemini-search"
    }] : []
  },
  tools: searchEnabled || attachmentContextEnabled ? [] : [smokeTool]
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerSignature(value: unknown): string | null {
  const steps = Array.isArray(value) ? value : [value];
  for (const step of steps) {
    if (
      !isRecord(step) ||
      (step.type !== "thought" && step.type !== "function_call")
    ) continue;
    if (typeof step.signature === "string" && step.signature) return step.signature;
  }
  return null;
}

function httpStatusFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : "";
  const match = /Gemini request failed with status (\d{3})$/u.exec(message);
  return match ? Number(match[1]) : null;
}

async function runAttachmentContextProbe(): Promise<void> {
  const body = buildGeminiInteractionsRequest(request);
  const input = Array.isArray(body.input) ? body.input : [];
  const firstStep = isRecord(input[0]) ? input[0] : {};
  const firstContent = Array.isArray(firstStep.content) ? firstStep.content : [];
  const firstPart = isRecord(firstContent[0]) ? firstContent[0] : {};
  const emptyTextPartPresent = input.some((step) => {
    if (!isRecord(step) || !Array.isArray(step.content)) return false;
    return step.content.some((part) =>
      isRecord(part) && part.type === "text" &&
      typeof part.text === "string" && !part.text.trim());
  });
  const priorAttachmentMarkerPresent = firstStep.type === "user_input" &&
    firstPart.type === "text" && firstPart.text === "[image attachment]";

  if (emptyTextPartPresent || !priorAttachmentMarkerPresent) {
    console.error(JSON.stringify({
      emptyTextPartPresent,
      priorAttachmentMarkerPresent,
      status: "failed"
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  let observedHttpStatus: number | null = null;
  const safeFetch = createProviderSafeFetch({ configuration: connection });
  const observingFetch: typeof fetch = async (...args) => {
    const response = await safeFetch(...args);
    observedHttpStatus = response.status;
    return response;
  };
  const client = createFetchGeminiInteractionsClient({
    apiKey,
    apiRoot,
    fetchFn: observingFetch
  });

  try {
    const response = await client.createInteraction(body, { timeoutMs: 30_000 });
    const usage = extractGeminiInteractionsUsage(response.usage);
    const responseStepCount = Array.isArray(response.steps) ? response.steps.length : 0;
    const passed = observedHttpStatus === 200 && response.status === "completed" &&
      responseStepCount > 0 && (usage.totalTokens ?? 0) > 0;
    console.log(JSON.stringify({
      emptyTextPartPresent,
      priorAttachmentMarkerPresent,
      httpStatus: observedHttpStatus,
      inputStepCount: input.length,
      providerAccepted: true,
      responseStepCount,
      status: passed ? "passed" : "failed",
      terminalCompleted: response.status === "completed",
      usage
    }, null, 2));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    const httpStatus = observedHttpStatus ?? httpStatusFromError(error);
    console.log(JSON.stringify({
      emptyTextPartPresent,
      priorAttachmentMarkerPresent,
      httpStatus,
      inputStepCount: input.length,
      providerAccepted: false,
      status: "failed",
      usage: extractGeminiInteractionsUsage(undefined)
    }, null, 2));
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (searchEnabled && attachmentContextEnabled) {
    throw new Error("gemini_smoke_modes_conflict");
  }
  if (attachmentContextEnabled) {
    await runAttachmentContextProbe();
    return;
  }

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
        adapterKind: "gemini_interactions_native",
        answerSelectable: true,
        capabilities: modelCapabilities,
        defaultParams,
        modelClass: "answer",
        upstreamModelId: modelId
      },
      modelDisplayName: modelId,
      providerFamily: "gemini",
      providerModelId: "gemini-smoke-model",
      version: 1
    }
  });

  if (searchEnabled) {
    const stream = runtime.adapter.stream(request);
    let groundingDisplayEvents = 0;
    let searchCallCount = 0;
    let suggestionsPresent = false;
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "grounding_display") {
        groundingDisplayEvents += 1;
        searchCallCount = Math.max(searchCallCount, next.value.data.runSearch.callCount);
        suggestionsPresent ||= next.value.data.suggestionsHtml.length > 0;
      }
      next = await stream.next();
    }
    const finalOutputPresent = next.value.finalText.trim().length > 0;
    const preview = isRecord(next.value.finalProviderResponsePreview)
      ? next.value.finalProviderResponsePreview
      : {};
    const stepTypes = new Set(Array.isArray(preview.steps)
      ? preview.steps.flatMap((step) => isRecord(step) && typeof step.type === "string"
        ? [step.type]
        : [])
      : []);
    const passed = finalOutputPresent && searchCallCount > 0 && suggestionsPresent;
    console.log(JSON.stringify({
      finalOutputPresent,
      groundingDisplayEvents,
      providerResponseIdPresent: Boolean(next.value.providerResponseId),
      searchCallCount,
      searchEnabled,
      googleSearchCallStepPresent: stepTypes.has("google_search_call"),
      googleSearchResultStepPresent: stepTypes.has("google_search_result"),
      modelOutputStepPresent: stepTypes.has("model_output"),
      status: passed ? "passed" : "failed",
      suggestionsPresent,
      thoughtStepPresent: stepTypes.has("thought"),
      toolCallCount: next.value.toolCalls?.length ?? 0,
      usage: next.value.usage
    }, null, 2));
    if (!passed) process.exitCode = 1;
    return;
  }

  if (!runtime.toolBridge) throw new Error("gemini_smoke_tool_bridge_missing");

  let firstRoundSignature: string | null = null;
  let signatureRoundTrip = false;
  let toolArgumentsMatched = false;
  let toolExecutions = 0;
  const outcome = await runProviderToolLoop({
    adapter: runtime.adapter,
    beforeProviderRound({ request: roundRequest, round }) {
      if (round > 1 && firstRoundSignature) {
        signatureRoundTrip = providerSignature(roundRequest.providerToolMessages) ===
          firstRoundSignature;
      }
    },
    bridge: runtime.toolBridge,
    budgets: {
      maxConcurrency: 1,
      maxToolCalls: 1,
      maxToolRounds: 2,
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
        firstRoundSignature = providerSignature(result.providerToolCallMessage);
      }
    },
    parallelToolCalls: false,
    tools: [smokeTool]
  });

  const finalOutputMatched = outcome.status === "complete" &&
    outcome.final.finalText.trim() === "AIQSA_TOOL_OK";
  const signatureRoundTripSatisfied = !firstRoundSignature || signatureRoundTrip;
  const passed = outcome.status === "complete" && toolExecutions === 1 &&
    toolArgumentsMatched && signatureRoundTripSatisfied &&
    finalOutputMatched;

  const failureCode = outcome.status === "failed" && /^gemini_[a-z_]+$/u.test(outcome.failure.message)
    ? outcome.failure.message
    : outcome.status === "failed"
      ? outcome.failure.code
      : null;
  console.log(JSON.stringify({
    failureCode,
    failureStage: outcome.status === "failed" ? outcome.failure.stage : null,
    finalOutputMatched,
    providerResponseIdPresent: outcome.status === "complete" &&
      Boolean(outcome.final.providerResponseId),
    signaturePresent: Boolean(firstRoundSignature),
    signatureRoundTrip,
    status: passed ? "passed" : "failed",
    toolArgumentsMatched,
    toolExecutions,
    providerRounds: outcome.providerRounds
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "";
  const failureCode = /^(?:gemini|provider)_[a-z0-9_]+$/u.test(message)
    ? message
    : "gemini_smoke_failed";
  console.error(JSON.stringify({ failureCode, status: "failed" }, null, 2));
  process.exit(1);
});
