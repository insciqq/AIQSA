import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesRequest } from "./anthropicMessages";
import { buildCompatibleResponsesRequest } from "./compatibleResponses";
import { buildDeepSeekResponsesRequest, buildDeepSeekResponsesRequestPreview } from "./deepSeekResponsesRequest";
import { buildGeminiInteractionsRequest, buildGeminiInteractionsRequestPreview } from "./geminiInteractionsRequest";
import { buildOpenAICompatibleChatRequest, buildOpenAICompatibleChatRequestPreview } from "./openaiCompatibleChatRequest";
import { buildOpenAIResponsesRequest, buildOpenAIResponsesRequestPreview } from "./openaiResponsesRequest";
import { buildOpenRouterChatRequest, buildOpenRouterChatRequestPreview } from "./openRouterChatRequest";
import { animatedGifFrameNote, providerAttachmentBudgetTokens } from "./attachmentPayload";
import type { ProviderAttachment, ProviderImageProvenance, ProviderRunRequest } from "./types";

const HISTORY_PIXELS = Buffer.from("history-pixels").toString("base64");
const CURRENT_PIXELS = Buffer.from("current-pixels").toString("base64");
const HISTORY_CAPTION = "[Image image_id=\"h3\": from earlier message message_id=\"m3\", not a new upload]";
const CURRENT_CAPTION = "[Image image_id=\"c1\": attached to the current user message]";

function image(id: string, pixels: string, provenance?: ProviderImageProvenance): ProviderAttachment {
  return { id, kind: "image", status: "ready", byteSize: 14, fileName: `untrusted-${id}.png`, mimeType: "image/png", metadata: {},
    extractedText: null, base64Data: pixels, dataUrl: `data:image/png;base64,${pixels}`, ...(provenance ? { imageProvenance: provenance } : {}) };
}

function request(attachments: ProviderAttachment[], provider = "openai"): ProviderRunRequest {
  return {
    attachmentIds: ["c1"],
    attachments,
    chatId: "chat-1",
    content: { blocks: [{ type: "text", text: "What is on the latest screenshot?" }] },
    modelCapabilities: { vision: true, pdf: true, nativePdfInput: false, nativeSearch: false, reasoning: false },
    modelId: "vision-model",
    params: {},
    prompt: { developer: null, system: "Base system." },
    provider,
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto"
  };
}

const labelled = [image("h3", HISTORY_PIXELS, { role: "earlier_message", messageId: "m3" }), image("c1", CURRENT_PIXELS, { role: "current_message" })];
const plain = [image("c1", CURRENT_PIXELS)];

type Body = Record<string, unknown>;
const builders: Array<[string, (input: ProviderRunRequest) => Body, ((input: ProviderRunRequest) => Body) | null]> = [
  ["OpenAI Responses", (input) => buildOpenAIResponsesRequest(input) as unknown as Body, (input) => buildOpenAIResponsesRequestPreview(input).body as unknown as Body],
  ["compatible Responses", (input) => buildCompatibleResponsesRequest({ ...input, provider: "openai_compatible" }), null],
  ["DeepSeek Responses", (input) => buildDeepSeekResponsesRequest(input) as unknown as Body, (input) => buildDeepSeekResponsesRequestPreview(input).body as unknown as Body],
  ["Gemini Interactions", (input) => buildGeminiInteractionsRequest(input) as unknown as Body, (input) => buildGeminiInteractionsRequestPreview(input).body as unknown as Body],
  ["Anthropic Messages", (input) => buildAnthropicMessagesRequest(input), (input) => buildAnthropicMessagesRequest(input, { preview: true, redactFiles: true, redactImages: true })],
  ["OpenRouter chat", (input) => buildOpenRouterChatRequest(input) as unknown as Body, (input) => buildOpenRouterChatRequestPreview(input).body as unknown as Body],
  ["OpenAI-compatible chat", (input) => buildOpenAICompatibleChatRequest(input) as unknown as Body, (input) => buildOpenAICompatibleChatRequestPreview(input).body as unknown as Body]
];

