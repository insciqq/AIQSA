import { randomUUID } from "node:crypto";
import { decodeResourceChangeCard, type ResourceChangeCard } from "@/lib/contracts/resourceChanges";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";

/** A card the browser's decoder would drop: the change or proposal stops instead of going unseen. */
export class ResourceChangeCardError extends Error {
  constructor() {
    super("resource_change_card_invalid");
    this.name = "ResourceChangeCardError";
  }
}

/**
 * The answer's event for a card, checked with the decoder the answer uses.
 * A change throws inside its transaction, so it rolls back with its call
 * unsettled; a proposal is refused visibly.
 */
export function resourceChangeArtifact(card: ResourceChangeCard): ModelRunSseEvent {
  if (!decodeResourceChangeCard(card)) throw new ResourceChangeCardError();
  return { data: { artifactType: "resource_change", payload: card }, type: "artifact" };
}

/** A proposal's own identity: two proposals of one answer are two questions. */
export function newProposalId(): string {
  return randomUUID();
}
