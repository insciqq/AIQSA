import { textMessageContent, type MessageContent } from "./content";

export const GROUNDED_LIVE_ONLY_PLACEHOLDER = "Grounded answer was not retained.";

export function groundedLiveOnlyMessageContent(): MessageContent {
  return textMessageContent(GROUNDED_LIVE_ONLY_PLACEHOLDER);
}

export function groundedLiveOnlyProviderPreview(): Record<string, unknown> {
  return {
    grounding: {
      retention: "live_only",
      status: "not_retained"
    }
  };
}