/** Latest user turn as text strings and IMAGE markers carrying their pixels. */
function userParts(body: Body): string[] {
  const turns = (body.input ?? body.messages) as Array<Record<string, unknown>>;
  const content = turns.at(-1)!.content as Array<Record<string, unknown>>;
  return content.map((part) => {
    if (typeof part.text === "string") return part.text;
    const serialized = JSON.stringify(part);
    return serialized.includes(HISTORY_PIXELS) ? "IMAGE:history" : serialized.includes(CURRENT_PIXELS) ? "IMAGE:current" : "IMAGE:redacted";
  });
}

describe("conversation image captions", () => {
  it.each(builders)("%s puts the earlier image first and captions every image", (_name, build, preview) => {
    const parts = userParts(build(request(labelled)));
    expect(parts.slice(-4)).toEqual([HISTORY_CAPTION, "IMAGE:history", CURRENT_CAPTION, "IMAGE:current"]);
    expect(JSON.stringify(parts)).not.toContain("untrusted-");

    if (preview) {
      const redacted = preview(request(labelled));
      expect(userParts(redacted).slice(-4)).toEqual([HISTORY_CAPTION, "IMAGE:redacted", CURRENT_CAPTION, "IMAGE:redacted"]);
      expect(JSON.stringify(redacted)).not.toContain(HISTORY_PIXELS);
      expect(JSON.stringify(redacted)).not.toContain(CURRENT_PIXELS);
    }
  });

  it.each(builders)("%s leaves requests without earlier images uncaptioned", (_name, build, preview) => {
    for (const body of [build(request(plain)), ...(preview ? [preview(request(plain))] : [])]) {
      expect(JSON.stringify(body)).not.toContain("[Image image_id=");
      expect(userParts(body).at(-1)).toMatch(/^IMAGE:/);
    }
  });

  it.each(builders)("%s tells the model right before a still frame that it comes from an animated GIF", (_name, build, preview) => {
    const note = animatedGifFrameNote({ attachmentId: "c1", frames: 12, inboxIndexPath: "/workspace/inbox/index.json" });
    const still = { ...image("c1", CURRENT_PIXELS), imageNote: note };
    for (const body of [build(request([still])), ...(preview ? [preview(request([still]))] : [])]) {
      expect(userParts(body).slice(-2)).toEqual([note, expect.stringMatching(/^IMAGE:/u)]);
    }
    const history = { ...image("c1", CURRENT_PIXELS, { role: "current_message" }), imageNote: note };
    expect(userParts(build(request([history]))).slice(-2)).toEqual([`${CURRENT_CAPTION}\n${note}`, "IMAGE:current"]);
  });

  it("names the frames, the Workspace original only when the run has Workspace, and never the file name", () => {
    const withWorkspace = animatedGifFrameNote({ attachmentId: "c1", frames: 12, inboxIndexPath: "/workspace/inbox/index.json" });
    expect(withWorkspace).toContain("first frame of an animated GIF with 12 frames");
    expect(withWorkspace).toContain("/workspace/inbox/index.json");
    const without = animatedGifFrameNote({ attachmentId: "c1", frames: 12 });
    expect(without).toBe("[Image image_id=\"c1\" is the first frame of an animated GIF with 12 frames; the other frames are not in this request.]");
    const estimateTokens = (value: unknown) => String(value).length;
    expect(providerAttachmentBudgetTokens({ attachments: [{ ...image("c1", CURRENT_PIXELS), imageNote: without }], estimateTokens,
      estimateImageTokens: () => 100, modelCapabilities: request(plain).modelCapabilities })).toBe(100 + without.length);
  });

  it("counts caption text in the attachment budget only for captioned images", () => {
    const capabilities = request(plain).modelCapabilities;
    const estimateTokens = (value: unknown) => String(value).length;
    const base = providerAttachmentBudgetTokens({ attachments: [image("c1", CURRENT_PIXELS)], estimateTokens, estimateImageTokens: () => 100, modelCapabilities: capabilities });
    const captioned = providerAttachmentBudgetTokens({ attachments: [labelled[1]!], estimateTokens, estimateImageTokens: () => 100, modelCapabilities: capabilities });
    expect(base).toBe(100);
    expect(captioned).toBe(100 + CURRENT_CAPTION.length);
  });
});
