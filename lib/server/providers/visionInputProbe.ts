import sharp from "sharp";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

export const VISION_INPUT_PROBE_CODE = "V4K8M2";

const VISION_INPUT_PROBE_MAX_OUTPUT_TOKENS = 512;

const VISION_INPUT_PROBE_PROMPT = [
  "Read the attached image.",
  "Return exactly the code shown in the bottom-right table cell.",
  "Return no explanation, punctuation, Markdown, or additional text."
].join("\n");

let fixturePromise: Promise<Buffer> | null = null;

function fixture(): Promise<Buffer> {
  fixturePromise ??= sharp(Buffer.from(`
    <svg width="640" height="240" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="240" fill="white" />
      <path d="M20 20H620V220H20ZM20 120H620M300 20V220" fill="none" stroke="black" stroke-width="4" />
      <text x="70" y="83" font-family="sans-serif" font-size="38" fill="black">ALPHA</text>
      <text x="390" y="83" font-family="sans-serif" font-size="38" fill="black">17</text>
      <text x="75" y="184" font-family="sans-serif" font-size="38" fill="black">BETA</text>
      <text x="345" y="184" font-family="monospace" font-size="42" font-weight="bold" fill="black">${VISION_INPUT_PROBE_CODE}</text>
    </svg>
  `, "utf8")).png({ compressionLevel: 9 }).toBuffer();
  return fixturePromise;
}

function request(snapshot: ProviderExecutionSnapshot, image: Buffer): ProviderRunRequest {
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
      metadata: { image: { height: 240, width: 640 } },
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
      maxOutputTokens: VISION_INPUT_PROBE_MAX_OUTPUT_TOKENS,
      maxTokens: VISION_INPUT_PROBE_MAX_OUTPUT_TOKENS,
      max_output_tokens: VISION_INPUT_PROBE_MAX_OUTPUT_TOKENS,
      ...(responsesAdapter ? { reasoning: { effort: "none", summary: "none" } } : {}),
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
    async probe(snapshot: ProviderExecutionSnapshot, signal?: AbortSignal): Promise<boolean> {
      if (snapshot.model.adapterKind === "fake" || snapshot.model.modelClass !== "answer" ||
        snapshot.model.capabilities.vision !== true) {
        return false;
      }
      const image = await fixture();
      const deadline = AbortSignal.timeout(120_000);
      const result = await input.execute(snapshot, request(snapshot, image), {
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        timeoutMs: 120_000
      });
      return result.finalText.trim() === VISION_INPUT_PROBE_CODE;
    }
  };
}
