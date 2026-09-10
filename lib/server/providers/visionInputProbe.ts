import sharp from "sharp";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import type { ProviderRunRequest, ProviderRunResult } from "./types";
import { declaredModelOutputTokenLimit, lowestConfiguredReasoningEffort } from "./providerModelCapabilities";
import { receiptProbeRaster, RECEIPT_PROBE_ANSWER as VISION_INPUT_PROBE_ANSWER,
  RECEIPT_PROBE_WIDTH, RECEIPT_PROBE_HEIGHT } from "./receiptProbeFixture";

export { VISION_INPUT_PROBE_ANSWER };

const VISION_INPUT_PROBE_MAX_OUTPUT_TOKENS = 512;

const VISION_INPUT_PROBE_PROMPT = [
  "Read the attached image.",
  "Which item on the receipt has a quantity of 7? Return only the item name in uppercase.",
  "Return no explanation, punctuation, Markdown, or additional text."
].join("\n");

let fixturePromise: Promise<Buffer> | null = null;

function fixture(): Promise<Buffer> {
  fixturePromise ??= Promise.resolve().then(() =>
    sharp(Buffer.from(receiptProbeRaster()), { raw: { width: RECEIPT_PROBE_WIDTH, height: RECEIPT_PROBE_HEIGHT, channels: 1 } })
      .png({ compressionLevel: 9 }).toBuffer()
  ).catch(() => {
    // A process-local rendering failure must be retryable and must not become
    // negative provider evidence. Do not retain or disclose the raw exception.
    fixturePromise = null;
    throw new Error("vision_input_fixture_unavailable");
  });
  return fixturePromise;
}

function request(snapshot: ProviderExecutionSnapshot, image: Buffer, requestedTokens = VISION_INPUT_PROBE_MAX_OUTPUT_TOKENS): ProviderRunRequest {
  const maxOutputTokens = Math.min(requestedTokens, declaredModelOutputTokenLimit(snapshot.model, snapshot.providerFamily) ?? requestedTokens);
  const responsesAdapter = snapshot.model.adapterKind === "openai_responses_native" ||
    snapshot.model.adapterKind === "openai_responses_compatible" ||
    snapshot.model.adapterKind === "deepseek_responses_native";
  return {
    attachmentIds: ["vision-input-probe"],
    attachments: [{
      byteSize: image.byteLength,
      dataUrl: `data:image/png;base64,${image.toString("base64")}`,
      extractedText: null,
      fileName: "vision-input-probe.png",
      id: "vision-input-probe",
      kind: "image",
      metadata: { image: { height: RECEIPT_PROBE_HEIGHT, width: RECEIPT_PROBE_WIDTH } },
      mimeType: "image/png",
      status: "ready"
    }],
    chatId: "provider-vision-input-probe",
    content: { blocks: [{ text: VISION_INPUT_PROBE_PROMPT, type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { ...snapshot.model.capabilities, vision: true },
    modelId: snapshot.model.upstreamModelId,
    params: {
      ...snapshot.model.defaultParams,
      background: false,
      maxOutputTokens,
      maxTokens: maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      ...(responsesAdapter ? { reasoning: { effort: lowestConfiguredReasoningEffort(snapshot.model, snapshot.providerFamily), summary: "none" } } : {}),
      store: false,
      stream: false
    },
    prompt: { developer: null, system: null },
    provider: snapshot.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
}

export function createProviderVisionInputProbe(input: Readonly<{
  execute(
    snapshot: ProviderExecutionSnapshot,
    request: ProviderRunRequest,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>
  ): Promise<ProviderRunResult>;
}>) {
  return {
    async probe(snapshot: ProviderExecutionSnapshot, signal?: AbortSignal, maxOutputTokens?: number): Promise<boolean> {
      if (snapshot.model.adapterKind === "fake" || snapshot.model.modelClass !== "answer" ||
        snapshot.model.capabilities.vision !== true) {
        return false;
      }
      const image = await fixture();
      const deadline = AbortSignal.timeout(120_000);
      const result = await input.execute(snapshot, request(snapshot, image, maxOutputTokens), {
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        timeoutMs: 120_000
      });
      const finish = result.finalProviderResponsePreview?.finishReason;
      if (finish === "length" || finish === "content_filter") throw Object.assign(new Error("vision_input_probe_inconclusive"), {
        capabilityFailureReason: finish === "length" ? "budget_exhausted" : "refusal"
      });
      return result.finalText.trim() === VISION_INPUT_PROBE_ANSWER;
    }
  };
}
