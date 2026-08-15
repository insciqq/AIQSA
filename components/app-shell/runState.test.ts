import { describe, expect, it } from "vitest";
import { appendCompactRunEvent, mergeThreadMessages } from "./runState";
import type { RunEventView, ThreadMessage } from "./types";

function message(overrides: Partial<ThreadMessage>): ThreadMessage {
  return {
    content: "",
    id: "message-1",
    modelId: "fake-model",
    parentMessageId: null,
    provider: "fake",
    role: "user",
    status: "complete",
    ...overrides
  };
}

const tokenEvent: RunEventView = { data: { delta: "word " }, type: "token" };

const searchArtifact: RunEventView = {
  data: { artifactType: "search", payload: { query: "pipeline" } },
  type: "artifact"
};

describe("run state helpers", () => {
  it("compacts a 2,000-token stream into one bounded timeline event", () => {
    let events: RunEventView[] = [];

    for (let index = 0; index < 2_000; index += 1) {
      events = appendCompactRunEvent(events, {
        data: { chunkCount: 1, delta: "x" },
        type: "token"
      });
    }

    expect(events).toEqual([
      {
        data: {
          characterCount: 2_000,
          chunkCount: 2_000
        },
        type: "token"
      }
    ]);
  });

  it("preserves chronology by starting a new token aggregate after another event", () => {
    const events = [tokenEvent, searchArtifact, tokenEvent].reduce(appendCompactRunEvent, [] as RunEventView[]);

    expect(events.map((event) => event.type)).toEqual(["token", "artifact", "token"]);
  });

  it("preserves optimistic in-flight rows when stale chat detail is merged", () => {
    const persistedUser = message({ content: "Before", id: "user-1" });
    const optimisticUser = message({ content: "Question", id: "user-optimistic", parentMessageId: "user-1" });
    const optimisticAssistant = message({
      id: "assistant-optimistic",
      parentMessageId: "user-optimistic",
      role: "assistant",
      status: "streaming"
    });

    const merged = mergeThreadMessages(
      [persistedUser, optimisticUser, optimisticAssistant],
      [{ ...persistedUser, content: "Before from server" }]
    );

    expect(merged.map((candidate) => candidate.id)).toEqual([
      "user-1",
      "user-optimistic",
      "assistant-optimistic"
    ]);
    expect(merged[0].content).toBe("Before from server");
    expect(merged[2]).toMatchObject({
      role: "assistant",
      status: "streaming"
    });
  });
});
