import { describe, expect, it, vi } from "vitest";
import { createMemoryClientRefService } from "./clientRef";
import { loadMemoryRunActions } from "./runProjection";

const now = new Date("2026-08-21T08:00:00.000Z");
const key = Buffer.alloc(32, 0x4a);
const clientRefs = createMemoryClientRefService({ encryptionKey: () => key });

function memoryRef(runId = "run-1"): string {
  return clientRefs.mint("user-1", {
    allowedOperations: ["EDIT", "FORGET"],
    originatingRunId: runId,
    target: {
      exactItemId: "version-1",
      factId: "fact-1",
      factVersionId: "version-1",
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceChatId: null,
      sourceMessageIds: []
    }
  }, now);
}

function client(
  attempts: readonly unknown[],
  overrides: Readonly<{
    canonicalScope?: boolean;
    currentVersionId?: string;
    displayText?: string | null;
    expiresAt?: Date | null;
    factState?: string;
    personalRun?: boolean;
    versionState?: string;
  }> = {}
) {
  return {
    $queryRaw: vi.fn(async () => [{ id: "version-1" }]),
    memoryFact: { findMany: vi.fn(async () => [{
      currentVersionId: overrides.currentVersionId ?? "version-1",
      id: "fact-1",
      scopeId: "scope-1",
      state: overrides.factState ?? "ACTIVE"
    }]) },
    memoryFactVersion: { findMany: vi.fn(async () => [{
      contentPurgedAt: null,
      displayText: overrides.displayText === undefined
        ? "Prefers exact current text."
        : overrides.displayText,
      expiresAt: overrides.expiresAt ?? null,
      factId: "fact-1",
      id: "version-1",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      state: overrides.versionState ?? "ACTIVE"
    }]) },
    memoryScope: { findMany: vi.fn(async () =>
      overrides.canonicalScope === false ? [] : [{ id: "scope-1" }]) },
    memoryRetrievalAttempt: { findMany: vi.fn(async () => attempts) },
    modelRun: {
      findMany: vi.fn(async () => overrides.personalRun === false ? [] : [{ id: "run-1" }])
    }
  };
}

