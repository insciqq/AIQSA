import { describe, expect, it } from "vitest";
import {
  buildPublicShareSnapshot,
  GroundedContentNotShareableError,
  projectPublicShareSnapshot,
  type ShareSnapshotMessageInput
} from "./shareSnapshot";

const messages: ShareSnapshotMessageInput[] = [
  {
    content: {
      blocks: [{ text: "Root question", type: "text" }]
    },
    id: "u1",
    parentMessageId: null,
    role: "user"
  },
  {
    content: {
      blocks: [{ text: "Original answer", type: "text" }]
    },
    id: "a1",
    parentMessageId: "u1",
    role: "assistant"
  },
  {
    content: {
      blocks: [
        { text: "Edited branch", type: "text" },
        {
          alt: "Passport scan for Alice Example",
          attachmentId: "private-image",
          metadata: { camera: "private-camera-id" },
          storageKey: "users/private/image-key",
          type: "image",
          url: "https://storage.example/private-image"
        },
        {
          attachmentId: "private-pdf",
          fileName: "alice-medical-record.pdf",
          metadata: { pages: 12, source: "private-object-metadata" },
          storageKey: "users/private/pdf-key",
          type: "file",
          url: "https://storage.example/private-pdf"
        }
      ]
    },
    id: "u2",
    parentMessageId: null,
    role: "user"
  }
];

