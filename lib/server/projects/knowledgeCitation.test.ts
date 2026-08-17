import { describe, expect, it, vi } from "vitest";
import { resolveProjectKnowledgeCitation } from "./knowledgeCitation";

const passage = {
  annRank: 1,
  baseName: "Engineering handbook",
  bindingOrdinal: 0,
  chunkId: "chunk-1",
  chunkIndex: 0,
  documentId: "document-1",
  documentVersionId: "document-version-1",
  documentVersionNumber: 1,
  fileName: "retrieval-policy.pdf",
  ftsRank: null,
  ftsScore: null,
  fusedScore: 1 / 61,
  handle: "K1.1",
  includedText: "The accepted Project passage.",
  includedTextBytes: Buffer.byteLength("The accepted Project passage.", "utf8"),
  knowledgeBaseId: "base-1",
  page: 18,
  sourceTextBytes: Buffer.byteLength("The accepted Project passage.", "utf8"),
  textTruncated: false,
  vectorDistance: 0.2,
  vectorScore: 0.8
};

function client(input: Readonly<{ baseVisible?: boolean; projectVisible?: boolean }> = {}) {
  const modelRunFindFirst = vi.fn().mockResolvedValue({
    id: "run-1",
    knowledgeRuns: [{ results: [passage] }]
  });
  const knowledgeBaseFindFirst = vi.fn().mockResolvedValue(
    input.baseVisible === false ? null : { id: "base-1" }
  );
  return {
    knowledgeBaseFindFirst,
    modelRunFindFirst,
    value: {
      knowledgeBase: { findFirst: knowledgeBaseFindFirst },
      modelRun: { findFirst: modelRunFindFirst },
      project: {
        findUnique: vi.fn().mockResolvedValue(input.projectVisible === false ? null : {
          accessRevision: 3,
          grants: [{ group: null, groupId: null, role: "VIEWER", userId: "member-1" }],
          id: "project-1",
          instructionsRevision: 2,
          memoryRevision: 4,
          policyRevision: 5,
          status: "ACTIVE"
        })
      },
      user: {
        findFirst: vi.fn().mockResolvedValue({ groups: [], id: "member-1" })
      },
      userGroup: { findMany: vi.fn().mockResolvedValue([]) }
    }
  };
}

const request = {
  assistantMessageId: "assistant-message-1",
  chatId: "chat-1",
  handle: "K1.1",
  projectId: "project-1",
  userId: "member-1"
};

describe("Project Knowledge citation authorization", () => {
  it("returns only stored accepted passage text after current Project and base access", async () => {
    const fixture = client();
    await expect(resolveProjectKnowledgeCitation(fixture.value as never, request)).resolves.toEqual({
      baseName: passage.baseName,
      fileName: passage.fileName,
      handle: passage.handle,
      page: passage.page,
      text: passage.includedText,
      textTruncated: passage.textTruncated
    });
    expect(fixture.modelRunFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        assistantMessageId: request.assistantMessageId,
        chatId: request.chatId,
        projectRunBinding: { is: { projectId: request.projectId } }
      })
    }));
    expect(fixture.knowledgeBaseFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        archivedAt: null,
        id: passage.knowledgeBaseId,
        projectBindings: { some: { projectId: request.projectId } }
      })
    }));
  });

  it("does not inspect stored evidence after Project access is lost", async () => {
    const fixture = client({ projectVisible: false });
    await expect(resolveProjectKnowledgeCitation(fixture.value as never, request)).resolves.toBeNull();
    expect(fixture.modelRunFindFirst).not.toHaveBeenCalled();
  });

  it("does not expose old evidence after the Knowledge binding or entitlement is gone", async () => {
    const fixture = client({ baseVisible: false });
    await expect(resolveProjectKnowledgeCitation(fixture.value as never, request)).resolves.toBeNull();
  });
});
