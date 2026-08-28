import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import type { ValidatedSearchQuery } from "../lib/domain/search";
import { createAdminProviderCredentialTester } from
  "../lib/server/admin/providers/credentialTester";
import {
  createDeepSeekResponsesAdapter,
  createFetchDeepSeekResponsesClient
} from "../lib/server/providers/deepSeekResponses";
import { createDeepSeekResponsesSearchAdapter } from
  "../lib/server/providers/deepSeekResponsesSearch";
import { DeepSeekHttpError } from "../lib/server/providers/deepSeekResponsesTransport";
import { createProviderSafeFetch } from "../lib/server/providers/providerSafeFetch";
import {
  createDeepSeekResponsesStructuredOutputAdapter
} from "../lib/server/providers/structuredOutput";
import type {
  ProviderAdapter,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderRunResult
} from "../lib/server/providers/types";
import { runProviderToolLoop } from "../lib/server/runs/providerToolLoop";
import { deepSeekResponsesToolBridge } from "../lib/server/tools/bridges";

const officialModels = Object.freeze([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp"
] as const);

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
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

loadLocalEnv();

const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.log("DeepSeek smoke skipped: DEEPSEEK_API_KEY is not configured.");
  process.exit(0);
}

const connection = Object.freeze({
  allowPrivateNetwork: false,
  apiRoot: "https://api.deepseek.com",
  authenticationMode: "bearer" as const,
  responseTimeoutMs: 120_000
});
const capabilities: ProviderModelCapabilities = Object.freeze({
  nativePdfInput: false,
  nativeSearch: true,
  parallelToolCalls: true,
  pdf: true,
  reasoning: true,
  reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  streaming: true,
  toolCalling: true,
  vision: false
});

