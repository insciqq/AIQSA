import { describe, expect, it } from "vitest";
import { SAVED_SECRET_MARKER } from "../../redaction/savedSecrets";
import { chatSnapshot, longAnswer, text } from "./indexer.testFixtures";
import {
  buildChatSearchPassages,
  CHAT_SEARCH_PASSAGE_LIMITS,
  chatSearchContentHash,
  chatSearchMessageText,
  chatSearchPassageBody,
  chatSearchPassageTitle,
  chatSearchTitle,
  chatSearchTurns,
  chatSearchWindowSpans
} from "./passages";

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
const SAVED_VALUE = "tok_demo_7f3a9c21b8e4";

describe("past-chat passages", () => {
  it("makes one passage per turn of the active branch, with the title, both messages and the turn's files", () => {
    const passages = buildChatSearchPassages(chatSnapshot({
      title: "Trip planning",
      turns: [
        { question: "Which hotel did we pick in Rome?", answer: "The hotel near Termini.", questionFiles: ["itinerary.pdf"] },
        { question: "And the train?", answer: "The 9:10 Frecciarossa.", answerFiles: ["tickets.png", "tickets.png"] }
      ]
    }), []);
    expect(passages.map((passage) => [passage.userMessageId, passage.assistantMessageId, passage.ordinal])).toEqual([
      ["m-q0", "m-a0", 0], ["m-q1", "m-a1", 0]
    ]);
    expect(passages[0]!.text).toBe(
      "Chat: Trip planning\nFiles: itinerary.pdf\n\nUser: Which hotel did we pick in Rome?\n\nAssistant: The hotel near Termini.");
    expect(passages[1]!.text).toBe("Chat: Trip planning\nFiles: tickets.png\n\nUser: And the train?\n\nAssistant: The 9:10 Frecciarossa.");
    expect(passages[0]!.turnAt).toEqual(new Date(Date.UTC(2026, 10, 1, 12, 0)));
    expect(passages[0]!.contentHash).toBe(chatSearchContentHash(passages[0]!.text));
    expect(passages[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(chatSearchPassageBody(passages[1]!.text)).toBe("User: And the train?\n\nAssistant: The 9:10 Frecciarossa.");
  });

  it("cuts a long answer into overlapping windows that each name the question they answer", () => {
    const answer = longAnswer(300);
    const passages = buildChatSearchPassages(chatSnapshot({ turns: [{ answer, question: "Plan the whole trip, please." }] }), []);
    expect(passages.length).toBeGreaterThan(5);
    expect(passages.map((passage) => passage.ordinal)).toEqual(passages.map((_, index) => index));
    expect(new Set(passages.map((passage) => passage.contentHash)).size).toBe(passages.length);
    for (const [index, passage] of passages.entries()) {
      expect(passage.text.startsWith("Chat: Trip planning\n\n")).toBe(true);
      const body = chatSearchPassageBody(passage.text);
      expect(body.length).toBeLessThanOrEqual(CHAT_SEARCH_PASSAGE_LIMITS.windowMaxChars + 400);
      if (index === 0) expect(body.startsWith("User: Plan the whole trip, please.\n\nAssistant: Sentence 1 ")).toBe(true);
      else expect(body.startsWith("User: Plan the whole trip, please.\n\nAssistant: …")).toBe(true);
    }
    // Neighbouring windows overlap, and together they hold every sentence.
    const sentences = (value: string) => new Set(value.match(/Sentence \d+ /gu));
    for (let index = 1; index < passages.length; index += 1) {
      const shared = [...sentences(passages[index - 1]!.text)].filter((sentence) => sentences(passages[index]!.text).has(sentence));
      expect(shared.length).toBeGreaterThan(0);
    }
    const covered = new Set(passages.flatMap((passage) => [...sentences(passage.text)]));
    expect(covered.size).toBe(300);
  });

  it("keeps windows off redaction markers and surrogate pairs", () => {
    const body = `${"a".repeat(2_990)} [REDACTED:TOKEN] ${"😀".repeat(1_500)}`;
    const markers = [{ end: 2_991 + "[REDACTED:TOKEN]".length, start: 2_991 }];
    const spans = chatSearchWindowSpans(body, markers);
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(markers.some((marker) => span.end > marker.start && span.end < marker.end)).toBe(false);
      expect(markers.some((marker) => span.start > marker.start && span.start < marker.end)).toBe(false);
      for (const edge of [span.start, span.end]) {
        const code = body.charCodeAt(edge);
        expect(edge === body.length || code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }
    expect(spans.at(-1)!.end).toBe(body.length);
  });

  it("indexes only settled answers of the user's own turns, and a server-written turn's answer without its text", () => {
    const snapshot = chatSnapshot({ turns: [
      { answer: "Settled answer.", question: "Ordinary question" },
      { answer: "Half an answer", question: "Stopped question", status: "cancelled" },
      { answer: "Failed answer", question: "Failed question", status: "error" },
      { answer: "Still writing", question: "Streaming question", status: "streaming" },
      { answer: "Scheduled result", question: "Scheduled prompt", scheduledTaskPrompt: true },
      // A server-written kind the index does not list stays out until it is listed.
      { answer: "Unlisted answer", question: "Unlisted server turn", systemTurnKind: "unlisted_server_turn" },
      { answer: "Done after approval.", question: "Continue after approval", systemTurnKind: "mcp_approval_continuation" },
      { answer: "Sub-agents reported.", question: "Wake up", systemTurnKind: "subagent_callback" }
    ] });
    expect(chatSearchTurns(snapshot.path).map((turn) => turn.user.id)).toEqual(["m-q0", "m-q6", "m-q7"]);
    const passages = buildChatSearchPassages(snapshot, []);
    expect(passages.map((passage) => chatSearchPassageBody(passage.text))).toEqual([
      "User: Ordinary question\n\nAssistant: Settled answer.",
      "Assistant: Done after approval.",
      "Assistant: Sub-agents reported."
    ]);
  });

  it("follows only the active branch: a sibling answer and an edited-away question are not passages", () => {
    const snapshot = chatSnapshot({ turns: [{ answer: "First answer", question: "First question" }] });
    // The path is the active branch only; a turn whose answer is not the next path message is skipped.
    const detached = { ...snapshot, path: [snapshot.path[0]!, { ...snapshot.path[1]!, parentMessageId: "elsewhere" }] };
    expect(buildChatSearchPassages(detached, [])).toEqual([]);
    expect(buildChatSearchPassages({ ...snapshot, activeLeafMessageId: null }, [])).toEqual([]);
  });

  it("never lets a recognized secret or a saved secret value into a passage, its title or its file names", () => {
    const passages = buildChatSearchPassages(chatSnapshot({
      title: `Deploy with ${SAVED_VALUE}`,
      turns: [{
        answer: `Use ${SAVED_VALUE} as the demo token and never share ${GITHUB_TOKEN}.`,
        answerFiles: [`${GITHUB_TOKEN}.txt`],
        question: `My GitHub token is ${GITHUB_TOKEN}, the demo one ${SAVED_VALUE}`
      }]
    }), [SAVED_VALUE]);
    expect(passages).toHaveLength(1);
    const passage = passages[0]!.text;
    expect(passage).not.toContain(GITHUB_TOKEN);
    expect(passage).not.toContain(SAVED_VALUE);
    expect(passage).toContain(SAVED_SECRET_MARKER);
    expect(passage).toContain("[REDACTED:");
    expect(passage).toContain("as the demo token");
  });

  it("screens a multi-line saved value whatever line endings the text and the saved value use", () => {
    const crlf = "account=demo\r\npass=fixture-pass-42";
    const lf = "account=demo\npass=fixture-pass-42";
    // A file pasted with CRLF, saved with CRLF: matched before normalization changes either.
    expect(chatSearchMessageText(crlf, [crlf])).toBe(SAVED_SECRET_MARKER);
    expect(chatSearchMessageText(text(`Login:\r\n${crlf}\r\nThanks`), [crlf])).toBe(`Login:\n${SAVED_SECRET_MARKER}\nThanks`);
    // A client that already wrote LF, against the value saved with CRLF.
    expect(chatSearchMessageText(text(`Login:\n${lf}`), [crlf])).toBe(`Login:\n${SAVED_SECRET_MARKER}`);
    // A value saved with LF, against CRLF text.
    expect(chatSearchMessageText(text(`Login:\r\n${crlf}`), [lf])).toBe(`Login:\n${SAVED_SECRET_MARKER}`);
    const passages = buildChatSearchPassages(chatSnapshot({ turns: [{ answer: "Saved.", question: `Keep ${crlf} please` }] }), [crlf]);
    expect(passages.map((passage) => passage.text).join("\n")).not.toContain("fixture-pass-42");
  });

  it("screens saved values and recognized secrets together, so an overlap leaves no part of either", () => {
    const credentialUrl = "https://deploy-bot:fixture-pass-42@db.example.org";
    const tokenInValue = "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 DB_PASS=fixture-pass-42";
    // A saved value inside a recognized secret, and a recognized secret inside a saved value.
    expect(chatSearchMessageText(text(`Connect to ${credentialUrl} today`), ["deploy-bot"]))
      .toBe("Connect to [REDACTED:CREDENTIAL_URL] today");
    expect(chatSearchMessageText(text(`rotation ${tokenInValue} schedule`), [tokenInValue])).toBe(`rotation ${SAVED_SECRET_MARKER} schedule`);
    // Partial overlaps, either way round.
    expect(chatSearchMessageText(text(`x corp-prefix::${GITHUB_TOKEN} y`), ["corp-prefix::ghp_abcdefghij"])).toBe("x [REDACTED:TOKEN] y");
    expect(chatSearchMessageText(text(`use ${credentialUrl} lane-7 now`), ["db.example.org lane-7"]))
      .toBe("use [REDACTED:CREDENTIAL_URL] now");
    // With CRLF line endings, and with a control character inside the saved value.
    expect(chatSearchMessageText(text(`Login:\r\n${credentialUrl}\r\nThanks`), ["deploy-bot"]))
      .toBe("Login:\n[REDACTED:CREDENTIAL_URL]\nThanks");
    expect(chatSearchMessageText(text("key fixture\u0007pass-42 end"), ["fixture\u0007pass-42"])).toBe(`key ${SAVED_SECRET_MARKER} end`);
    const passages = buildChatSearchPassages(chatSnapshot({ turns: [{ answer: `Use ${credentialUrl}.`, question: `Is ${credentialUrl} right?` }] }),
      ["deploy-bot"]);
    for (const passage of passages) {
      expect(passage.text).not.toContain("fixture-pass-42");
      expect(passage.text).not.toContain("deploy-bot");
    }
  });

  it("keeps a secret that crosses a window boundary whole and redacted", () => {
    // The token starts just before the first window's target end, so a cut there would split it.
    const answer = `${"word ".repeat(590)}${GITHUB_TOKEN} ${"after ".repeat(500)}`;
    const passages = buildChatSearchPassages(chatSnapshot({ turns: [{ answer, question: "q" }] }), []);
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.text).not.toMatch(/ghp_[a-z0-9]{4,}/u);
      expect(passage.text).not.toContain("1234567890");
    }
  });

  it("strips control and bidirectional characters, and bounds one message's indexed text", () => {
    expect(chatSearchMessageText(text("left\u202eright\u0007 done\r\nnext"), [])).toBe("left right  done\nnext");
    const huge = chatSearchMessageText(text("x".repeat(CHAT_SEARCH_PASSAGE_LIMITS.messageIndexedChars * 3)), []);
    expect(huge.length).toBeLessThanOrEqual(CHAT_SEARCH_PASSAGE_LIMITS.messageIndexedChars + 2);
    expect(chatSearchMessageText("legacy plain string content", [])).toBe("legacy plain string content");
  });

  it("is deterministic, and a renamed chat changes every passage's text and hash (the title is embedded)", () => {
    const turns = [{ answer: "A", question: "Q" }, { answer: "B", question: "R" }];
    const first = buildChatSearchPassages(chatSnapshot({ title: "Old title", turns }), []);
    expect(buildChatSearchPassages(chatSnapshot({ title: "Old title", turns }), [])).toEqual(first);
    const renamed = buildChatSearchPassages(chatSnapshot({ title: "New title", turns }), []);
    expect(renamed.map((passage) => passage.contentHash)).not.toEqual(expect.arrayContaining(first.map((passage) => passage.contentHash)));
    expect(renamed.map((passage) => chatSearchPassageBody(passage.text))).toEqual(first.map((passage) => chatSearchPassageBody(passage.text)));
  });

  it("names a chat by what search holds of the first message its title was made from", () => {
    const saved = "DB_PASSWORD=fixture-pass-42\r\nDB_HOST=cache.example";
    const firstLine = "DB_PASSWORD=fixture-pass-42";
    const origin = (content: unknown) => ({ firstMessage: { content }, serverSet: true, withholdsMessages: false });
    const headerOf = (title: string, titleOrigin: Parameters<typeof chatSearchTitle>[1], values: readonly string[] = []) => {
      const passages = buildChatSearchPassages(chatSnapshot({ title, titleOrigin, turns: [{ answer: "Stored.", question: saved }] }), values);
      return passages[0]!.text.split("\n")[0];
    };
    // The fallback title is the first line of a message saved as a secret: the screened line takes its place everywhere.
    expect(chatSearchTitle(firstLine, origin(text(saved)), [saved])).toBe(SAVED_SECRET_MARKER);
    expect(headerOf(firstLine, origin(text(saved)), [saved])).toBe(`Chat: ${SAVED_SECRET_MARKER}`);
    expect(chatSearchTitle(`Branch: ${firstLine}`, origin(text(saved)), [saved])).toBe(`Branch: ${SAVED_SECRET_MARKER}`);
    // A title the model made from that turn, or one that does not hold the line, goes untitled.
    expect(chatSearchTitle("Database credentials", origin(text(saved)), [saved])).toBe("");
    // Nothing to screen: the stored title stays, and so does any title the owner set.
    expect(chatSearchTitle("Trip planning", origin(text("Where should we stay?")), [])).toBe("Trip planning");
    expect(chatSearchTitle(firstLine, { firstMessage: null, serverSet: false, withholdsMessages: false }, [saved])).toBe(firstLine);
  });

  it("leaves a chat untitled in search while it holds any message search never holds, whoever set the title", () => {
    // Server-set from the first message, a model title whose request went with its answer (now counted as the
    // owner's), and the owner's own rename: none is shown while the chat holds a withheld message.
    for (const withheld of [
      { firstMessage: null, serverSet: true, withholdsMessages: true },
      { firstMessage: null, serverSet: false, withholdsMessages: true }
    ]) {
      expect(chatSearchTitle("Notes about the reorg", withheld, [])).toBe("");
      const [passage] = buildChatSearchPassages(chatSnapshot({ title: "Notes about the reorg", titleOrigin: withheld,
        turns: [{ answer: "A", question: "Q" }] }), []);
      expect(passage!.text.split("\n")[0]).toBe("Chat:");
      expect(chatSearchPassageTitle(passage!.text)).toBe("");
    }
  });

  it("screens the title as it screens the turn's words, and reads it back from the header", () => {
    const passage = buildChatSearchPassages(chatSnapshot({ title: `Deploy  ${SAVED_VALUE}\twith ${GITHUB_TOKEN}`,
      turns: [{ answer: "A", question: "Q" }] }), [SAVED_VALUE])[0]!.text;
    expect(passage).not.toContain(SAVED_VALUE);
    expect(passage).not.toContain(GITHUB_TOKEN);
    expect(chatSearchPassageTitle(passage)).toMatch(/^Deploy \[REDACTED:SAVED_SECRET\] with \[REDACTED/u);
    expect(chatSearchPassageTitle(buildChatSearchPassages(chatSnapshot({ title: "Rome", turns: [{ answer: "A", question: "Q",
      questionFiles: ["plan.pdf"] }] }), [])[0]!.text)).toBe("Rome");
    expect(chatSearchPassageTitle("User: no header")).toBe("");
  });

  it("screens a header in one pass and whole, so neither a saved login nor a clip leaves a password behind", () => {
    const address = "https://deploy-bot:fixture-pass-42@db.example.org";
    const textsOf = (title: string, files: readonly string[] = []) => buildChatSearchPassages(chatSnapshot({ title,
      turns: [{ answer: "Done.", question: "Go", questionFiles: files }] }), ["deploy-bot"]).map((passage) => passage.text).join("\n");
    // A saved login taken out first would leave an address no longer recognized, and its password with it.
    expect(textsOf(`Deploy ${address}`)).not.toContain("fixture-pass-42");
    // Clipped first, the address would no longer be recognized and its start would stay.
    const long = textsOf(`${"x".repeat(270)} ${address}`, [`${"y".repeat(220)} ${address}.txt`]);
    expect(long).not.toContain("fixture-p");
    expect(long).not.toContain("deploy-bot");
  });

  it("keeps a turn with only files, and drops one with nothing to search", () => {
    const passages = buildChatSearchPassages(chatSnapshot({ turns: [
      { answer: "", question: "", questionFiles: ["scan.jpg"] },
      { answer: "", question: "" }
    ] }), []);
    expect(passages.map((passage) => passage.text)).toEqual(["Chat: Trip planning\nFiles: scan.jpg\n\n"]);
  });
});
