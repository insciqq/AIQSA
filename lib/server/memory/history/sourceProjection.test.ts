import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import {
  buildMemorySafeSourceSnapshot,
  MemoryHistorySourceProjectionError,
  type MemoryHistorySourceMessageInput,
  type MemoryHistorySourceOrigin,
  type MemoryHistorySourceSnapshotInput,
  type MemoryHistoryTaintSource
} from "./sourceProjection";

const SOURCE_HASH = "a".repeat(64);

function userMessage(input: Readonly<{
  content?: unknown;
  createdAt?: string;
  id: string;
  parentMessageId: string | null;
  text?: string;
}>): MemoryHistorySourceMessageInput {
  return {
    chatId: "chat-1",
    content: input.content ?? textMessageContent(input.text ?? `User ${input.id}`),
    createdAt: input.createdAt ?? "2026-08-10T10:00:00.000Z",
    id: input.id,
    parentMessageId: input.parentMessageId,
    provenance: {
      assistantId: null,
      complete: true,
      influencedByMessageIds: [],
      modelRunId: null,
      origin: "DIRECT_USER",
      taintSources: []
    },
    role: "user",
    status: "complete",
    updatedAt: input.createdAt ?? "2026-08-10T10:00:00.000Z"
  };
}

function assistantMessage(input: Readonly<{
  id: string;
  influencedByMessageIds?: readonly string[];
  parentMessageId: string;
  taintSources?: readonly MemoryHistoryTaintSource[];
  text?: string;
}>): MemoryHistorySourceMessageInput {
  return {
    chatId: "chat-1",
    content: textMessageContent(input.text ?? `Assistant ${input.id}`),
    createdAt: "2026-08-10T10:01:00.000Z",
    id: input.id,
    parentMessageId: input.parentMessageId,
    provenance: {
      assistantId: null,
      complete: true,
      influencedByMessageIds: input.influencedByMessageIds ?? [input.parentMessageId],
      modelRunId: `run-${input.id}`,
      origin: "VISIBLE_ASSISTANT",
      taintSources: input.taintSources ?? []
    },
    role: "assistant",
    status: "complete",
    updatedAt: "2026-08-10T10:01:00.000Z"
  };
}

function snapshotInput(
  messages: readonly MemoryHistorySourceMessageInput[],
  overrides: Partial<MemoryHistorySourceSnapshotInput> = {}
): MemoryHistorySourceSnapshotInput {
  return {
    activeLeafMessageId: messages.at(-1)?.id ?? null,
    branchGeneration: 4,
    chatId: "chat-1",
    folderId: "folder-1",
    messages,
    mode: "NORMAL",
    sourceContentHash: SOURCE_HASH,
    sourceRevision: 9,
    timeZone: "Europe/Moscow",
    userId: "user-1",
    ...overrides
  };
}

