import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeTelegramMessage } from "@/tests/support/fakeTelegramBotApi";
import { buttonData, createBridgeHarness, createFakeGateway, type FakeRun } from "@/tests/support/telegramChatBridge";
import type { ThreadArtifactSummary } from "../../../contracts/chats";
import type { MemoryNoteOfferCard } from "../../../contracts/memoryNote";
import type { SecretChangeCard } from "../../../contracts/resourceChanges";
import type { SkillSaveCard } from "../../../contracts/skillSaves";
import failureCodes from "../../observability/failureCodes.json";
import { TELEGRAM_COPY } from "../copy";
import { renderTelegramAnswer } from "../render";
import type { TelegramChangeGateway } from "./gateway";
import {
  createTelegramChanges, TELEGRAM_CHANGE_CALLBACK_KINDS, TELEGRAM_CHANGE_COPY, TELEGRAM_CHANGE_LOG_CODES, type TelegramChanges
} from "./index";
import type { TelegramChangeOperation, TelegramChangeOutcome } from "./plan";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const SECRET_ID = "0b6f3c1e-4a2d-4c5e-9f10-2a3b4c5d6e7f";
const VERSION_ID = "1c7a4d2f-5b3e-4d6f-8a21-3b4c5d6e7f80";
const secret = (overrides: Partial<SecretChangeCard> = {}): SecretChangeCard => ({
  version: 1, resource: "secret", action: "created", secretId: SECRET_ID, versionId: VERSION_ID, name: "Synthetic token", kind: "env",
  envNames: ["SYNTHETIC_TOKEN"], previousName: null, valueReplaced: false, proposalId: null, ...overrides
});
const skillSave: SkillSaveCard = {
  version: 1, saveId: "save-1", skillId: "skill-2", revisionId: "revision-1", name: "Release notes", outcome: "created", fromRevision: null,
  toRevision: 1, changeNote: null, copiedFrom: null, published: false, files: [{ change: "added", executable: false, path: "SKILL.md" }],
  diffs: [], scheduledTasks: [], scheduledTasksTruncated: false
};

type Act = Readonly<{ operation: TelegramChangeOperation; userId: string }>;

function harness() {
  const aiqsa = createFakeGateway({ autoAnswer: null });
  let changes: TelegramChanges | null = null;
  const h = createBridgeHarness({ bridge: { publish: async (event, context) => { await changes?.listener(event, context); } }, gateway: aiqsa });
  closers.push(h.close);
  const user = h.fake.inject.addUser({ firstName: "Alex" });
  h.link(user);
  const acts: Act[] = [];
  const outcomes: TelegramChangeOutcome[] = [];
  const gateway: TelegramChangeGateway = {
    async act(input) {
      acts.push(input);
      return outcomes.shift() ?? { kind: "done" };
    }
  };
  changes = createTelegramChanges({
    access: h.access, gateway, sessions: h.sessions,
    // The read the bridge makes is the owner's own: another user's run is not found.
    answer: async (input) => {
      const run = aiqsa.runs.find((candidate) => candidate.id === input.runId);
      return run && run.userId === input.userId ? { artifactSummary: run.summary, chatId: run.chatId } : null;
    }
  });
  for (const kind of TELEGRAM_CHANGE_CALLBACK_KINDS) h.registry.registerCallback(kind, changes.callbacks[kind]);
  return { ...h, acts, changes, outcomes, user };
}

type Harness = ReturnType<typeof harness>;

/** A Telegram turn whose answer made these changes, settled and delivered. */
async function answered(h: Harness, summary: Partial<ThreadArtifactSummary>): Promise<FakeRun> {
  const before = h.aiqsa.runs.length;
  await h.deliver(h.fake.inject.text(h.user, "save my token"));
  h.bridge.conversation.flush();
  await vi.waitFor(() => expect(h.aiqsa.runs.length).toBeGreaterThan(before));
  const run = h.aiqsa.runs.at(-1)!;
  run.summary = { citations: [], reasoningText: [], sources: [], ...summary };
  run.token("Saved it.");
  run.complete();
  await h.settle();
  await h.changes.idle();
  return run;
}

