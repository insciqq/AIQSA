import { describe, expect, it, vi } from "vitest";
import type { ChatExportSource } from "../lib/domain/chatExportDocument";
import { readDiscordChat, type DiscordChatRepository } from "./discord-chat";

const CHAT_ID = "6f5c2b9e-0000-4000-8000-000000000001";

function source(): ChatExportSource {
  const at = (minutes: number) => new Date(Date.parse("2026-11-12T09:00:00.000Z") + minutes * 60_000);
  return {
    attachments: new Map([["att-1", { byteSize: 10, mimeType: "application/pdf", name: "plan.pdf" }]]),
    chat: { activeLeafKey: "a2", archived: false, createdAt: at(0), pinned: false, title: "Release status", updatedAt: at(5) },
    messages: [
      { content: { blocks: [{ text: "What is the release status?", type: "text" }, { attachmentId: "att-1", type: "file", fileName: "plan.pdf" }] },
        createdAt: at(0), key: "q1", modelId: null, parentKey: null, provider: null, role: "user", status: "complete" },
      { content: { blocks: [{ text: "It ships Friday.", type: "text" }] }, createdAt: at(1), key: "a1", modelId: "m", parentKey: "q1",
        provider: "fake", role: "assistant", status: "complete" },
      // An earlier answer on another branch is not printed.
      { content: { blocks: [{ text: "Old branch answer", type: "text" }] }, createdAt: at(1), key: "a1-old", modelId: "m", parentKey: "q1",
        provider: "fake", role: "assistant", status: "complete" },
      { content: { blocks: [{ text: "And the dates?", type: "text" }] }, createdAt: at(2), key: "q2", modelId: null, parentKey: "a1",
        provider: null, role: "user", status: "complete" },
      { content: { blocks: [] }, createdAt: at(3), key: "a2", modelId: "m", parentKey: "q2", provider: "fake", role: "assistant", status: "cancelled" }
    ]
  };
}

function repository(owner: Awaited<ReturnType<DiscordChatRepository["conversationOwner"]>>): DiscordChatRepository & Readonly<{
  loadChat: ReturnType<typeof vi.fn<DiscordChatRepository["loadChat"]>>;
}> {
  return {
    conversationOwner: async () => owner,
    loadChat: vi.fn<DiscordChatRepository["loadChat"]>(async () => source())
  };
}

describe("scripts/discord-chat.ts", () => {
  it("prints the active branch of a Discord conversation's chat: role, time and text, files by name", async () => {
    const repo = repository({ service: true, userId: "svc_1" });
    const outcome = await readDiscordChat(repo, CHAT_ID);
    expect(repo.loadChat).toHaveBeenCalledWith({ chatId: CHAT_ID, userId: "svc_1" });
    expect(outcome).toEqual({
      kind: "printed",
      text: [
        `Discord chat ${CHAT_ID}: Release status`,
        "4 messages on the active branch",
        "",
        "[user] 2026-11-12T09:00:00.000Z",
        "What is the release status?",
        "Files: plan.pdf",
        "",
        "[assistant] 2026-11-12T09:01:00.000Z",
        "It ships Friday.",
        "",
        "[user] 2026-11-12T09:02:00.000Z",
        "And the dates?",
        "",
        "[assistant] 2026-11-12T09:03:00.000Z (cancelled)",
        ""
      ].join("\n")
    });
    expect(JSON.stringify(outcome)).not.toContain("Old branch answer");
  });

  it("refuses every other chat the same way, before reading it", async () => {
    for (const owner of [null, { service: false, userId: "person-1" }]) {
      const repo = repository(owner);
      expect(await readDiscordChat(repo, CHAT_ID)).toEqual({ kind: "refused" });
      expect(repo.loadChat).not.toHaveBeenCalled();
    }
    const unreadable = { conversationOwner: async () => ({ service: true, userId: "svc_1" }), loadChat: async () => null };
    expect(await readDiscordChat(unreadable, CHAT_ID)).toEqual({ kind: "refused" });
    const conversationOwner = vi.fn(async () => ({ service: true, userId: "svc_1" }));
    expect(await readDiscordChat({ conversationOwner, loadChat: async () => source() }, "../etc/passwd")).toEqual({ kind: "refused" });
    expect(conversationOwner).not.toHaveBeenCalled();
  });
});