function request(input: Readonly<{
  attachment?: Readonly<{
    byteSize: number;
    dataUrl: string;
  }>;
  maxOutputTokens?: number;
  modelId: string;
  stream?: boolean;
  text: string;
}>): ProviderRunRequest {
  const attachment = input.attachment;
  return {
    attachmentIds: attachment ? ["smoke-image"] : [],
    attachments: attachment ? [{
      byteSize: attachment.byteSize,
      dataUrl: attachment.dataUrl,
      extractedText: null,
      fileName: "smoke.png",
      id: "smoke-image",
      kind: "image",
      metadata: { image: { detail: "low" } },
      mimeType: "image/png",
      status: "ready"
    }] : [],
    chatId: "deepseek-smoke",
    content: { blocks: [{ text: input.text, type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: {
      ...capabilities,
      vision: Boolean(attachment)
    },
    modelId: input.modelId,
    params: {
      maxOutputTokens: input.maxOutputTokens ?? 128,
      reasoning: { effort: "none" },
      stream: input.stream ?? false,
      temperature: 0
    },
    prompt: {
      developer: null,
      system: "This is a bounded AIQSA DeepSeek adapter verification. Follow the exact marker request."
    },
    provider: "deepseek",
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto"
  };
}

async function complete(
  adapter: ProviderAdapter,
  input: ProviderRunRequest
): Promise<ProviderRunResult> {
  const stream = adapter.stream(input, { timeoutMs: connection.responseTimeoutMs });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

function tokenCount(result: ProviderRunResult): number {
  return result.usage.totalTokens ?? result.usage.inputTokens + result.usage.outputTokens;
}

function safeFailureCode(error: unknown): string {
  if (error instanceof DeepSeekHttpError) return `deepseek_http_${error.status}`;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(code)) return code;
  }
  const message = error instanceof Error ? error.message : "";
  return /^(?:deepseek|provider|search|structured_output|tool_loop)_[a-z0-9_]{1,127}$/u
    .test(message)
    ? message
    : "deepseek_smoke_failed";
}

async function main(): Promise<void> {
  let stage = "catalog";
  let aggregateTokens = 0;
  const checks: Record<string, boolean> = {};
  try {
    const catalog = await createAdminProviderCredentialTester().test({
      connection,
      family: "deepseek",
      secret: apiKey
    });
    const observedModels = [...catalog.modelIds].sort();
    checks.catalog = observedModels.length === officialModels.length &&
      officialModels.every((modelId) => observedModels.includes(modelId));
    if (!checks.catalog) throw new Error("deepseek_smoke_catalog_mismatch");

    const client = createFetchDeepSeekResponsesClient({
      apiKey,
      apiRoot: connection.apiRoot,
      defaultTimeoutMs: connection.responseTimeoutMs,
      fetchFn: createProviderSafeFetch({ configuration: connection })
    });
    const adapter = createDeepSeekResponsesAdapter({ client });

    stage = "stream";
    const streamed = await complete(adapter, request({
      modelId: "deepseek-v4-flash",
      stream: true,
      text: "Reply exactly AIQSA_STREAM_OK."
    }));
    aggregateTokens += tokenCount(streamed);
    checks.stream = streamed.finalText.trim() === "AIQSA_STREAM_OK";
    if (!checks.stream) throw new Error("deepseek_smoke_stream_mismatch");

    stage = "structured_output";
    const structured = await createDeepSeekResponsesStructuredOutputAdapter({
      client,
      model: {
        adapterKind: "deepseek_responses_native",
        upstreamModelId: "deepseek-v4-pro"
      }
    }).execute({
      maxOutputTokens: 128,
      name: "aiqsa_deepseek_smoke",
      reasoningEffort: "none",
      schema: {
        additionalProperties: false,
        properties: { ready: { const: true, type: "boolean" } },
        required: ["ready"],
        type: "object"
      },
      systemPrompt: "Return only the object required by the supplied JSON Schema.",
      userPrompt: "Set ready to true."
    }, { timeoutMs: connection.responseTimeoutMs });
    checks.structuredOutput = structured.ready === true && Object.keys(structured).length === 1;
    if (!checks.structuredOutput) throw new Error("deepseek_smoke_structured_output_mismatch");

    stage = "tool_loop";
    let toolExecutions = 0;
    let toolArgumentsMatched = false;
    const tool = {
      capability: "mcp" as const,
      description: "Return the fixed AIQSA DeepSeek smoke marker.",
      inputSchema: {
        additionalProperties: false,
        properties: { marker: { const: "AIQSA_TOOL_OK", type: "string" } },
        required: ["marker"],
        type: "object"
      },
      name: "aiqsa_deepseek_smoke_marker",
      strict: true
    };
    const toolRequest = {
      ...request({
        maxOutputTokens: 256,
        modelId: "deepseek-v4-pro",
        text: "Call aiqsa_deepseek_smoke_marker once with marker AIQSA_TOOL_OK, then reply exactly AIQSA_TOOL_OK."
      }),
      toolChoice: "required" as const,
      tools: [tool]
    };
    const toolOutcome = await runProviderToolLoop({
      adapter,
      bridge: deepSeekResponsesToolBridge,
      budgets: {
        maxConcurrency: 1,
        maxToolCalls: 1,
        maxToolRounds: 1,
        providerRoundTimeoutMs: connection.responseTimeoutMs,
        toolCallTimeoutMs: 5_000
      },
      async executeTool(call) {
        toolExecutions += 1;
        toolArgumentsMatched = call.name === tool.name &&
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
      initialRequest: toolRequest,
      parallelToolCalls: false,
      tools: [tool]
    });
    checks.toolLoop = toolOutcome.status === "complete" &&
      toolExecutions === 1 && toolArgumentsMatched &&
      toolOutcome.final.finalText.trim() === "AIQSA_TOOL_OK";
    if (toolOutcome.status === "complete") aggregateTokens += tokenCount(toolOutcome.final);
    if (!checks.toolLoop) throw new Error("deepseek_smoke_tool_loop_mismatch");

    stage = "vision";
    const image = await sharp({
      create: {
        background: { alpha: 1, b: 0, g: 0, r: 255 },
        channels: 4,
        height: 64,
        width: 64
      }
    }).png().toBuffer();
    const vision = await complete(adapter, request({
      attachment: {
        byteSize: image.byteLength,
        dataUrl: `data:image/png;base64,${image.toString("base64")}`
      },
      modelId: "deepseek-v4-flash-vision-exp",
      text: "This is a solid-color image. If the image is red, reply exactly AIQSA_VISION_OK."
    }));
    aggregateTokens += tokenCount(vision);
    checks.vision = vision.finalText.trim() === "AIQSA_VISION_OK";
    if (!checks.vision) throw new Error("deepseek_smoke_vision_mismatch");

    stage = "search";
    const search = await createDeepSeekResponsesSearchAdapter({ client }).search({
      correlationId: "deepseek-smoke-search",
      query: "What is the title of the DeepSeek API documentation home page?" as ValidatedSearchQuery,
      searchPolicy: {
        maxOutputTokens: 1_024,
        modelCapabilities: capabilities,
        modelId: "deepseek-v4-pro",
        provider: "deepseek",
        reasoningPolicy: "lowest_supported",
        strategyId: "deepseek-responses-web-search"
      },
      strategyId: "deepseek-smoke-search"
    }, { timeoutMs: connection.responseTimeoutMs });
    checks.search = search.findings.length > 0 &&
      search.sourceAttribution === "provider_unavailable" &&
      search.sources.length === 0;
    aggregateTokens += search.usage.totalTokens ??
      search.usage.inputTokens + search.usage.outputTokens;
    if (!checks.search) throw new Error("deepseek_smoke_search_mismatch");

    console.log(JSON.stringify({
      aggregateTokens,
      checks,
      officialModelCount: observedModels.length,
      sourceUrlsAvailable: false,
      status: "passed"
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      failureCode: safeFailureCode(error),
      stage,
      status: "failed"
    }, null, 2));
    process.exitCode = 1;
  }
}

void main();
