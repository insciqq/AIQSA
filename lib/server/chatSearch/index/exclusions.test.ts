import { describe, expect, it } from "vitest";
import { clearChatSearchExclusions, copyChatSearchExclusions } from "./exclusions";
import { chatSnapshot } from "./indexer.testFixtures";
import { recordingTransaction } from "./markRecorder.testFixtures";
import { buildChatSearchPassages } from "./passages";

const turns = [
  { answer: "Book the river hotel.", question: "Which hotel before the reset?" },
  { answer: "Take the 9:10 train.", question: "Which train after it?" },
  { answer: "Pack an umbrella.", question: "What to pack?" }
];

describe("messages past-chat search never holds", () => {
  it("leave their whole turn out of the passages once the store drops them from the path, and no other turn", () => {
    const snapshot = chatSnapshot({ turns });
    const questions = (path: typeof snapshot.path) => buildChatSearchPassages({ ...snapshot, path }, [])
      .map((passage) => passage.userMessageId);
    expect(questions(snapshot.path)).toEqual(["m-q0", "m-q1", "m-q2"]);
    // The store's path query leaves an excluded message out (`./prismaStore.ts`): either message of a turn takes it.
    expect(questions(snapshot.path.filter((message) => message.id !== "m-q0"))).toEqual(["m-q1", "m-q2"]);
    expect(questions(snapshot.path.filter((message) => message.id !== "m-a1"))).toEqual(["m-q0", "m-q2"]);
    expect(questions(snapshot.path.filter((message) => !["m-q0", "m-a0", "m-q1"].includes(message.id)))).toEqual(["m-q2"]);
    const passages = buildChatSearchPassages({ ...snapshot, path: snapshot.path.filter((message) => message.id !== "m-a0") }, []);
    expect(passages.map((passage) => passage.text).join("\n")).not.toContain("before the reset");
  });

  it("follow a branch copy message by message, and only from the owner's own source chat", async () => {
    const recorder = recordingTransaction();
    await copyChatSearchExclusions(recorder.tx, {
      copies: [["source-q", "copy-q"], ["source-a", "copy-a"]], copyChatId: "copy-chat", sourceChatId: "source-chat",
      userId: "owner-1"
    });
    expect(recorder.calls).toEqual([expect.objectContaining({
      name: "$executeRaw",
      text: expect.stringMatching(/^INSERT INTO "ChatSearchExcludedMessage" .* INNER JOIN "ChatSearchExcludedMessage" AS excluded/u),
      values: ["copy-chat", "owner-1", ["source-q", "source-a"], ["copy-q", "copy-a"], "source-chat", "owner-1"]
    })]);

    const empty = recordingTransaction();
    await expect(copyChatSearchExclusions(empty.tx, { copies: [], copyChatId: "copy-chat", sourceChatId: "source-chat",
      userId: "owner-1" })).resolves.toBe(0);
    expect(empty.calls).toEqual([]);
  });

  it("are all lifted for the chat a Resume names", async () => {
    const recorder = recordingTransaction();
    await clearChatSearchExclusions(recorder.tx, { chatId: "chat-1" });
    expect(recorder.calls).toEqual([expect.objectContaining({
      name: "$executeRaw", text: "DELETE FROM \"ChatSearchExcludedMessage\" WHERE \"chatId\" = ?", values: ["chat-1"]
    })]);
  });
});