describe("Memory safe source snapshot", () => {
  it("projects only the deterministic active branch into complete recall turns", () => {
    const user = userMessage({
      id: "user-active",
      parentMessageId: null,
      text: "Я не люблю кофе с 10 августа 2026 года."
    });
    const assistant = assistantMessage({
      id: "assistant-active",
      parentMessageId: user.id,
      text: "Понял: кофе не подходит после 10 августа 2026 года."
    });
    const sibling = assistantMessage({
      id: "assistant-sibling",
      parentMessageId: user.id,
      text: "This sibling must never be projected."
    });
    const input = snapshotInput([sibling, assistant, user], {
      activeLeafMessageId: assistant.id
    });

    const first = buildMemorySafeSourceSnapshot(input);
    const second = buildMemorySafeSourceSnapshot({
      ...input,
      messages: [user, sibling, assistant]
    });

    expect(first).toEqual(second);
    expect(first.activePathMessageIds).toEqual([user.id, assistant.id]);
    expect(first.recallChunkProjection.turnGroups).toHaveLength(1);
    expect(first.recallChunkProjection.turnGroups[0]?.messages.map((message) =>
      message.role)).toEqual(["user", "assistant"]);
    expect(first.factEvidenceProjection.messages.map((message) => message.id))
      .toEqual([user.id]);
    expect(first.recallChunkProjection.turnGroups[0]?.messages[0].safeText)
      .toContain("не люблю кофе");
    expect(first.recallChunkProjection.turnGroups[0]?.messages[1].safeText)
      .toContain("10 августа 2026 года");
    expect(JSON.stringify(first)).not.toContain("This sibling");
    expect(first.snapshotHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("preserves English negation and dates while leaving language metadata und", () => {
    const user = userMessage({
      id: "user-english",
      parentMessageId: null,
      text: "I do not drink coffee after August 10, 2026."
    });
    const assistant = assistantMessage({
      id: "assistant-english",
      parentMessageId: user.id,
      text: "Understood: do not suggest coffee after August 10, 2026."
    });

    const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([user, assistant]));
    const group = snapshot.recallChunkProjection.turnGroups[0];

    expect(group?.languageCode).toBe("und");
    expect(group?.messages.map((message) => message.safeText)).toEqual([
      "I do not drink coffee after August 10, 2026.",
      "Understood: do not suggest coffee after August 10, 2026."
    ]);
  });

  it("does not classify a natural-language secret label without a format signal", () => {
    const secret = "Qwerty123456!";
    const user = userMessage({
      id: "user-secret",
      parentMessageId: null,
      text: `пароль: ${secret}`
    });
    const assistant = assistantMessage({
      id: "assistant-secret",
      parentMessageId: user.id,
      text: "I will not repeat the supplied credential."
    });

    const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([user, assistant]));
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.recallChunkProjection.turnGroups).toHaveLength(1);
    expect(snapshot.factEvidenceProjection.messages.map((message) => message.id))
      .toEqual([user.id]);
    expect(snapshot.provenanceGraph).toEqual([
      expect.objectContaining({
        eligibleForFactEvidence: true,
        eligibleForRecall: true,
        messageId: user.id,
        reasonCodes: [],
        transitiveTaint: false
      }),
      expect.objectContaining({
        eligibleForFactEvidence: false,
        eligibleForRecall: true,
        messageId: assistant.id,
        transitiveTaint: false
      })
    ]);
    expect(serialized).toContain(secret);
    expect(serialized).toContain("supplied credential");
  });

  it("omits attachment blocks while retaining visible assistant recall and user-only facts", () => {
    const user = userMessage({
      content: {
        blocks: [
          { text: "Мой прямой комментарий безопасен.", type: "text" },
          { attachmentId: "private-file-identity", fileName: "private.txt", type: "file" }
        ]
      },
      id: "user-attachment",
      parentMessageId: null
    });
    const assistant = assistantMessage({
      id: "assistant-attachment",
      parentMessageId: user.id,
      text: "This answer used attachment content."
    });

    const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([user, assistant]));

    expect(snapshot.recallChunkProjection.turnGroups).toHaveLength(1);
    expect(snapshot.recallChunkProjection.turnGroups[0]?.messages.map((message) => ({
      role: message.role,
      text: message.safeText
    }))).toEqual([
      { role: "user", text: "Мой прямой комментарий безопасен." },
      { role: "assistant", text: "This answer used attachment content." }
    ]);
    expect(snapshot.factEvidenceProjection.messages.map((message) => message.safeText))
      .toEqual(["Мой прямой комментарий безопасен."]);
    expect(snapshot.provenanceGraph[0]?.reasonCodes).toContain("ATTACHMENT_BLOCK_OMITTED");
    expect(snapshot.provenanceGraph[1]).toMatchObject({
      directTaintSources: [],
      eligibleForFactEvidence: false,
      eligibleForRecall: true,
      transitiveTaint: false
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-file-identity");
    expect(JSON.stringify(snapshot)).toContain("used attachment content");
  });

  it("still excludes assistant messages explicitly marked with non-visible-source taint", () => {
    const taintSources = [
      "KNOWLEDGE",
      "PROVIDER_PAYLOAD",
      "SEARCH",
      "TOOL"
    ] as const satisfies readonly MemoryHistoryTaintSource[];
    for (const taintSource of taintSources) {
      const user = userMessage({
        id: `user-${taintSource.toLowerCase()}`,
        parentMessageId: null,
        text: "This direct user statement remains primary evidence."
      });
      const assistantText = `Unsafe ${taintSource} synthesis must not persist.`;
      const assistant = assistantMessage({
        id: `assistant-${taintSource.toLowerCase()}`,
        parentMessageId: user.id,
        taintSources: [taintSource],
        text: assistantText
      });

      const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([user, assistant]));

      expect(snapshot.recallChunkProjection.turnGroups).toEqual([]);
      expect(snapshot.factEvidenceProjection.messages.map((message) => message.id))
        .toEqual([user.id]);
      expect(snapshot.provenanceGraph[1]).toMatchObject({
        directTaintSources: [taintSource],
        eligibleForRecall: false,
        transitiveTaint: true
      });
      expect(JSON.stringify(snapshot)).not.toContain(assistantText);
    }
  });

  it("never projects system, developer, tool, hidden-assistant, or provider payload nodes", () => {
    const cases = [
      ["system", "SYSTEM"],
      ["developer", "DEVELOPER"],
      ["tool", "TOOL"],
      ["assistant", "HIDDEN_ASSISTANT"],
      ["assistant", "PROVIDER_PAYLOAD"]
    ] as const satisfies readonly (readonly [string, MemoryHistorySourceOrigin])[];
    for (const [role, origin] of cases) {
      const rawText = `raw-${origin.toLowerCase()}-content`;
      const message: MemoryHistorySourceMessageInput = {
        chatId: "chat-1",
        content: textMessageContent(rawText),
        createdAt: "2026-08-10T10:00:00.000Z",
        id: `message-${origin.toLowerCase()}`,
        parentMessageId: null,
        provenance: {
          assistantId: null,
          complete: true,
          influencedByMessageIds: [],
          modelRunId: role === "assistant" ? `run-${origin.toLowerCase()}` : null,
          origin,
          taintSources: []
        },
        role,
        status: "complete",
        updatedAt: "2026-08-10T10:00:00.000Z"
      };

      const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([message]));

      expect(snapshot.factEvidenceProjection.messages).toEqual([]);
      expect(snapshot.recallChunkProjection.turnGroups).toEqual([]);
      expect(snapshot.provenanceGraph[0]).toMatchObject({
        eligibleForFactEvidence: false,
        eligibleForRecall: false,
        origin,
        transitiveTaint: true
      });
      expect(JSON.stringify(snapshot)).not.toContain(rawText);
    }
  });

  it("defers semantic contact classification to downstream System Model stages", () => {
    const user = userMessage({
      id: "user-contact",
      parentMessageId: null,
      text: "Пишите мне на me@example.com."
    });
    const assistant = assistantMessage({
      id: "assistant-contact",
      parentMessageId: user.id,
      text: "Хорошо, адрес учтён только в этом безопасном фрагменте."
    });

    const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([user, assistant]));

    expect(snapshot.recallChunkProjection.turnGroups).toHaveLength(1);
    expect(snapshot.recallChunkProjection.turnGroups[0]).toMatchObject({
      redactionReasonCodes: [],
      redactionState: "NOT_NEEDED",
      safetyClass: "NORMAL"
    });
    expect(snapshot.factEvidenceProjection.messages).toMatchObject([{
      id: user.id,
      safetyClass: "NORMAL"
    }]);
    expect(JSON.stringify(snapshot)).toContain("me@example.com");
  });

  it("does not infer a cross-turn secret assignment from English words", () => {
    const firstUser = userMessage({
      id: "user-window-1",
      parentMessageId: null,
      text: "My password:"
    });
    const firstAssistant = assistantMessage({
      id: "assistant-window-1",
      parentMessageId: firstUser.id,
      text: "Acknowledged."
    });
    const secondUser = userMessage({
      id: "user-window-2",
      parentMessageId: firstAssistant.id,
      text: "correct-horse-battery"
    });
    const secondAssistant = assistantMessage({
      id: "assistant-window-2",
      parentMessageId: secondUser.id,
      text: "No credential will be repeated."
    });

    const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([
      firstUser,
      firstAssistant,
      secondUser,
      secondAssistant
    ]));

    expect(snapshot.factEvidenceProjection.messages.map((message) => message.id))
      .toEqual([firstUser.id, secondUser.id]);
    expect(snapshot.provenanceGraph[0]?.reasonCodes)
      .not.toContain("FACT_WINDOW_SAFETY_EXCLUDED");
    expect(snapshot.provenanceGraph[2]?.reasonCodes)
      .not.toContain("FACT_WINDOW_SAFETY_EXCLUDED");
  });

  it("returns an inert projection for excluded and Temporary sources", () => {
    const user = userMessage({
      id: "user-inert",
      parentMessageId: null,
      text: "This raw source must not leave the inactive boundary."
    });
    for (const mode of ["EXCLUDED", "TEMPORARY"] as const) {
      const snapshot = buildMemorySafeSourceSnapshot(snapshotInput([user], { mode }));

      expect(snapshot.activePathMessageIds).toEqual([]);
      expect(snapshot.provenanceGraph).toEqual([]);
      expect(snapshot.factEvidenceProjection.messages).toEqual([]);
      expect(snapshot.recallChunkProjection.turnGroups).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain("raw source");
    }
  });

  it("fails closed on an incomplete or cyclic active path", () => {
    const cyclic = userMessage({ id: "cycle", parentMessageId: "cycle" });

    expect(() => buildMemorySafeSourceSnapshot(snapshotInput([cyclic])))
      .toThrowError(new MemoryHistorySourceProjectionError(
        "memory_history_source_path_cycle"
      ));
    expect(() => buildMemorySafeSourceSnapshot(snapshotInput([], {
      activeLeafMessageId: "missing"
    }))).toThrowError(new MemoryHistorySourceProjectionError(
      "memory_history_source_path_incomplete"
    ));
  });
});
