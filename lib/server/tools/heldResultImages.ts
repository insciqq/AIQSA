import type { TranscriptImages } from "../engine/transcript";
import type { ProviderHistoryImage } from "../providers/history";
import type { ProviderRunRequest } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import { directImageBudget, DIRECT_IMAGE_VIEW_LIMITS, type DirectImageBudget } from "../workspace/directImageView";
import { createRequestImageAllowance, type AllowanceEntry, type RequestImageAllowance } from "./requestImageAllowance";
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
   * one preview's bounds, or the request's room shared with the agent's other image tools (`RequestImageAllowance`)
   * after letting go of previews earlier rounds already carried, or the process's budget. A retry of the call replaces
   * its earlier preview.
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
  /** The agent's request room, shared with its other image tools; this holder's own by default. */
  allowance?: RequestImageAllowance;
  /** The process's budget by default. */
  budget?: DirectImageBudget;
  /** Settles when the run ends; the run's own settlement in this process by default. */
  runEnded?: Promise<void> | null;
}>): HeldResultImages {
  const request = input.request;
  const allowance = input.allowance ?? createRequestImageAllowance(request);
  const budget = input.budget ?? directImageBudget();
  type Held = AllowanceEntry & { callId: string; output: string; image: ProviderHistoryImage };
  let held: Held[] = [];
  let ended = false;
  const heldBytes = (entries: readonly Held[]) => entries.reduce((sum, entry) => sum + entry.encodedBytes, 0);
  const forget = (entry: Held) => {
    held = held.filter((other) => other !== entry);
    allowance.remove(entry);
  };
  const release = () => {
    ended = true;
    budget.free(heldBytes(held));
    for (const entry of held) allowance.remove(entry);
    held = [];
  };
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
      if (preview.bytes.length > Math.min(DIRECT_IMAGE_VIEW_LIMITS.imageBytes, limits?.imageBytes ?? Infinity) ||
        preview.width * preview.height > Math.min(DIRECT_IMAGE_VIEW_LIMITS.imagePixels, limits?.imagePixels ?? Infinity)) return false;
      const size = { encodedBytes: Math.ceil(preview.bytes.length / 3) * 4, round, tokens: allowance.tokens(preview) };
      const replaced = held.filter((entry) => entry.callId === call.id);
      const drops = allowance.plan(size, replaced);
      // Previews let go here may be another tool's: the process's budget takes the new one net of all of them.
      if (!drops || !budget.swap(size.encodedBytes, [...drops, ...replaced].reduce((sum, entry) => sum + entry.encodedBytes, 0))) {
        return false;
      }
      for (const entry of drops) entry.drop();
      for (const entry of replaced) forget(entry);
      const entry: Held = { ...size, callId: call.id, drop: () => forget(entry), image: { data: preview.bytes.toString("base64"),
        mimeType: preview.mimeType }, output };
      held = [...held, entry];
      allowance.add(entry);
      return true;
    }
  };
}
