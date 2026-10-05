import { describe, expect, it } from "vitest";
import type { RunFollowupState } from "../contracts/runFollowups";
import type { ChatExportSource, ChatExportSourceMessage } from "./chatExportDocument";
import { chatPrintDocument, chatPrintPath } from "./chatPrintDocument";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });

function message(
  key: string,
  parentKey: string | null,
  role: "assistant" | "user",
  content: unknown,
  extra: Partial<ChatExportSourceMessage> = {}
): ChatExportSourceMessage {
  return { content, createdAt: at(Number(key.replace(/\D/gu, "")) || 0), key, modelId: null, parentKey, provider: null, role,
    status: "complete", ...extra };
}

const followups: RunFollowupState = {
  available: false,
  entries: [{ author: "Owner", createdAt: at(30).toISOString(), delivery: "delivered", id: "f1", ordinal: 1,
    precedingText: "Черновик ответа", text: "Добавь откат" }]
} as RunFollowupState;

/** A 60-message chain (older than one thread page) plus an abandoned sibling branch. */
function source(): ChatExportSource {
  const chain: ChatExportSourceMessage[] = [];
  for (let index = 1; index <= 60; index += 1) {
    chain.push(message(`m${index}`, index === 1 ? null : `m${index - 1}`, index % 2 ? "user" : "assistant",
      text(index === 1 ? "Самое первое сообщение" : `Сообщение ${index}`)));
  }
  chain[58] = message("m59", "m58", "user", { blocks: [
    { text: "Посмотри картинку", type: "text" },
    { alt: "Схема склада", attachmentId: "att-image", type: "image" },
    { attachmentId: "att-missing", type: "image" },
    { attachmentId: "att-file", fileName: "plan.pdf", type: "file" },
    { attachmentId: "att-gone", fileName: "old.docx", type: "file" }
  ] });
  chain[59] = message("m60", "m59", "assistant", { blocks: [
    { text: "Готово: $$E=mc^2$$", type: "text" },
    { attachmentId: "gen-copied", type: "image" }
  ] }, { followups });
  return {
    attachments: new Map([
      ["att-image", { byteSize: 10, mimeType: "image/png", name: "warehouse.png" }],
      ["att-file", { byteSize: 20, mimeType: "application/pdf", name: "plan.pdf" }],
      ["gen-copied", { byteSize: 30, mimeType: "image/png", name: "generated.png" }]
    ]),
    chat: { activeLeafKey: "m60", archived: false, createdAt: at(0), pinned: false, title: "Печать · отчёт", updatedAt: at(61) },
    messages: [...chain, message("m99", "m1", "assistant", text("Abandoned branch"))]
  };
}

describe("chat print document", () => {
  it("renders the whole visible branch, oldest message first, without other branches", () => {
    const document = chatPrintDocument(source(), new Map(), new Date("2026-10-05T08:00:00.000Z"));
    expect(document.title).toBe("Печать · отчёт");
    expect(document.fileBaseName).toBe("печать-отчёт-2026-10-05");
    expect(document.createdAt).toBe(at(0).toISOString());
    expect(document.updatedAt).toBe(at(61).toISOString());
    expect(document.turns[0]).toEqual({ files: [], images: [], role: "user", text: "Самое первое сообщение" });
    expect(document.turns.map((turn) => turn.text)).not.toContain("Abandoned branch");
    // 60 messages plus the follow-up's partial answer and question.
    expect(document.turns).toHaveLength(62);
  });

  it("shows durable follow-ups as the Markdown export does, before the answer", () => {
    const turns = chatPrintDocument(source(), new Map(), at(0)).turns.slice(-3);
    expect(turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["assistant", "Partial answer before follow-up:\n\nЧерновик ответа"],
      ["user", "Follow-up 1:\n\nДобавь откат"],
      ["assistant", "Готово: $$E=mc^2$$"]
    ]);
  });

  it("lists this chat's images, generated images of the answer's run once, and file names", () => {
    const generated = new Map([["m60", [
      { attachmentId: "gen-copied", height: 512, width: 512 },
      { attachmentId: "gen-run", height: 768, width: 1024 }
    ]]]);
    const turns = chatPrintDocument(source(), generated, at(0)).turns;
    const question = turns.at(-4)!;
    expect(question.images).toEqual([{ attachmentId: "att-image", label: "Схема склада" }]);
    expect(question.files).toEqual(["plan.pdf", "old.docx"]);
    expect(turns.at(-1)!.images).toEqual([
      { attachmentId: "gen-copied", label: "Image attachment" },
      { attachmentId: "gen-run", height: 768, label: "Generated image", width: 1024 }
    ]);
  });

  it("reads a stopped empty answer as Stopped. and an unreachable leaf as an empty branch", () => {
    const stopped: ChatExportSource = {
      ...source(),
      chat: { ...source().chat, activeLeafKey: "a2" },
      messages: [message("q1", null, "user", text("Вопрос")), message("a2", "q1", "assistant", { blocks: [] }, { status: "cancelled" })]
    };
    expect(chatPrintDocument(stopped, new Map(), at(0)).turns.at(-1)?.text).toBe("Stopped.");
    const orphan: ChatExportSource = { ...stopped, chat: { ...stopped.chat, activeLeafKey: "missing" } };
    expect(chatPrintDocument(orphan, new Map(), at(0)).turns).toEqual([]);
  });

  it("builds an encoded print address for any chat id", () => {
    expect(chatPrintPath("chat a/1")).toBe("/print/c/chat%20a%2F1");
  });
});