describe("Memory run action projection", () => {
  it("projects a committed save only while its exact version remains current", async () => {
    const ref = memoryRef();
    const actions = await loadMemoryRunActions(client([{
      budgetSnapshot: {
        memoryActionResult: {
          memoryRef: ref,
          operation: "SAVE",
          statement: "Prefers exact current text.",
          status: "COMMITTED"
        }
      },
      modelRunId: "run-1"
    }]) as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(actions.get("run-1")).toEqual({
      memoryRef: ref,
      operation: "SAVE",
      statement: "Prefers exact current text.",
      status: "COMMITTED"
    });
  });

  it("omits saved text after the fact is forgotten, superseded, expired, purged, or mismatched", async () => {
    const ref = memoryRef();
    const attempt = {
      budgetSnapshot: {
        memoryActionResult: {
          memoryRef: ref,
          operation: "UPDATE",
          statement: "Prefers exact current text.",
          status: "COMMITTED"
        }
      },
      modelRunId: "run-1"
    };
    for (const database of [
      client([attempt], { factState: "FORGOTTEN" }),
      client([attempt], { currentVersionId: "version-2" }),
      client([attempt], { expiresAt: new Date(now.getTime() - 1) }),
      client([attempt], { displayText: null }),
      client([attempt], { displayText: "Different private text." })
    ]) {
      const actions = await loadMemoryRunActions(database as never, {
        clientRefs,
        now,
        runIds: ["run-1"],
        userId: "user-1"
      });
      expect(actions.size).toBe(0);
    }
  });

  it("omits an action after its fact scope is no longer canonical global", async () => {
    const ref = memoryRef();
    const database = client([{
      budgetSnapshot: {
        memoryActionResult: {
          memoryRef: ref,
          operation: "SAVE",
          statement: "Prefers exact current text.",
          status: "COMMITTED"
        }
      },
      modelRunId: "run-1"
    }], { canonicalScope: false });

    const actions = await loadMemoryRunActions(database as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(actions.size).toBe(0);
    expect(database.memoryScope.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        assistantId: null,
        chatId: null,
        folderId: null,
        id: { in: ["scope-1"] },
        scopeType: "GLOBAL_USER",
        state: "ACTIVE",
        targetDisplaySnapshot: null,
        targetIdSnapshot: null,
        userId: "user-1"
      }
    });
  });

  it("never hydrates Personal Memory actions into a Project run", async () => {
    const ref = memoryRef();
    const database = client([{
      budgetSnapshot: {
        memoryActionResult: {
          memoryRef: ref,
          operation: "SAVE",
          statement: "Prefers exact current text.",
          status: "COMMITTED"
        }
      },
      modelRunId: "run-1"
    }], { personalRun: false });

    const actions = await loadMemoryRunActions(database as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(actions.size).toBe(0);
    expect(database.memoryRetrievalAttempt.findMany).not.toHaveBeenCalled();
  });

  it("drops an automatic action result after its Personal evidence becomes ineligible", async () => {
    const ref = memoryRef();
    const database = client([{
      budgetSnapshot: {
        memoryActionResult: {
          memoryRef: ref,
          operation: "SAVE",
          statement: "Prefers exact current text.",
          status: "COMMITTED"
        }
      },
      modelRunId: "run-1"
    }]);
    database.$queryRaw.mockResolvedValueOnce([]);

    const actions = await loadMemoryRunActions(database as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(actions.size).toBe(0);
  });

  it("keeps a committed forget acknowledgement but strips the deleted statement", async () => {
    const actions = await loadMemoryRunActions(client([{
      budgetSnapshot: {
        memoryActionResult: {
          operation: "FORGET",
          statement: "Deleted private statement.",
          status: "COMMITTED"
        }
      },
      modelRunId: "run-1"
    }]) as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(actions.get("run-1")).toEqual({
      operation: "FORGET",
      status: "COMMITTED"
    });
    expect(JSON.stringify(actions.get("run-1"))).not.toContain("Deleted private statement");
  });

  it("projects a this-chat-only save without inventing a reusable Memory reference", async () => {
    const actions = await loadMemoryRunActions(client([{
      budgetSnapshot: {
        memoryActionResult: {
          operation: "SAVE",
          statement: "Keep this preference in this chat only.",
          status: "THIS_CHAT_ONLY"
        }
      },
      modelRunId: "run-1"
    }]) as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(actions.get("run-1")).toEqual({
      operation: "SAVE",
      statement: "Keep this preference in this chat only.",
      status: "THIS_CHAT_ONLY"
    });
    expect(actions.get("run-1")).not.toHaveProperty("memoryRef");
  });

  it("drops raw identifiers and invalid shapes", async () => {
    const database = client([{
      budgetSnapshot: {
        memoryActionResult: {
          factId: "private-fact",
          operation: "SAVE",
          statement: "Do not project this.",
          status: "COMMITTED"
        }
      },
      modelRunId: "run-1"
    }]);
    const actions = await loadMemoryRunActions(database as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });
    expect(actions.size).toBe(0);
    expect(database.memoryRetrievalAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ modelRunId: { in: ["run-1"] }, userId: "user-1" })
      })
    );
  });

  it("preserves only the frozen replacement for an actionable ambiguous update", async () => {
    const firstRef = memoryRef();
    const secondRef = clientRefs.mint("user-1", {
      allowedOperations: ["EDIT", "FORGET"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "version-2",
        factId: "fact-2",
        factVersionId: "version-2",
        itemType: "FACT_VERSION",
        recallChunkId: null,
        sourceChatId: null,
        sourceMessageIds: []
      }
    }, now);
    const database = client([{
      budgetSnapshot: {
        memoryActionResult: {
          candidates: [firstRef, secondRef].map((memoryRef, index) => ({
            category: "other",
            createdAt: "2026-08-21T08:00:00.000Z",
            memoryRef,
            provenance: "SAVED",
            sensitivity: "NORMAL",
            statement: index === 0
              ? "Prefers exact current text."
              : "Second current statement."
          })),
          operation: "UPDATE",
          statement: "Use the classified replacement.",
          status: "AMBIGUOUS"
        }
      },
      modelRunId: "run-1"
    }]);
    database.$queryRaw.mockResolvedValueOnce([
      { id: "version-1" },
      { id: "version-2" }
    ]);
    database.memoryFact.findMany.mockResolvedValueOnce([{
      currentVersionId: "version-1",
      id: "fact-1",
      scopeId: "scope-1",
      state: "ACTIVE"
    }, {
      currentVersionId: "version-2",
      id: "fact-2",
      scopeId: "scope-1",
      state: "ACTIVE"
    }]);
    database.memoryFactVersion.findMany.mockResolvedValueOnce([{
      contentPurgedAt: null,
      displayText: "Prefers exact current text.",
      expiresAt: null,
      factId: "fact-1",
      id: "version-1",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      state: "ACTIVE"
    }, {
      contentPurgedAt: null,
      displayText: "Second current statement.",
      expiresAt: null,
      factId: "fact-2",
      id: "version-2",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      state: "ACTIVE"
    }]);

    const actions = await loadMemoryRunActions(database as never, {
      clientRefs,
      now,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(actions.get("run-1")).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ memoryRef: firstRef }),
        expect.objectContaining({ memoryRef: secondRef })
      ]),
      operation: "UPDATE",
      statement: "Use the classified replacement.",
      status: "AMBIGUOUS"
    });
  });
});
