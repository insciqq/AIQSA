import { describe, expect, it } from "vitest";
import { chatSearchWithheldMessages, clearChatSearchExclusions, copyChatSearchExclusions } from "./exclusions";
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

  it("withhold both messages of a turn when either is excluded, and nothing else, as reads show the branch", () => {
    const messages = new Map([
      ["q0", { parentMessageId: null, role: "user" }], ["a0", { parentMessageId: "q0", role: "assistant" }],
      ["q1", { parentMessageId: "a0", role: "user" }], ["a1", { parentMessageId: "q1", role: "assistant" }],
      ["wake", { parentMessageId: "a1", role: "user" }], ["a2", { parentMessageId: "wake", role: "assistant" }]
    ]);
    // A read omits the wake-up from what it shows; its answer still answers it.
    const path = ["q0", "a0", "q1", "a1", "a2"];
    const withheld = (excluded: readonly string[]) => [...chatSearchWithheldMessages(path, messages, new Set(excluded))].sort();
    expect(withheld([])).toEqual([]);
    expect(withheld(["q0"])).toEqual(["a0", "q0"]);
    expect(withheld(["a1"])).toEqual(["a1", "q1"]);
    expect(withheld(["wake"])).toEqual(["a2", "wake"]);
    // The indexer's passages agree: either message of a turn takes the turn, and no other one.
    const snapshot = chatSnapshot({ turns });
    const indexed = (excluded: string) => buildChatSearchPassages({ ...snapshot,
      path: snapshot.path.filter((message) => message.id !== excluded) }, []).map((passage) => [passage.userMessageId,
      passage.assistantMessageId]).flat();
    const all = snapshot.path.map((message) => message.id);
    for (const excluded of all) {
      const branchWithheld = chatSearchWithheldMessages(all, new Map(snapshot.path.map((message) => [message.id, message])),
        new Set([excluded]));
      expect(indexed(excluded).sort()).toEqual(all.filter((id) => !branchWithheld.has(id)).sort());
    }
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
