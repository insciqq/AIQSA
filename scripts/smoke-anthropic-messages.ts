import { existsSync, readFileSync } from "node:fs";
import {
  buildAnthropicMessagesRequest,
  createFetchAnthropicMessagesClient
} from "../lib/server/providers/anthropicMessages";
import { createProviderSafeFetch } from "../lib/server/providers/providerSafeFetch";
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

function loadLocalEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/u)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function usageFromResponse(response: Record<string, unknown> | null): Record<string, number> {
  const usage = isRecord(response?.usage) ? response.usage : {};
  const cacheWriteInputTokens = tokenCount(usage.cache_creation_input_tokens);
  const cachedInputTokens = tokenCount(usage.cache_read_input_tokens);
  const uncachedInputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  return {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens: uncachedInputTokens + cacheWriteInputTokens + cachedInputTokens,
    outputTokens,
    totalTokens: uncachedInputTokens + cacheWriteInputTokens + cachedInputTokens + outputTokens
  };
}

loadLocalEnv();

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
if (!apiKey) {
  console.log("Anthropic smoke skipped: ANTHROPIC_API_KEY is not configured.");
  process.exit(0);
}

const apiRoot = "https://api.anthropic.com/v1";
const modelId = process.env.AIQSA_ANTHROPIC_SMOKE_MODEL || "claude-sonnet-5";
let observedHttpStatus: number | null = null;
const safeFetch = createProviderSafeFetch({
  configuration: {
    allowPrivateNetwork: false,
    apiRoot,
    authenticationMode: "bearer",
    responseTimeoutMs: 300_000
  }
});
const observingFetch: typeof fetch = async (...args) => {
  const response = await safeFetch(...args);
  observedHttpStatus = response.status;
  return response;
};
const client = createFetchAnthropicMessagesClient({
  apiKey,
  baseUrl: apiRoot,
  fetchFn: observingFetch
});

type ProbeResult = Readonly<{
  accepted: boolean;
  contentBlockCount: number;
  httpStatus: number | null;
  stopReasonPresent: boolean;
  usage: Record<string, number>;
}>;

async function probeBody(body: Record<string, unknown>): Promise<ProbeResult> {
  observedHttpStatus = null;
  try {
    const response = await client.createMessage(body, { timeoutMs: 30_000 });
    return {
      accepted: true,
      contentBlockCount: Array.isArray(response.content) ? response.content.length : 0,
      httpStatus: observedHttpStatus,
      stopReasonPresent: typeof response.stop_reason === "string",
      usage: usageFromResponse(response)
    };
  } catch {
    return {
      accepted: false,
      contentBlockCount: 0,
      httpStatus: observedHttpStatus,
      stopReasonPresent: false,
      usage: usageFromResponse(null)
    };
  }
}

function directBody(text: string): Record<string, unknown> {
  return {
    max_tokens: 8,
    messages: [{ content: [{ text, type: "text" }], role: "user" }],
    model: modelId,
    stream: false
  };
}

function priorAttachmentRequest(): ProviderRunRequest {
  const currentContent = { blocks: [{ text: "Reply with one short word.", type: "text" }] };
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "anthropic-smoke-prior-attachment",
    content: currentContent,
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
        { content: currentContent, id: "current-user", role: "user" }
      ],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: true,
      nativeSearch: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    modelId,
    params: {
      maxOutputTokens: 8,
      outputConfig: { effort: "high" },
      stream: true,
      thinking: { enabled: false, type: "adaptive" }
    },
    prompt: {
      developer: null,
      system: "This is a bounded AIQSA request-shape smoke test."
    },
    provider: "anthropic",
    searchPlan: { mode: "all_selected", options: [] }
  };
}

async function main(): Promise<void> {
  const control = await probeBody(directBody("Reply with one short word."));
  const emptyText = await probeBody(directBody(""));
  const priorAttachmentBody = buildAnthropicMessagesRequest(priorAttachmentRequest());
  const priorAttachmentMessages = Array.isArray(priorAttachmentBody.messages)
    ? priorAttachmentBody.messages
    : [];
  const priorFirstMessage = isRecord(priorAttachmentMessages[0])
    ? priorAttachmentMessages[0]
    : {};
  const priorFirstContent = Array.isArray(priorFirstMessage.content)
    ? priorFirstMessage.content
    : [];
  const priorFirstBlock = isRecord(priorFirstContent[0])
    ? priorFirstContent[0]
    : {};
  const priorAttachmentMarkerPresent = priorFirstBlock.type === "text" &&
    priorFirstBlock.text === "[image attachment]";
  const priorAttachment = await probeBody({ ...priorAttachmentBody, stream: false });
  const emptyObservationValid = emptyText.accepted || emptyText.httpStatus === 400;
  const passed = control.accepted && control.httpStatus === 200 &&
    emptyObservationValid && priorAttachmentMarkerPresent &&
    priorAttachment.accepted && priorAttachment.httpStatus === 200;

  console.log(JSON.stringify({
    controlAccepted: control.accepted,
    controlContentBlockCount: control.contentBlockCount,
    controlHttpStatus: control.httpStatus,
    controlStopReasonPresent: control.stopReasonPresent,
    controlUsage: control.usage,
    emptyTextAccepted: emptyText.accepted,
    emptyTextHttpStatus: emptyText.httpStatus,
    emptyTextRejected: emptyText.httpStatus === 400,
    priorAttachmentAccepted: priorAttachment.accepted,
    priorAttachmentHttpStatus: priorAttachment.httpStatus,
    priorAttachmentMarkerPresent,
    priorAttachmentUsage: priorAttachment.usage,
    status: passed ? "passed" : "failed"
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(() => {
  console.error(JSON.stringify({ failureCode: "anthropic_smoke_failed", status: "failed" }));
  process.exit(1);
});