describe("share snapshots", () => {
  it("includes only the active visible branch path", () => {
    expect(buildPublicShareSnapshot({ activeLeafMessageId: "u2", messages, title: "Shared" })).toEqual({
      messages: [
        {
          content: {
            blocks: [
              { text: "Edited branch", type: "text" },
              { text: "[Image attachment omitted]", type: "text" },
              { text: "[Attachment omitted]", type: "text" }
            ]
          },
          role: "user"
        }
      ],
      title: "Shared",
      version: 1
    });
  });

  it("does not expose message ids or any private attachment metadata", () => {
    const snapshot = buildPublicShareSnapshot({ activeLeafMessageId: "u2", messages, title: "Shared" });
    const serialized = JSON.stringify(snapshot);

    for (const privateValue of [
      "private-image",
      "private-pdf",
      "alice-medical-record.pdf",
      "Passport scan for Alice Example",
      "private-camera-id",
      "private-object-metadata",
      "users/private/image-key",
      "users/private/pdf-key",
      "https://storage.example/private-image",
      "https://storage.example/private-pdf",
      "u2"
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("rejects a visible grounded branch without blocking an unrelated sibling branch", () => {
    const groundedMessages: ShareSnapshotMessageInput[] = messages.map((message) =>
      message.id === "a1"
        ? { ...message, groundedAt: new Date("2026-07-26T12:00:00.000Z") }
        : message
    );

    expect(() => buildPublicShareSnapshot({
      activeLeafMessageId: "a1",
      messages: groundedMessages,
      title: "Grounded"
    })).toThrow(GroundedContentNotShareableError);
    expect(buildPublicShareSnapshot({
      activeLeafMessageId: "u2",
      messages: groundedMessages,
      title: "Sibling"
    }).messages).toHaveLength(1);
  });

  it("keeps attachment-only turns readable even when private file metadata is malformed", () => {
    const snapshot = buildPublicShareSnapshot({
      activeLeafMessageId: "attachment-only",
      messages: [
        {
          content: {
            blocks: [
              {
                attachmentId: "private-file-id",
                fileName: null,
                storageKey: "private-storage-key",
                type: "file"
              }
            ]
          },
          id: "attachment-only",
          parentMessageId: null,
          role: "user"
        }
      ],
      title: "Attachment only"
    });

    expect(snapshot.messages).toEqual([
      {
        content: { blocks: [{ text: "[Attachment omitted]", type: "text" }] },
        role: "user"
      }
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private-file-id");
    expect(JSON.stringify(snapshot)).not.toContain("private-storage-key");
  });

  it("keeps answer text byte-for-byte while stripping every Knowledge evidence surface", () => {
    const answer = "Exact answer bytes:  α\nsecond line [K1.1]";
    const privateSentinels = [
      "private-knowledge-base-id",
      "private-document-version-id",
      "private-included-passage",
      "private-generated-query",
      "private-vector-fingerprint",
      "private-read-receipt",
      "private-source-artifact-id",
      "private-source-id",
      "private-source-version-id",
      "private-source-locator",
      "private-secondary-base-id"
    ];
    const snapshot = buildPublicShareSnapshot({
      activeLeafMessageId: "knowledge-answer",
      messages: [{
        content: {
          blocks: [
            { text: answer, type: "text" },
            {
              includedText: privateSentinels[2],
              knowledgeBaseId: privateSentinels[0],
              locator: privateSentinels[9],
              provenance: [{
                source: {
                  artifactId: privateSentinels[6],
                  bindings: [
                    { baseName: "Primary", bindingOrdinal: 0, knowledgeBaseId: privateSentinels[0] },
                    {
                      baseName: "Mirror",
                      bindingOrdinal: 1,
                      knowledgeBaseId: privateSentinels[10]
                    }
                  ],
                  primaryBindingOrdinal: 0,
                  sourceId: privateSentinels[7],
                  sourceVersionId: privateSentinels[8]
                }
              }],
              sourceArtifactId: privateSentinels[6],
              sourceId: privateSentinels[7],
              sourceVersionId: privateSentinels[8],
              type: "knowledge_evidence"
            }
          ],
          knowledgeBindings: [{ vectorSpaceFingerprint: privateSentinels[4] }],
          knowledgeCitations: [{
            documentVersionId: privateSentinels[1],
            sourceArtifactId: privateSentinels[6],
            sourceId: privateSentinels[7],
            sourceVersionId: privateSentinels[8]
          }]
        },
        groundedAt: null,
        id: "knowledge-answer",
        knowledgeEvidence: {
          query: privateSentinels[3],
          readReceipt: {
            locator: privateSentinels[9],
            receipt: privateSentinels[5],
            resolvedSource: {
              sourceArtifactId: privateSentinels[6],
              sourceId: privateSentinels[7],
              sourceVersionId: privateSentinels[8]
            }
          },
          results: privateSentinels
        },
        parentMessageId: null,
        role: "assistant"
      }] as unknown as ShareSnapshotMessageInput[],
      title: "Knowledge answer"
    });

    expect(snapshot.messages[0]?.content.blocks).toEqual([{ text: answer, type: "text" }]);
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of privateSentinels) expect(serialized).not.toContain(privateValue);
  });

  it("strips every Memory surface both when creating and re-reading a stored share", () => {
    const answer = "Visible generated answer remains byte-for-byte.\nSecond line.";
    const privateSentinels = [
      "private-personal-context",
      "private-memory-binding",
      "private-memory-item",
      "private-attempt",
      "private-execution",
      "private-memory-event",
      "private-tool-receipt",
      "private-version-id",
      "private-source-chat"
    ];
    const created = buildPublicShareSnapshot({
      activeLeafMessageId: "answer-memory",
      messages: [{
        content: {
          blocks: [
            { text: answer, type: "text" },
            { receipt: privateSentinels[2], type: "memory_receipt" }
          ],
          personalContext: privateSentinels[0]
        },
        id: "answer-memory",
        memoryEvidence: {
          attempts: privateSentinels[3],
          bindings: privateSentinels[1],
          events: privateSentinels[5],
          executions: privateSentinels[4],
          sourceChatId: privateSentinels[8],
          toolReceipts: privateSentinels[6],
          versionId: privateSentinels[7]
        },
        parentMessageId: null,
        role: "assistant"
      }] as unknown as ShareSnapshotMessageInput[],
      title: "Memory-safe share"
    });
    const reread = projectPublicShareSnapshot({
      ...created,
      attempts: privateSentinels[3],
      messages: created.messages.map((message) => ({
        ...message,
        memoryReceipt: privateSentinels[1],
        content: {
          ...message.content,
          bindings: privateSentinels[2],
          blocks: message.content.blocks.map((block) => ({
            ...block,
            sourceChatId: privateSentinels[8],
            versionId: privateSentinels[7]
          }))
        }
      }))
    });

    expect(reread).toEqual(created);
    expect(reread?.messages[0]?.content.blocks).toEqual([{ text: answer, type: "text" }]);
    for (const privateValue of privateSentinels) {
      expect(JSON.stringify(created)).not.toContain(privateValue);
      expect(JSON.stringify(reread)).not.toContain(privateValue);
    }
  });
});
