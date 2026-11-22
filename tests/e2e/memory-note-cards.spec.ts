import { expect, test, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { MemoryNote, MemoryNoteChangeCard, MemoryNoteOfferCard } from "../../lib/contracts/memoryNote";
import type { PastChatSource } from "../../lib/contracts/pastChats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Settled answers whose cards changed or offered to change the user's memory note, and an answer that searched past
// chats, over mocked owner routes (`app/api/me/memory/{note,offers}`).
const model = matrixCatalog.models[0]!;
const sizes = [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }];
const at = "2026-11-22T09:00:00.000Z";

test.setTimeout(240_000);

const added: MemoryNoteChangeCard = { version: 1, resource: "memory_note", action: "added", revision: 3,
  before: null, after: "Answer in short bullet points.", previousText: "I work on the billing team." };
const offerAdd: MemoryNoteOfferCard = { version: 1, resource: "memory_note", action: "offered", offerId: "offer-add",
  operation: "add", before: null, after: "Compare prices as a table: model, price, shop, rating." };
const offerReplace: MemoryNoteOfferCard = { version: 1, resource: "memory_note", action: "offered", offerId: "offer-replace",
  operation: "replace", before: "Answer in English.", after: "Answer in Russian." };
const offerStale: MemoryNoteOfferCard = { version: 1, resource: "memory_note", action: "offered", offerId: "offer-stale",
  operation: "remove", before: "Use imperial units.", after: null };

type Turn = Readonly<{ ask: string; answer: string; cards?: readonly (MemoryNoteChangeCard | MemoryNoteOfferCard)[]; pastChats?: readonly PastChatSource[] }>;

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null,
  extra: Partial<ChatMessageWire> = {}): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: at, status: "complete", citationMessageId: null, errorMessage: null,
    modelId: role === "assistant" ? model.modelId : null, modelRunId: null, provider: role === "assistant" ? model.provider : null, ...extra };
}

function chatFixture(chatId: string, title: string, turns: readonly Turn[]): ChatDetailWire {
  const messages: ChatMessageWire[] = [];
  turns.forEach((turn, index) => {
    messages.push(message(`${chatId}-${index + 1}-question`, "user", turn.ask, messages.at(-1)?.id ?? null));
    messages.push(message(`${chatId}-${index + 1}-answer`, "assistant", turn.answer, `${chatId}-${index + 1}-question`, {
      artifactSummary: { citations: [], reasoningText: [], sources: [], workDurationMs: 1_800,
        ...(turn.cards ? { resourceChanges: [...turn.cards] } : {}),
        // The answer's past-chat sources, as the chat load projects them (`ThreadArtifactSummary.pastChatSources`).
        ...(turn.pastChats ? { pastChatSources: [...turn.pastChats] } : {}) } as ChatMessageWire["artifactSummary"]
    }));
  });
  const leaf = messages.at(-1)!.id;
  return {
    assistant: null, id: chatId, title, createdAt: at, updatedAt: at, activeLeafMessageId: leaf, defaultModelId: model.modelId,
    defaultProvider: model.provider, folderId: null, pinned: false, messageCount: messages.length, usageStats: null,
    contextStats: { approximateActiveBranchInputTokens: 600 },
    pageInfo: { activeLeafMessageId: leaf, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: at },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages
  };
}

async function prepare(page: Page, chats: readonly ChatDetailWire[], destination: string) {
  let note: MemoryNote = { text: "I work on the billing team.\nAnswer in short bullet points.", revision: 3, lastChangedBy: "agent", updatedAt: at };
  const writes: Array<Readonly<{ path: string; body: unknown }>> = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMatrixCatalogFixture(page, { chats: [...chats], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  for (const chat of chats) {
    await page.route(`**/api/chats/${chat.id}`, (route) => route.fulfill({ json: { chat } }));
  }
  await page.route("**/api/me/memory/note", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: note });
    const update = route.request().postDataJSON() as { text: string; revision: number };
    writes.push({ path: "/api/me/memory/note", body: update });
    if (update.revision !== note.revision) return route.fulfill({ status: 409, json: { error: "memory_note_conflict" } });
    note = { text: update.text, revision: note.revision + 1, lastChangedBy: "user", updatedAt: at };
    return route.fulfill({ json: note });
  });
  await page.route(/\/api\/me\/memory\/offers\/[^/?]+$/u, (route) => {
    const offerId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "GET") return route.fulfill({ json: { offerId, state: "pending", decidedAt: null } });
    const { decision } = route.request().postDataJSON() as { decision: "accept" | "dismiss" };
    writes.push({ path: `/api/me/memory/offers/${offerId}`, body: { decision } });
    if (offerId === offerStale.offerId) return route.fulfill({ status: 409, json: { error: "memory_note_offer_stale" } });
    if (decision === "dismiss") return route.fulfill({ json: { offer: { offerId, state: "dismissed", decidedAt: at }, change: null } });
    const previousText = note.text;
    note = { text: `${note.text}\n${offerAdd.after}`, revision: note.revision + 1, lastChangedBy: "user", updatedAt: at };
    const change: MemoryNoteChangeCard = { version: 1, resource: "memory_note", action: "added", revision: note.revision,
      before: null, after: offerAdd.after, previousText };
    return route.fulfill({ json: { offer: { offerId, state: "accepted", decidedAt: at }, change } });
  });
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  await signInWithLocalToken(page, destination);
  return { writes, note: () => note };
}

