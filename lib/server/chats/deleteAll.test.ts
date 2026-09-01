import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import {
  createDeleteAllPersonalChatsHandler,
  deleteAllPersonalChats,
  type DeleteAllPersonalChatsDeps,
  type PersonalChatLifecycleRow
} from "./deleteAll";
import { PermanentChatDeletionError } from "./permanentDeletion/service";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });

function row(id: string, overrides: Partial<PersonalChatLifecycleRow> = {}): PersonalChatLifecycleRow {
  return { archived: false, id, memoryMode: "NORMAL", sourceRevision: 3, ...overrides };
}

function deps(input: {
  chats: PersonalChatLifecycleRow[];
  enabled: boolean;
  failConfirm?: Record<string, PermanentChatDeletionError | Error>;
  failArchive?: Record<string, "stale" | Error>;
}) {
  const confirmed: string[] = [];
  const archived: unknown[] = [];
  const value: DeleteAllPersonalChatsDeps = {
    archive: async (archiveInput) => {
      archived.push(archiveInput);
      const failure = input.failArchive?.[archiveInput.chatId];
      if (failure instanceof Error) throw failure;
      if (failure === "stale") return { kind: "stale" };
      return {
        chat: {
          archived: true,
          id: archiveInput.chatId,
          memoryMode: "NORMAL",
          sourceRevision: archiveInput.expectedChatRevision + 1,
          updatedAt: new Date()
        },
        kind: "ok"
      };
    },
    capability: { enabled: input.enabled },
    deletion: {
      confirm: async (_userId, chatId) => {
        const failure = input.failConfirm?.[chatId];
        if (failure) throw failure;
        confirmed.push(chatId);
        return { status: "PENDING" as never };
      }
    },
    listPersonalChats: async () => input.chats,
    resolveAuth: auth.resolveAuth
  };
  return { archived, confirmed, deps: value };
}

describe("delete all personal chats", () => {
  it("admits every retained personal chat for permanent deletion when the capability is open", async () => {
    const { confirmed, deps: value } = deps({
      chats: [
        row("active"),
        row("archived", { archived: true, memoryMode: "EXCLUDED" }),
        row("temporary", { memoryMode: "TEMPORARY" }),
        row("busy")
      ],
      enabled: true,
      failConfirm: { busy: new PermanentChatDeletionError("active_run_in_progress") }
    });
    await expect(deleteAllPersonalChats(value, "user-1")).resolves.toEqual({
      archived: 1,
      permanentDeletionAvailable: true,
      scheduled: 2,
      skipped: 2
    });
    expect(confirmed).toEqual(["active", "archived"]);
  });

  it("archives only while permanent deletion stays feature-dark", async () => {
    const { archived, confirmed, deps: value } = deps({
      chats: [row("a"), row("b", { archived: true }), row("c"), row("d")],
      enabled: false,
      failArchive: { c: "stale", d: new ActiveRunConflictError() }
    });
    await expect(deleteAllPersonalChats(value, "user-1")).resolves.toEqual({
      archived: 1,
      permanentDeletionAvailable: false,
      scheduled: 0,
      skipped: 2
    });
    expect(confirmed).toEqual([]);
    expect(archived.map((call) => (call as { chatId: string }).chatId)).toEqual(["a", "c", "d"]);
    expect(archived[0]).toMatchObject({ archived: true, expectedChatRevision: 3, userId: "user-1" });
  });

  it("propagates unexpected failures instead of reporting a partial success", async () => {
    const { deps: value } = deps({
      chats: [row("a")],
      enabled: true,
      failConfirm: { a: new Error("database_unavailable") }
    });
    await expect(deleteAllPersonalChats(value, "user-1")).rejects.toThrow("database_unavailable");
  });

  it("requires a session and the literal confirmation", async () => {
    const { confirmed, deps: value } = deps({ chats: [row("a")], enabled: true });
    const POST = createDeleteAllPersonalChatsHandler(value);
    const request = (body: unknown, cookie = auth.cookie) => new Request("http://localhost/api/me/chats/delete-all", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    });
    expect((await POST(request({ confirmation: "delete all personal chats" }, ""))).status).toBe(401);
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ confirmation: "yes" }))).status).toBe(400);
    expect(confirmed).toEqual([]);
    const response = await POST(request({ confirmation: "delete all personal chats" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      archived: 1,
      permanentDeletionAvailable: true,
      scheduled: 1,
      skipped: 0
    });
  });
});
