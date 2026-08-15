import { textMessageContent, type MessageContent } from "./content";

export const GROUNDED_LIVE_ONLY_PLACEHOLDER = "Grounded answer was not retained.";

export function groundedLiveOnlyMessageContent(): MessageContent {
  return textMessageContent(GROUNDED_LIVE_ONLY_PLACEHOLDER);
}
