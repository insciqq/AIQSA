import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../../tools/types";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  type MemoryFactExtractionInput
} from "./contract";
import { decodeMemoryFactExtraction, MemoryFactDecodeError } from "./decoder";
import {
  MEMORY_FACT_EXTRACTION_TOOL_NAME,
  memoryFactExtractionPromptPayload
} from "./prompt";

function input(text: string): MemoryFactExtractionInput {
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    folderId: null,
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-11T09:00:00.000Z",
      evidenceEligible: true,
      id: "message-1",
      languageCode: "und",
      role: "user",
      text,
      updatedAt: "2026-08-11T09:00:00.000Z"
    }],
    source: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 2,
      chatId: "chat-1",
      memoryGenerationSnapshot: 0,
      sourceHash: "a".repeat(64),
      sourceMessageId: "message-1",
      sourceRevision: 7,
      userId: "user-1"
    },
    sourceProjectionHash: "b".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "c".repeat(64),
    timeZone: "Europe/Moscow"
  };
  return { ...withoutHash, inputHash: memoryFactExtractionInputHash(withoutHash) };
}

describe("Memory fact extraction decoder", () => {
  it("supplies the bounded direct-user source to the semantic extractor", () => {
    const payload = JSON.parse(
      memoryFactExtractionPromptPayload(input("回答は短くしてください。"))
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ chat_id: "chat-1", folder_id: null });
  });

  it("rejects the retired packet instead of executing obsolete model-authored fields", () => {
    const legacy: ModelToolCall[] = [{
      arguments: { candidates: [], decision: "ABSTAIN" },
      id: "legacy-call",
      name: MEMORY_FACT_EXTRACTION_TOOL_NAME
    }];
    expect(() => decodeMemoryFactExtraction(legacy, input("Temporary chat.")))
      .toThrow(MemoryFactDecodeError);
  });
});
