import { describe, expect, it } from "vitest";
import { buildPublicShareSnapshot, type ShareSnapshotMessageInput } from "./shareSnapshot";

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
});
