import { imageTokenEstimator } from "../../domain/imageTokenEstimate";
import { providerAttachmentBudgetTokens } from "../providers/attachmentPayload";
import type { ProviderRunRequest } from "../providers/types";
import { DIRECT_IMAGE_VIEW_LIMITS } from "../workspace/directImageLimits";

/** What one held preview adds to every request that carries it. */
export type AllowanceSize = Readonly<{
  /** Base64 characters. */
  encodedBytes: number;
  /** The loop round whose batch made it: requests of later rounds carried it. */
  round: number;
  tokens: number;
}>;

/** A held preview as the allowance counts it; `drop` takes it out of its holder when another needs its room. */
export type AllowanceEntry = AllowanceSize & Readonly<{ drop(): void }>;

export type RequestImageAllowance = Readonly<{
  /** The model's token estimate for an image of this size. */
  tokens(image: Readonly<{ width: number; height: number }>): number;
  /**
   * The held previews to let go so that `next` fits beside the rest, or null when it cannot: previews earlier rounds'
   * requests already carried go first, oldest first, and once any must go, down to half the count bound, so the requests'
   * common prefix changes only every few views and provider prompt caches keep reading it; previews no request carried
   * yet are never let go for a later one. `replacing` (a retry's earlier preview) leaves in any case.
   */
  plan(next: AllowanceSize, replacing?: readonly AllowanceEntry[]): AllowanceEntry[] | null;
  /** Counts a held preview, newest last. */
  add(entry: AllowanceEntry): void;
  /** Stops counting a preview its holder let go (evicted, replaced or the run ended). */
  remove(entry: AllowanceEntry): void;
}>;

const bytesOf = (entries: readonly AllowanceSize[]) => entries.reduce((total, entry) => total + entry.encodedBytes, 0);
const tokensOf = (entries: readonly AllowanceSize[]) => entries.reduce((total, entry) => total + entry.tokens, 0);

/**
 * The image room of one agent's requests, shared by every tool whose results carry previews (`view_workspace_image`,
 * `read_chat_file`, `computer_read`). The previews' own count and bytes (`DIRECT_IMAGE_VIEW_LIMITS`) bound the previews
 * alone; the model's declared image limits, else the request totals, and a share of its window bound the whole request,
 * the run's own input images counted first and once. One per tool registry, since each agent sends requests of its own.
 */
export function createRequestImageAllowance(request: ProviderRunRequest): RequestImageAllowance {
  const estimate = imageTokenEstimator({ modelId: request.modelId, provider: request.provider });
  const limits = request.modelCapabilities.imageInputLimits;
  const own = request.attachments.filter((file) => file.kind === "image" && Boolean(file.dataUrl || file.base64Data));
  const ownBytes = own.reduce((total, file) => total + (file.dataUrl?.length ?? file.base64Data?.length ?? 0), 0);
  const ownTokens = providerAttachmentBudgetTokens({ attachments: own, estimateImageTokens: estimate, modelCapabilities: request.modelCapabilities });
  const window = request.modelCapabilities.contextWindow;
  // A chat whose input carries many images (a production card-editing chat held 12–69) kept no room for a single preview
  // while the previews' own bounds counted those images too, so its agent could never check its own edit.
  const bound = {
    bytes: Math.max(0, Math.min(DIRECT_IMAGE_VIEW_LIMITS.requestBytes,
      (limits?.payloadBytes ?? DIRECT_IMAGE_VIEW_LIMITS.requestTotalBytes) - ownBytes)),
    count: Math.max(0, Math.min(DIRECT_IMAGE_VIEW_LIMITS.requestImages,
      (limits?.imageCount ?? DIRECT_IMAGE_VIEW_LIMITS.requestTotalImages) - own.length)),
    // The window holds everything else too and compaction cannot free an image, so the share stays one for the request.
    tokens: typeof window === "number" && window > 0
      ? Math.max(0, Math.floor(window * DIRECT_IMAGE_VIEW_LIMITS.windowShare) - ownTokens) : Infinity
  };
  const held: AllowanceEntry[] = [];
  return {
    tokens: (image) => estimate(image),
    plan(next, replacing = []) {
      const fits = (list: readonly AllowanceEntry[]) => list.length + 1 <= bound.count &&
        bytesOf(list) + next.encodedBytes <= bound.bytes && tokensOf(list) + next.tokens <= bound.tokens;
      const carried = (entry: AllowanceEntry) => entry.round < next.round;
      let kept = held.filter((entry) => !replacing.includes(entry));
      if (!fits(kept)) {
        while (!fits(kept) && kept[0] && carried(kept[0])) kept = kept.slice(1);
        if (!fits(kept)) return null;
        const half = Math.floor(bound.count / 2);
        while (kept.length + 1 > half && kept[0] && carried(kept[0])) kept = kept.slice(1);
      }
      return held.filter((entry) => !kept.includes(entry) && !replacing.includes(entry));
    },
    add(entry) {
      held.push(entry);
    },
    remove(entry) {
      const index = held.indexOf(entry);
      if (index >= 0) held.splice(index, 1);
    }
  };
}
