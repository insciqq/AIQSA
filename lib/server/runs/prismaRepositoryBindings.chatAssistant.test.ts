import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { applyAcceptedChatAssistant } from "./prismaRepositoryBindings";
import { AssistantRunConflictError } from "./runRepositoryContract";

function chatClient(row: { assistantId: string | null; assistantOverrides: unknown } | null) {
  const update = vi.fn(async () => ({}));
  return {
    tx: {
      chat: {
        findUnique: vi.fn(async () => row),
        update
      }
    } as unknown as Parameters<typeof applyAcceptedChatAssistant>[0],
    update
  };
}

describe("accepted chat Assistant binding", () => {
  it("binds an unbound chat and stores the run's overrides", async () => {
    const { tx, update } = chatClient({ assistantId: null, assistantOverrides: null });
    await applyAcceptedChatAssistant(tx, "chat-1", {
      assistantId: "assistant-1", bind: true, overridesPatch: { search: { mode: "off" } }
    });

    expect(update).toHaveBeenCalledWith({
      data: { assistantId: "assistant-1", assistantOverrides: { search: { mode: "off" } } },
      where: { id: "chat-1" }
    });
  });

  it("keeps a chat already bound to the same Assistant and writes nothing without a change", async () => {
    const { tx, update } = chatClient({ assistantId: "assistant-1", assistantOverrides: { search: { mode: "off" } } });
    await applyAcceptedChatAssistant(tx, "chat-1", { assistantId: "assistant-1", bind: true, overridesPatch: {} });
    await applyAcceptedChatAssistant(tx, "chat-1", { assistantId: "assistant-1", bind: false, overridesPatch: {} });

    expect(update).not.toHaveBeenCalled();
  });

  it("clears fixed rows and stored controls when the model changes", async () => {
    const { tx, update } = chatClient({
      assistantId: "assistant-1",
      assistantOverrides: { controls: { temperature: 0.9 }, model: { mode: "model", modelId: "old" }, search: { mode: "off" } }
    });
    await applyAcceptedChatAssistant(tx, "chat-1", {
      assistantId: "assistant-1", bind: false,
      overridesPatch: { model: { mode: "model", modelId: "new" }, search: null }
    });

    expect(update).toHaveBeenCalledWith({
      data: { assistantOverrides: { model: { mode: "model", modelId: "new" } } },
      where: { id: "chat-1" }
    });
  });

  it("stores no overrides once every row is cleared", async () => {
    const { tx, update } = chatClient({ assistantId: "assistant-1", assistantOverrides: { search: { mode: "off" } } });
    await applyAcceptedChatAssistant(tx, "chat-1", { assistantId: "assistant-1", bind: false, overridesPatch: { search: null } });

    expect(update).toHaveBeenCalledWith({ data: { assistantOverrides: Prisma.DbNull }, where: { id: "chat-1" } });
  });

  it.each([
    [{ assistantId: "assistant-2", assistantOverrides: null }, true],
    [{ assistantId: "assistant-2", assistantOverrides: null }, false],
    [{ assistantId: null, assistantOverrides: null }, false],
    [{ assistantId: null, assistantOverrides: { assistantDeleted: true } }, true],
    [null, false]
  ])("refuses a chat whose binding changed since preparation (%j, bind %s)", async (row, bind) => {
    const { tx, update } = chatClient(row);
    await expect(applyAcceptedChatAssistant(tx, "chat-1", { assistantId: "assistant-1", bind, overridesPatch: {} }))
      .rejects.toBeInstanceOf(AssistantRunConflictError);
    expect(update).not.toHaveBeenCalled();
  });

  it("turns a serialization failure into the retried provenance conflict", async () => {
    const { tx, update } = chatClient({ assistantId: null, assistantOverrides: null });
    update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("deadlock", {
      clientVersion: "test", code: "P2010", meta: { code: "40P01" }
    }));

    await expect(applyAcceptedChatAssistant(tx, "chat-1", { assistantId: "assistant-1", bind: true, overridesPatch: {} }))
      .rejects.toMatchObject({ name: "AssistantProvenanceSerializationError" });
  });
});