test("a note change card shows what went in and undoes it, at every size in both themes", async ({ page }, info) => {
  const chat = chatFixture("note-change-chat", "Answer style", [
    { ask: "Remember: answer in short bullet points.", answer: "Saved to your memory.", cards: [added] }
  ]);
  const { writes, note } = await prepare(page, [chat], `/c/${chat.id}`);
  const card = page.locator("[data-resource='memory_note']");
  await expect(card).toContainText("Added to memory · from your next message", { timeout: 30_000 });
  await expect(card.getByLabel("Added to memory", { exact: true }).locator("dd")).toHaveText("Answer in short bullet points.");
  const undo = card.getByRole("button", { name: "Undo this change to your memory" });
  await captureState(page, info, "memory-note-change", { anchor: card, sizes, atEachSize: async () => {
    await expectWithinViewport(page, undo);
    await expectWithinViewport(page, card.getByRole("link", { name: "Open Memory" }));
    await expectNoHorizontalOverflow(page);
  } });
  await undo.click();
  await expect(card.getByRole("status")).toContainText("Your note is back to the previous text from your next message.");
  expect(writes).toEqual([{ path: "/api/me/memory/note", body: { text: added.previousText, revision: added.revision } }]);
  expect(note().text).toBe(added.previousText);
});

test("offer cards are accepted, dismissed or no longer fit, at every size in both themes", async ({ page }, info) => {
  const chat = chatFixture("note-offer-chat", "Price comparisons", [
    { ask: "Compare prices as a table from now on.", answer: "Here is the table.", cards: [offerAdd] },
    { ask: "Answer in Russian.", answer: "Хорошо.", cards: [offerReplace] },
    { ask: "I switched to metric.", answer: "Noted.", cards: [offerStale] }
  ]);
  const { writes } = await prepare(page, [chat], `/c/${chat.id}`);
  const cards = page.locator("[data-resource='memory_note']");
  await expect(cards).toHaveCount(3, { timeout: 30_000 });
  const accept = cards.filter({ hasText: offerAdd.after! });
  const dismiss = cards.filter({ hasText: offerReplace.after! });
  const stale = cards.filter({ hasText: offerStale.before! });
  await expect(accept).toContainText("Remember this for future chats?");
  await captureState(page, info, "memory-note-offer", { anchor: accept, sizes, atEachSize: async () => {
    await expectWithinViewport(page, accept.getByRole("button", { name: "Remember" }));
    await expectWithinViewport(page, accept.getByRole("button", { name: "No thanks" }));
    await expectNoHorizontalOverflow(page);
  } });

  await accept.getByRole("button", { name: "Remember" }).click();
  const remembered = page.getByRole("listitem", { name: "Remembered" });
  await expect(remembered.getByRole("button", { name: "Undo this change to your memory" })).toBeVisible();
  await dismiss.getByRole("button", { name: "No thanks" }).click();
  await expect(page.getByRole("listitem", { name: "Not changed" })).toBeVisible();
  await stale.getByRole("button", { name: "Forget" }).click();
  const noLonger = page.getByRole("listitem", { name: "No longer fits" });
  await expect(noLonger.getByRole("link", { name: "Open Memory" })).toHaveAttribute("href", "/?library=memory");
  await captureState(page, info, "memory-note-offers-settled", { anchor: noLonger, sizes, atEachSize: async () => {
    await expectNoHorizontalOverflow(page);
  } });
  expect(writes.map((write) => write.body)).toEqual([{ decision: "accept" }, { decision: "dismiss" }, { decision: "accept" }]);

  await remembered.getByRole("button", { name: "Undo this change to your memory" }).click();
  await expect(page.getByRole("listitem", { name: "Change undone" }).getByRole("status"))
    .toContainText("Your note is back to the previous text");
});

test("a past-chat source opens its chat at the message", async ({ page }, info) => {
  const earlier = chatFixture("earlier-deploy-chat", "Staging deploy checklist", [
    { ask: "What did we decide about the staging deploy?", answer: "Deploy after the migration check." },
    { ask: "And the rollback?", answer: "Keep the previous image tagged." }
  ]);
  const source: PastChatSource = { chatId: earlier.id, chatTitle: earlier.title, date: at, messageId: `${earlier.id}-2-question`,
    excerpt: "User: And the rollback?\nAssistant: Keep the previous image tagged." };
  const chat = chatFixture("past-chat-answer", "Rollback plan", [
    { ask: "How did we plan the rollback last time?", answer: "You planned to keep the previous image tagged.", pastChats: [source] }
  ]);
  await prepare(page, [chat, earlier], `/c/${chat.id}`);
  const fold = page.getByTestId("tool-activity-disclosure");
  await fold.locator(":scope > summary").click({ timeout: 30_000 });
  const sources = page.getByTestId("past-chat-sources");
  await expect(sources.locator(":scope > summary")).toHaveText("Past chats · 1");
  await sources.locator(":scope > summary").click();
  const link = sources.getByRole("link", { name: "Open Staging deploy checklist at this message" });
  await expect(link).toHaveAttribute("href", `/c/${earlier.id}?message=${source.messageId}`);
  await captureState(page, info, "past-chat-source", { anchor: link, sizes, atEachSize: async () => {
    await expectWithinViewport(page, link);
    await expectNoHorizontalOverflow(page);
  } });
  await link.click();
  // The shell opens the chat at the message the way a search match opens; it may leave the `?message=` hint out of the address.
  await expect(page).toHaveURL(new RegExp(`/c/${earlier.id}(\\?message=${source.messageId})?$`, "u"));
  await expect(page.locator(`[data-message-id="${source.messageId}"]`)).toBeVisible();
});
