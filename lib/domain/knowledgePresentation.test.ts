import { describe, expect, it } from "vitest";
import { knowledgeAggregateStatus } from "./knowledgePresentation";

describe("Knowledge aggregate status", () => {
  it("leads with a ready subset and appends bounded work counts", () => {
    expect(knowledgeAggregateStatus({
      attentionDocuments: 1,
      processingDocuments: 2,
      readyDocuments: 4,
      state: "needs_attention"
    })).toEqual({
      label: "Ready · 2 processing · 1 needs attention",
      state: "needs_attention",
      tone: "warn"
    });
  });

  it("never labels zero-ready processing as ready", () => {
    expect(knowledgeAggregateStatus({
      attentionDocuments: 0,
      processingDocuments: 3,
      readyDocuments: 0,
      state: "processing"
    }).label).toBe("Processing");
  });

  it("covers empty, unavailable, archived, and deterministic Trash copy", () => {
    expect(knowledgeAggregateStatus({ state: "empty" }).label)
      .toBe("Empty · no documents yet");
    expect(knowledgeAggregateStatus({ state: "unavailable" }).label)
      .toBe("Unavailable · access revoked");
    expect(knowledgeAggregateStatus({ state: "archived" }).label).toBe("Archived");
    expect(knowledgeAggregateStatus({
      now: new Date("2026-09-03T10:00:00.000Z"),
      purgeScheduledAt: "2026-09-29T10:00:00.000Z",
      state: "trashed"
    }).label).toBe("In Trash · deleted in 26 days");
  });
});
