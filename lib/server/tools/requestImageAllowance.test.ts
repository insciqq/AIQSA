import { describe, expect, it } from "vitest";
import type { ProviderAttachment, ProviderRunRequest } from "../providers/types";
import { DIRECT_IMAGE_VIEW_LIMITS } from "../workspace/directImageLimits";
import { createRequestImageAllowance, type AllowanceEntry } from "./requestImageAllowance";

type Limits = NonNullable<ProviderRunRequest["modelCapabilities"]["imageInputLimits"]>;

function request(attachments: ProviderAttachment[], extra: Partial<ProviderRunRequest["modelCapabilities"]> = {}): ProviderRunRequest {
  return {
    attachmentIds: [], attachments, chatId: "chat-1", content: { blocks: [] },
    modelCapabilities: { contextWindow: 400_000, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true,
      toolCalling: true, vision: true, ...extra },
    modelId: "gpt-6-astra", params: {}, prompt: { developer: null, system: null }, provider: "openai",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
}

/** A conversation image the request carries, 512×512 as an upload records it. */
const image = (index: number, dataUrl = "data:image/png;base64,AAAA"): ProviderAttachment => ({ byteSize: 4, dataUrl,
  extractedText: null, fileName: `card-${index}.png`, id: `a${index}`, kind: "image", metadata: { image: { height: 512, width: 512 } },
  mimeType: "image/png", status: "ready" });

const conversation = (count: number) => Array.from({ length: count }, (_, index) => image(index));

const preview = { encodedBytes: 400_000, round: 1, tokens: 2_000 };

/** Holds previews of one round until the allowance refuses one; returns how many it held. */
function fill(allowance: ReturnType<typeof createRequestImageAllowance>, size = preview): number {
  let held = 0;
  while (held < 1_000) {
    const drops = allowance.plan(size);
    if (!drops) return held;
    expect(drops).toEqual([]);
    allowance.add({ ...size, drop: () => undefined } satisfies AllowanceEntry);
    held += 1;
  }
  return held;
}

describe("request image allowance", () => {
  it("keeps the previews' own room beside the input's many images", () => {
    // A card-editing chat carries 20 images of its own: the previews still take their count.
    expect(fill(createRequestImageAllowance(request(conversation(20))))).toBe(DIRECT_IMAGE_VIEW_LIMITS.requestImages);
    expect(fill(createRequestImageAllowance(request([])))).toBe(DIRECT_IMAGE_VIEW_LIMITS.requestImages);
    // And their bytes: 3 MiB previews fill 12 MiB whatever the input carries.
    const large = { ...preview, encodedBytes: 3 * 1024 * 1024 };
    expect(fill(createRequestImageAllowance(request(conversation(20))), large)).toBe(4);
  });

  it("keeps the model's declared limits on the whole request, the input's own images first", () => {
    const limits: Limits = { imageBytes: 5_000_000, imageCount: 21, imagePixels: 4_000_000, payloadBytes: 50_000_000 };
    expect(fill(createRequestImageAllowance(request(conversation(20), { imageInputLimits: limits })))).toBe(1);
    expect(fill(createRequestImageAllowance(request(conversation(20), { imageInputLimits: { ...limits, imageCount: 20 } })))).toBe(0);
    // The payload counts the input's base64 bytes: 20 × 26 characters leave room for one preview of 400,000.
    const payload = 20 * image(0).dataUrl!.length + preview.encodedBytes;
    expect(fill(createRequestImageAllowance(request(conversation(20), { imageInputLimits: { ...limits, payloadBytes: payload } })))).toBe(1);
    expect(fill(createRequestImageAllowance(request(conversation(20),
      { imageInputLimits: { ...limits, payloadBytes: payload - 1 } })))).toBe(0);
  });

  it("keeps an undeclared model's request within every route's totals", () => {
    // The input's own bytes take the request total first: what is left of it bounds the previews.
    const own = (bytes: number) => [image(0, `data:image/png;base64,${"A".repeat(bytes - 22)}`)];
    const total = DIRECT_IMAGE_VIEW_LIMITS.requestTotalBytes;
    expect(fill(createRequestImageAllowance(request(own(total - 2 * preview.encodedBytes))))).toBe(2);
    expect(fill(createRequestImageAllowance(request(own(total))))).toBe(0);
    const many = conversation(DIRECT_IMAGE_VIEW_LIMITS.requestTotalImages - 3);
    expect(fill(createRequestImageAllowance(request(many, { contextWindow: 4_000_000 })))).toBe(3);
  });

  it("keeps the window share for the whole request: the input's own image tokens come first", () => {
    // 20 images of 512×512 take about 15,000 tokens of a 100,000-token window's quarter: four 2,000-token previews fill the rest.
    expect(fill(createRequestImageAllowance(request(conversation(20), { contextWindow: 100_000 })))).toBe(4);
    expect(fill(createRequestImageAllowance(request(conversation(40), { contextWindow: 100_000 })))).toBe(0);
  });
});
