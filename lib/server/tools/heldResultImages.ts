import { imageTokenEstimator } from "../../domain/imageTokenEstimate";
import type { TranscriptImages } from "../engine/transcript";
import type { ProviderHistoryImage } from "../providers/history";
import { providerAttachmentBudgetTokens } from "../providers/attachmentPayload";
import type { ProviderRunRequest } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import { directImageBudget, DIRECT_IMAGE_VIEW_LIMITS, type DirectImageBudget } from "../workspace/directImageView";
import type { ModelToolCall } from "./types";

/** A bounded preview a tool shows the model: decoded, resized and encoded by the image helpers. */
export type ResultImagePreview = Readonly<{ bytes: Buffer; width: number; height: number; mimeType: "image/png" | "image/jpeg" }>;

export type HeldResultImages = Readonly<{
  /** The previews a request carries with their results, matched by call id and the output the result led with. */
  images: TranscriptImages;
  /** The run has ended and freed its previews: a preview prepared now is not held. */
  ended(): boolean;
  /** One of the process's decode slots (`DirectImageBudget.prepare`): its release, or null when none freed in time. */
  prepare(signal?: AbortSignal): Promise<(() => void) | null>;
  /**
   * Holds `preview` for the result of `call` whose output is `output`, made in loop round `round`: false when it passes
   * one preview's bounds or a request's (count, bytes, the model's declared image limits, a share of its window, the
   * run's own input images counted first) after letting go of previews earlier rounds already carried, or the
   * process's budget. A retry of the call replaces its earlier preview.
   */
  hold(call: Pick<ModelToolCall, "id">, round: number, preview: ResultImagePreview, output: string): boolean;
}>;

/**
 * The image previews one run's tool results carry in its own requests (`read_chat_file`, `computer_read`): pixels live
 * only in this run's memory and in the process's direct-view budget (`lib/server/workspace/directImageView.ts`), never
 * in the transcript, so a later turn reads the result's text alone. Freed when the run settles.
 */
export function createHeldResultImages(input: Readonly<{
  request: ProviderRunRequest;
  runId: string;
  /** The tool whose results carry the previews. */
  toolName: string;
  /** The process's budget by default. */
  budget?: DirectImageBudget;
  /** Settles when the run ends; the run's own settlement in this process by default. */
  runEnded?: Promise<void> | null;
}>): HeldResultImages {
  const request = input.request;
  const estimate = imageTokenEstimator({ modelId: request.modelId, provider: request.provider });
  const budget = input.budget ?? directImageBudget();
  type Held = { callId: string; output: string; round: number; image: ProviderHistoryImage; tokens: number };
  let held: Held[] = [];
  let ended = false;
  const heldBytes = (entries: readonly Held[]) => entries.reduce((sum, entry) => sum + entry.image.data.length, 0);
  const release = () => { ended = true; budget.free(heldBytes(held)); held = []; };
  void (input.runEnded === undefined ? activeRunControllerRegistry.settled(input.runId) : input.runEnded)?.then(release, release);

  return {
    images: { attached: (item) => {
      const image = item.name === input.toolName && item.outcome === "complete"
        // The batch may append what the turn has left below a result (`toolBatch.ts`); the result itself leads.
        ? held.find((entry) => entry.callId === item.callId &&
          (item.output === entry.output || item.output.startsWith(`${entry.output}\n`))) : undefined;
      return image ? { image: image.image, tokens: image.tokens } : undefined;
    }, note: "" },
    ended: () => ended,
    prepare: (signal) => budget.prepare(signal),
    hold(call, round, preview, output) {
      if (ended) return false;
      const limits = request.modelCapabilities.imageInputLimits;
      const own = request.attachments.filter((file) => file.kind === "image" && Boolean(file.base64Data || file.dataUrl));
      const ownBytes = own.reduce((sum, file) => sum + (file.dataUrl?.length ?? file.base64Data?.length ?? 0), 0);
      const ownTokens = providerAttachmentBudgetTokens({ attachments: own, estimateImageTokens: estimate, modelCapabilities: request.modelCapabilities });
      const tokens = estimate(preview);
      const encodedBytes = Math.ceil(preview.bytes.length / 3) * 4;
      const countBound = Math.min(DIRECT_IMAGE_VIEW_LIMITS.requestImages, limits?.imageCount ?? Infinity) - own.length;
      const bytesBound = Math.min(DIRECT_IMAGE_VIEW_LIMITS.requestBytes, limits?.payloadBytes ?? Infinity) - ownBytes;
      const tokensBound = request.modelCapabilities.contextWindow
        ? Math.floor(request.modelCapabilities.contextWindow * DIRECT_IMAGE_VIEW_LIMITS.windowShare) - ownTokens : Infinity;
      let kept = held.filter((entry) => entry.callId !== call.id);
      const fits = () => kept.length + 1 <= countBound && heldBytes(kept) + encodedBytes <= bytesBound &&
        kept.reduce((sum, entry) => sum + entry.tokens, tokens) <= tokensBound;
      while (!fits() && kept[0] && kept[0].round < round) kept = kept.slice(1);
      if (!fits() || preview.bytes.length > Math.min(DIRECT_IMAGE_VIEW_LIMITS.imageBytes, limits?.imageBytes ?? Infinity) ||
        preview.width * preview.height > Math.min(DIRECT_IMAGE_VIEW_LIMITS.imagePixels, limits?.imagePixels ?? Infinity) ||
        !budget.swap(encodedBytes, heldBytes(held) - heldBytes(kept))) return false;
      held = [...kept, { callId: call.id, output, round, tokens, image: { data: preview.bytes.toString("base64"), mimeType: preview.mimeType } }];
      return true;
    }
  };
}
