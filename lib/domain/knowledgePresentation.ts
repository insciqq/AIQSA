export type KnowledgeAggregateState =
  | "archived"
  | "empty"
  | "needs_attention"
  | "processing"
  | "ready"
  | "trashed"
  | "unavailable";

export type KnowledgeAggregatePresentation = Readonly<{
  label: string;
  state: KnowledgeAggregateState;
  tone: "danger" | "live" | "neutral" | "ok" | "warn";
}>;

export type KnowledgeAggregateStatusInput = Readonly<{
  attentionDocuments?: number;
  now?: Date;
  processingDocuments?: number;
  purgeScheduledAt?: string | null;
  readyDocuments?: number;
  state: KnowledgeAggregateState;
}>;

const DAY_MS = 24 * 60 * 60 * 1_000;

function pendingPart(count: number, label: "needs attention" | "processing"): string | null {
  return count > 0 ? `${count} ${label}` : null;
}

function trashLabel(purgeScheduledAt: string | null | undefined, now: Date): string {
  if (!purgeScheduledAt) return "In Trash";
  const deadline = Date.parse(purgeScheduledAt);
  if (!Number.isFinite(deadline)) return "In Trash";
  const days = Math.max(0, Math.ceil((deadline - now.getTime()) / DAY_MS));
  if (days === 0) return "In Trash · deletion due";
  return `In Trash · deleted in ${days} ${days === 1 ? "day" : "days"}`;
}

/** Formats Knowledge usability first and appends only bounded pending counts. */
export function knowledgeAggregateStatus(
  input: KnowledgeAggregateStatusInput
): KnowledgeAggregatePresentation {
  if (input.state === "unavailable") {
    return { label: "Unavailable · access revoked", state: "unavailable", tone: "danger" };
  }
  if (input.state === "trashed") {
    return {
      label: trashLabel(input.purgeScheduledAt, input.now ?? new Date()),
      state: "trashed",
      tone: "neutral"
    };
  }
  if (input.state === "archived") {
    return { label: "Archived", state: "archived", tone: "neutral" };
  }
  if (input.state === "empty") {
    return { label: "Empty · no documents yet", state: "empty", tone: "neutral" };
  }

  const ready = input.readyDocuments ?? (input.state === "ready" ? 1 : 0);
  const processing = input.processingDocuments ?? 0;
  const attention = input.attentionDocuments ?? 0;
  if (ready > 0) {
    const parts = [
      "Ready",
      pendingPart(processing, "processing"),
      pendingPart(attention, "needs attention")
    ].filter((part): part is string => Boolean(part));
    return {
      label: parts.join(" · "),
      state: attention > 0 ? "needs_attention" : processing > 0 ? "processing" : "ready",
      tone: processing > 0 || attention > 0 ? "warn" : "ok"
    };
  }
  if (processing > 0 || input.state === "processing") {
    return {
      label: ["Processing", pendingPart(attention, "needs attention")]
        .filter((part): part is string => Boolean(part)).join(" · "),
      state: attention > 0 ? "needs_attention" : "processing",
      tone: attention > 0 ? "warn" : "live"
    };
  }
  return { label: "Needs attention", state: "needs_attention", tone: "danger" };
}