const changeMessages = (h: Harness) => h.fake.botMessages(h.user.id).filter((message) => message.rich_message !== undefined &&
  JSON.stringify(message.rich_message).includes("“"));

function message(h: Harness, id: number): FakeTelegramMessage {
  return h.fake.botMessages(h.user.id).find((entry) => entry.message_id === id)!;
}

function keyboardTexts(entry: FakeTelegramMessage): string[][] {
  return ((entry.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard ?? [])
    .map((row) => row.map((button) => button.text));
}

/** Presses a button by its text, or by callback data kept from before the message changed. */
async function press(h: Harness, target: FakeTelegramMessage, text: string, from = h.user, data = buttonData(target, text)) {
  const update = h.fake.inject.callback(from, target.message_id, data);
  await h.deliver(update);
  await h.changes.idle();
  return { queryId: (update.callback_query as { id: string }).id };
}

describe("Telegram change messages", () => {
  it("shows each change after the answer, with Undo where the web card has it and Confirm and Cancel for a proposal", async () => {
    const h = harness();
    await answered(h, {
      resourceChanges: [secret(), secret({ action: "updated", previousName: "Old token" }), secret({ action: "delete_proposed", proposalId: "proposal-1" })],
      skillSaves: [skillSave]
    });
    const messages = changeMessages(h);
    expect(messages).toHaveLength(4);
    expect(h.fake.botMessages(h.user.id).at(-5)!.rich_message).toEqual(renderTelegramAnswer("Saved it.").messages[0]);
    expect(messages[0]!.rich_message).toEqual({
      blocks: [
        { text: { text: "Secret saved", type: "bold" }, type: "paragraph" },
        { text: "“Synthetic token” · Environment · SYNTHETIC_TOKEN", type: "paragraph" }
      ],
      skip_entity_detection: true
    });
    expect(keyboardTexts(messages[0]!)).toEqual([[TELEGRAM_CHANGE_COPY.undo]]);
    expect(keyboardTexts(messages[1]!)).toEqual([]);
    expect(JSON.stringify(messages[2]!.rich_message)).toContain("Delete secret?");
    expect(keyboardTexts(messages[2]!)).toEqual([["Delete secret", "Keep secret"]]);
    expect(keyboardTexts(messages[3]!)).toEqual([[TELEGRAM_CHANGE_COPY.undo]]);
    // A reply to a change message continues its chat, as a reply to the answer does.
    expect(h.messageRefs.refs).toContainEqual(expect.objectContaining({ telegramMessageId: messages[0]!.message_id }));
    // A button names no resource: its data is a random row id.
    expect(JSON.stringify(messages[0]!.reply_markup)).not.toContain(SECRET_ID);
    expect(h.acts).toEqual([]);
  });

  it("an answer without changes sends no change message, and a second delivery of one run sends none twice", async () => {
    const h = harness();
    const run = await answered(h, {});
    expect(changeMessages(h)).toHaveLength(0);
    run.summary = { citations: [], reasoningText: [], resourceChanges: [secret()], sources: [] };
    const context = { bot: h.session, chatId: run.chatId, linkId: "link-user-1", runId: run.id, source: "recovery" as const, telegramChatId: h.user.id,
      userId: "user-1" };
    await h.changes.listener({ artifactSummary: run.summary, messageIds: [], sent: true, status: "complete", type: "delivered" }, context);
    await h.changes.listener({ artifactSummary: run.summary, messageIds: [], sent: true, status: "complete", type: "delivered" }, context);
    await h.changes.idle();
    expect(changeMessages(h)).toHaveLength(1);
  });

  it("Undo sends the web card's request as the link's user, shows what it did and is used up", async () => {
    const h = harness();
    await answered(h, { resourceChanges: [secret()] });
    const [saved] = changeMessages(h);
    const data = buttonData(saved, TELEGRAM_CHANGE_COPY.undo);
    const pressed = await press(h, saved!, TELEGRAM_CHANGE_COPY.undo);
    expect(h.acts).toEqual([{ operation: { kind: "secret_delete", secretId: SECRET_ID, versionId: VERSION_ID }, userId: "user-1" }]);
    expect(h.fake.callbackAnswer(pressed.queryId)).toMatchObject({ answered: true, text: undefined });
    const undone = message(h, saved!.message_id);
    expect(JSON.stringify(undone.rich_message)).toContain("Undone: the secret is deleted.");
    expect(JSON.stringify(undone.rich_message)).toContain("Secret removed");
    expect(undone.reply_markup).toBeUndefined();

    // Pressed again (an old client still shows it): used up, nothing sent twice.
    const again = await press(h, saved!, TELEGRAM_CHANGE_COPY.undo, h.user, data);
    expect(h.fake.callbackAnswer(again.queryId)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });
    expect(h.acts).toHaveLength(1);
  });

  it("Undo of a change made since, or of something already gone, says so and changes nothing", async () => {
    const h = harness();
    h.outcomes.push({ kind: "changed" });
    await answered(h, { resourceChanges: [secret()], skillSaves: [skillSave] });
    const [saved, save] = changeMessages(h);
    await press(h, saved!, TELEGRAM_CHANGE_COPY.undo);
    expect(JSON.stringify(message(h, saved!.message_id).rich_message))
      .toContain("Undo is not available: the secret changed after this, and that change is kept.");
    h.outcomes.push({ kind: "missing" });
    await press(h, save!, TELEGRAM_CHANGE_COPY.undo);
    expect(h.acts.at(-1)).toEqual({ operation: { kind: "skill_save_undo", saveId: "save-1", skillId: "skill-2" }, userId: "user-1" });
    expect(JSON.stringify(message(h, save!.message_id).rich_message)).toContain("Undo is not available: this Skill or save no longer exists.");
    expect(message(h, save!.message_id).reply_markup).toBeUndefined();
  });

  it("Confirm deletes through the route; Cancel keeps it; either uses up both buttons", async () => {
    const h = harness();
    await answered(h, { resourceChanges: [secret({ action: "delete_proposed", proposalId: "proposal-1" }),
      secret({ action: "delete_proposed", proposalId: "proposal-2", secretId: "2d8b5e3a-6c4f-4e7a-9b32-4c5d6e7f8091", name: "Second token" })] });
    const [first, second] = changeMessages(h);
    const keep = buttonData(first, "Keep secret");
    const confirm = buttonData(second, "Delete secret");

    await press(h, first!, "Delete secret");
    expect(h.acts).toEqual([{ operation: { kind: "secret_delete", secretId: SECRET_ID, versionId: VERSION_ID }, userId: "user-1" }]);
    expect(JSON.stringify(message(h, first!.message_id).rich_message)).toContain("Secret deleted");
    // Its Cancel went with it.
    const late = await press(h, first!, "Keep secret", h.user, keep);
    expect(h.fake.callbackAnswer(late.queryId)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });
    expect(JSON.stringify(message(h, first!.message_id).rich_message)).toContain("Secret deleted");

    await press(h, second!, "Keep secret");
    expect(h.acts).toHaveLength(1);
    expect(JSON.stringify(message(h, second!.message_id).rich_message)).toContain("Secret kept");
    expect(message(h, second!.message_id).reply_markup).toBeUndefined();
    // A Confirm after Cancel deletes nothing.
    const after = await press(h, second!, "Delete secret", h.user, confirm);
    expect(h.fake.callbackAnswer(after.queryId)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });
    expect(h.acts).toHaveLength(1);
  });

  it("asks about a memory note offer: Remember accepts it, No thanks closes it through the same route, either uses up both", async () => {
    const h = harness();
    const offer = (offerId: string): MemoryNoteOfferCard => ({ version: 1, resource: "memory_note", action: "offered", offerId, operation: "add",
      before: null, after: "Prefers short answers." });
    await answered(h, { resourceChanges: [offer("offer-1"), offer("offer-2")] });
    const [first, second] = changeMessages(h);
    expect(JSON.stringify(first!.rich_message)).toContain("Remember this for future chats?");
    expect(keyboardTexts(first!)).toEqual([["Remember", "No thanks"]]);
    const noThanks = buttonData(first, "No thanks");

    await press(h, first!, "Remember");
    expect(h.acts).toEqual([{ operation: { decision: "accept", kind: "memory_note_offer", offerId: "offer-1" }, userId: "user-1" }]);
    expect(JSON.stringify(message(h, first!.message_id).rich_message)).toContain("Remembered");
    const late = await press(h, first!, "No thanks", h.user, noThanks);
    expect(h.fake.callbackAnswer(late.queryId)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });

    await press(h, second!, "No thanks");
    expect(h.acts.at(-1)).toEqual({ operation: { decision: "dismiss", kind: "memory_note_offer", offerId: "offer-2" }, userId: "user-1" });
    expect(h.acts).toHaveLength(2);
    expect(JSON.stringify(message(h, second!.message_id).rich_message)).toContain("Not saved");
    expect(message(h, second!.message_id).reply_markup).toBeUndefined();
  });

  it("offers the buttons again after a failure, and the new ones work", async () => {
    const h = harness();
    h.outcomes.push({ kind: "failed" });
    await answered(h, { resourceChanges: [secret({ action: "delete_proposed", proposalId: "proposal-1" })] });
    const [proposal] = changeMessages(h);
    await press(h, proposal!, "Delete secret");
    const retry = message(h, proposal!.message_id);
    expect(JSON.stringify(retry.rich_message)).toContain("The secret could not be deleted. Try again.");
    expect(keyboardTexts(retry)).toEqual([["Delete secret", "Keep secret"]]);
    await press(h, retry, "Delete secret");
    expect(h.acts).toHaveLength(2);
    expect(JSON.stringify(message(h, proposal!.message_id).rich_message)).toContain("Secret deleted");
  });

  it("does nothing for another account's press, and nothing for a run that is not the button user's own", async () => {
    const h = harness();
    await answered(h, { resourceChanges: [secret({ action: "delete_proposed", proposalId: "proposal-1" })] });
    const [proposal] = changeMessages(h);
    const stranger = h.fake.inject.addUser({ firstName: "Mallory" });
    h.link(stranger, "user-2");
    const foreign = await press(h, proposal!, "Delete secret", stranger);
    expect(h.fake.callbackAnswer(foreign.queryId)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });
    expect(h.acts).toEqual([]);
    expect(keyboardTexts(message(h, proposal!.message_id))).toEqual([["Delete secret", "Keep secret"]]);
    expect(h.fake.botMessages(stranger.id)).toEqual([]);

    // The run now belongs to someone else (the owner's read finds nothing): nothing is done, the message says so.
    (h.aiqsa.runs[0] as { userId: string }).userId = "user-2";
    await press(h, proposal!, "Delete secret");
    expect(h.acts).toEqual([]);
    expect(JSON.stringify(message(h, proposal!.message_id).rich_message ?? message(h, proposal!.message_id).text))
      .toContain(TELEGRAM_CHANGE_COPY.unavailable);
  });

  it("does nothing once Telegram access is off, and a change no longer in the answer is unavailable", async () => {
    const h = harness();
    const run = await answered(h, { resourceChanges: [secret()] });
    const [saved] = changeMessages(h);
    h.setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "deactivated" } as never);
    await press(h, saved!, TELEGRAM_CHANGE_COPY.undo);
    expect(h.acts).toEqual([]);
    h.setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "active" });

    run.summary = { citations: [], reasoningText: [], sources: [] };
    const fresh = await answered(h, { resourceChanges: [secret({ versionId: "2d8b5e3a-6c4f-4e7a-9b32-4c5d6e7f8091" })] });
    fresh.summary = { citations: [], reasoningText: [], sources: [] };
    const latest = changeMessages(h).at(-1)!;
    await press(h, latest, TELEGRAM_CHANGE_COPY.undo);
    expect(h.acts).toEqual([]);
    expect(JSON.stringify(message(h, latest.message_id).rich_message)).toContain(TELEGRAM_CHANGE_COPY.unavailable);
  });

  it("registers its codes among the sorted failure codes", () => {
    const registry = failureCodes as string[];
    for (const code of TELEGRAM_CHANGE_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});
