import { MEMORY_NOTE_PREVIEW, PERSONAL_INSTRUCTIONS_PREVIEW } from "./responseReminder";
import type { ProviderRunRequest } from "./types";

/** General trusted instructions stay first, then the user's personal Instructions and the answer rules, then the user's
 * memory note as admission froze it (operator decision 2026-11-22): user content like the Instructions, the same across a
 * chat's turns until the user changes it, so provider caches keep reading the prefix. A request admitted before v0.5.0
 * may still carry Personal Memory's context and receipts; nothing renders them. */
export function providerInstructionsWithPersonalContext(
  request: ProviderRunRequest,
  preview = false
): string | undefined {
  const parts = [
    request.prompt.system,
    request.prompt.personalInstructions
      ? preview ? PERSONAL_INSTRUCTIONS_PREVIEW : request.prompt.personalInstructions : null,
    request.prompt.developer ? `Developer instructions:\n${request.prompt.developer}` : null,
    request.prompt.memoryNote ? preview ? MEMORY_NOTE_PREVIEW : request.prompt.memoryNote : null
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
