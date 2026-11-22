// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_NOTE_MAX_CHARACTERS,
  memoryLegacySuggestionPageSchema,
  memoryNoteErrorResponseSchema,
  memoryNoteOfferDecisionResultSchema,
  memoryNoteOfferStatusSchema,
  memoryNoteSchema,
  memoryNoteUndoUpdate,
  memorySwitchesSchema
} from "@/lib/contracts/memoryNote";
import { fakeMemoryNoteDb } from "./fakeMemoryNoteDb.testFixtures";
import { createMemoryNoteHandlers } from "./handlers";
import { createMemoryNoteService } from "./service";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const SAVED_TOKEN = "synthetic-saved-value-0123456789";

function setup() {
  const fake = fakeMemoryNoteDb({ activeUsers: ["alice", "bob"] });
  const service = createMemoryNoteService({ db: fake.db, repository: fake.repository,
    savedSecrets: async (userId) => userId === "alice" ? [SAVED_TOKEN] : [] });
  /** The routes as the browser and Telegram call them, signed in as `userId`. */
  const routes = (userId: string | null, status = "active") => createMemoryNoteHandlers({
    resolveAuth: async () => userId ? ({ user: { id: userId, status }, userId }) as never : null, service
  });
  return { ...fake, routes, service };
}

const request = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost${path}`, body === undefined ? { method }
  : { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method });
async function answer(response: Response) {
  return { body: await response.json() as Record<string, unknown>, status: response.status };
}

let test: ReturnType<typeof setup>;
beforeEach(() => {
  test = setup();
});

describe("the memory note routes", () => {
  it("authenticate the active user before anything", async () => {
    expect(await answer(await test.routes(null).noteGET(request("/api/me/memory/note")))).toEqual({ body: { error: "unauthorized" }, status: 401 });
    expect(await answer(await test.routes("alice", "disabled").notePUT(request("/api/me/memory/note", "PUT", { revision: 0, text: "x" }))))
      .toEqual({ body: { error: "forbidden" }, status: 403 });
    expect(test.state.notes.size).toBe(0);
  });

  it("read a never-saved note as empty, then save the whole text under the revision the editor read", async () => {
    const routes = test.routes("alice");
    const empty = await answer(await routes.noteGET(request("/api/me/memory/note")));
    expect(empty).toEqual({ body: { lastChangedBy: null, revision: 0, text: "", updatedAt: null }, status: 200 });
    const saved = await answer(await routes.notePUT(request("/api/me/memory/note", "PUT", { revision: 0, text: "Call me Sam." })));
    expect(saved.status).toBe(200);
    expect(memoryNoteSchema.parse(saved.body)).toMatchObject({ lastChangedBy: "user", revision: 1, text: "Call me Sam." });
    const edited = await answer(await routes.notePUT(request("/api/me/memory/note", "PUT", { revision: 1, text: "Call me Sam.\nUse tables." })));
    expect(edited.body).toMatchObject({ revision: 2, text: "Call me Sam.\nUse tables." });
    // The same text writes nothing.
    expect((await answer(await routes.notePUT(request("/api/me/memory/note", "PUT", { revision: 2, text: "Call me Sam.\nUse tables." })))).body)
      .toMatchObject({ revision: 2 });
    // Clearing keeps the row, so revisions keep counting.
    expect((await answer(await routes.notePUT(request("/api/me/memory/note", "PUT", { revision: 2, text: "" })))).body)
      .toMatchObject({ revision: 3, text: "" });
  });

  it("refuse a stale save visibly and never overwrite", async () => {
    test.note("alice", "Edited elsewhere.", 4);
    const stale = await answer(await test.routes("alice").notePUT(request("/api/me/memory/note", "PUT", { revision: 3, text: "Mine." })));
    expect(stale).toEqual({ body: { error: "memory_note_conflict" }, status: 409 });
    const neverSaved = await answer(await test.routes("alice").notePUT(request("/api/me/memory/note", "PUT", { revision: 0, text: "Mine." })));
    expect(neverSaved.status).toBe(409);
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 4, text: "Edited elsewhere." });
  });

  it("refuse a text over the limit or holding a credential, naming why", async () => {
    const routes = test.routes("alice");
    const long = await answer(await routes.notePUT(request("/api/me/memory/note", "PUT", { revision: 0, text: "x".repeat(MEMORY_NOTE_MAX_CHARACTERS + 1) })));
    expect(long).toEqual({ body: { error: "memory_note_invalid" }, status: 400 });
    for (const text of ["GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyzAB", `Staging key ${SAVED_TOKEN}`]) {
      const refused = await answer(await routes.notePUT(request("/api/me/memory/note", "PUT", { revision: 0, text })));
      expect(refused.status).toBe(400);
      expect(memoryNoteErrorResponseSchema.parse(refused.body)).toMatchObject({ error: "memory_note_invalid", reason: "secret" });
      expect(refused.body.message).toContain("Settings › Secrets");
    }
    // Bob's saved values are his own: the same text is ordinary for him.
    expect((await test.routes("bob").notePUT(request("/api/me/memory/note", "PUT", { revision: 0, text: `Staging key ${SAVED_TOKEN}` }))).status)
      .toBe(200);
    for (const body of [{ text: "x" }, { revision: 0, text: "x", extra: true }, { revision: -1, text: "x" }, "x"]) {
      expect((await routes.notePUT(request("/api/me/memory/note", "PUT", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(test.state.notes.get("alice")).toBeUndefined();
  });

  it("undo a change card through the same guarded save, and refuse it once anything changed the note", async () => {
    test.note("alice", "Use tables.\nAnswer in Russian.", 2, "agent");
    const card = { action: "added", after: "Answer in Russian.", before: null, previousText: "Use tables.", resource: "memory_note", revision: 2,
      version: 1 } as const;
    const current = memoryNoteSchema.parse((await answer(await test.routes("alice").noteGET(request("/api/me/memory/note")))).body);
    const undo = memoryNoteUndoUpdate(card, current)!;
    expect((await answer(await test.routes("alice").notePUT(request("/api/me/memory/note", "PUT", undo)))).body)
      .toMatchObject({ lastChangedBy: "user", revision: 3, text: "Use tables." });
    // The same card again: the note moved on, so the browser sends nothing, and a request built earlier is refused.
    expect(memoryNoteUndoUpdate(card, { revision: 3 })).toBeNull();
    expect((await test.routes("alice").notePUT(request("/api/me/memory/note", "PUT", undo))).status).toBe(409);
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 3, text: "Use tables." });
  });

  it("read and change the three switches, each defaulting to on", async () => {
    const routes = test.routes("alice");
    expect((await answer(await routes.preferencesGET(request("/api/me/memory/preferences")))).body)
      .toEqual({ memoryEnabled: true, memorySuggestionsEnabled: true, pastChatSearchEnabled: true });
    const changed = await answer(await routes.preferencesPATCH(request("/api/me/memory/preferences", "PATCH", { memorySuggestionsEnabled: false })));
    expect(memorySwitchesSchema.parse(changed.body)).toEqual({ memoryEnabled: true, memorySuggestionsEnabled: false, pastChatSearchEnabled: true });
    for (const body of [{}, { memoryEnabled: "no" }, { decay: true }]) {
      expect((await routes.preferencesPATCH(request("/api/me/memory/preferences", "PATCH", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(test.state.settings.get("bob")).toBeUndefined();
  });
});

describe("an offer's decision", () => {
  it("accepts once: applies the offer to the current note, closes it and answers with the change card; a repeat changes nothing", async () => {
    test.note("alice", "Use tables.", 1);
    const offerId = test.offer("alice", "add", null, "Prefers short answers.");
    const routes = test.routes("alice");
    const accepted = await answer(await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }), offerId));
    expect(accepted.status).toBe(200);
    const result = memoryNoteOfferDecisionResultSchema.parse(accepted.body);
    expect(result).toMatchObject({ change: { action: "added", after: "Prefers short answers.", before: null, previousText: "Use tables.", revision: 2 },
      offer: { offerId, state: "accepted" } });
    expect(test.state.notes.get("alice")).toMatchObject({ lastChangedBy: "user", revision: 2, text: "Use tables.\nPrefers short answers." });
    const again = await answer(await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }), offerId));
    expect(again.body).toEqual({ change: null, offer: result.offer });
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 2 });
    expect(memoryNoteOfferStatusSchema.parse((await answer(await routes.offerGET(request(`/api/me/memory/offers/${offerId}`), offerId))).body))
      .toEqual(result.offer);
    // No thanks after Remember is the other decision.
    expect((await answer(await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "dismiss" }), offerId))))
      .toEqual({ body: { error: "memory_note_offer_stale" }, status: 409 });
  });

  it("refuses an offer whose edit assembles a credential in the note as it is now, keeping it pending", async () => {
    test.note("alice", "Staging: https://staging.example.org/", 1);
    const offerId = test.offer("alice", "replace", "staging.example.org", "demo:fixture-pass@staging.example.org");
    const refused = await answer(await test.routes("alice").offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }),
      offerId));
    expect(refused.body).toMatchObject({ error: "memory_note_invalid", reason: "secret" });
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 1, text: "Staging: https://staging.example.org/" });
    expect(test.state.offers.find((offer) => offer.id === offerId)).toMatchObject({ state: "pending" });
  });

  it("dismisses an offer without touching the note, and then cannot accept it", async () => {
    test.note("alice", "Use tables.", 1);
    const offerId = test.offer("alice", "add", null, "Prefers short answers.");
    const routes = test.routes("alice");
    const dismissed = await answer(await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "dismiss" }), offerId));
    expect(dismissed.body).toMatchObject({ change: null, offer: { offerId, state: "dismissed" } });
    expect((await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "dismiss" }), offerId)).status).toBe(200);
    expect((await answer(await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }), offerId))).body)
      .toEqual({ error: "memory_note_offer_stale" });
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 1, text: "Use tables." });
  });

  it("applies a replacement to the note as it is when the user accepts, and refuses it visibly once the passage is gone", async () => {
    test.note("alice", "Answer in English.\nUse tables.", 1);
    const replace = test.offer("alice", "replace", "Answer in English.", "Answer in Russian.");
    const remove = test.offer("alice", "remove", "Use tables.", null);
    const routes = test.routes("alice");
    // The note changed after the offer, but the passage is still there once.
    test.note("alice", "Call me Sam.\nAnswer in English.\nUse tables.", 2);
    const accepted = memoryNoteOfferDecisionResultSchema.parse((await answer(await routes.offerPOST(
      request(`/api/me/memory/offers/${replace}`, "POST", { decision: "accept" }), replace))).body);
    expect(accepted.change).toMatchObject({ action: "replaced", after: "Answer in Russian.", before: "Answer in English.", revision: 3 });
    expect(test.state.notes.get("alice")?.text).toBe("Call me Sam.\nAnswer in Russian.\nUse tables.");
    // Then the user removed the line the other offer removes.
    test.note("alice", "Call me Sam.\nAnswer in Russian.", 4);
    expect(await answer(await routes.offerPOST(request(`/api/me/memory/offers/${remove}`, "POST", { decision: "accept" }), remove)))
      .toEqual({ body: { error: "memory_note_offer_stale" }, status: 409 });
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 4, text: "Call me Sam.\nAnswer in Russian." });
    expect(test.state.offers.find((offer) => offer.id === remove)).toMatchObject({ decidedAt: null, state: "pending" });
  });

  it("refuses an offer that no longer fits the note with its size, keeping it pending, and one while Memory is off", async () => {
    test.note("alice", "x".repeat(MEMORY_NOTE_MAX_CHARACTERS - 5), 1);
    const offerId = test.offer("alice", "add", null, "Prefers short answers.");
    const routes = test.routes("alice");
    const full = await answer(await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }), offerId));
    expect(full).toEqual({ body: { characters: MEMORY_NOTE_MAX_CHARACTERS + 18, error: "memory_note_too_long", limit: MEMORY_NOTE_MAX_CHARACTERS },
      status: 409 });
    test.note("alice", "Short.", 2);
    await routes.preferencesPATCH(request("/api/me/memory/preferences", "PATCH", { memoryEnabled: false }));
    expect(await answer(await routes.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }), offerId)))
      .toEqual({ body: { error: "memory_disabled" }, status: 409 });
    expect(test.state.offers.find((offer) => offer.id === offerId)).toMatchObject({ state: "pending" });
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 2, text: "Short." });
  });

  it("refuses an offer whose text became a saved secret's value", async () => {
    const offerId = test.offer("alice", "add", null, `Staging key ${SAVED_TOKEN}`);
    expect((await answer(await test.routes("alice").offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }), offerId))).body)
      .toMatchObject({ error: "memory_note_invalid", reason: "secret" });
    expect(test.state.notes.get("alice")).toBeUndefined();
  });

  it("answers another user's offer exactly as a missing one, and decides nothing", async () => {
    const offerId = test.offer("alice", "add", null, "Prefers short answers.");
    const bob = test.routes("bob");
    const foreign = await answer(await bob.offerPOST(request(`/api/me/memory/offers/${offerId}`, "POST", { decision: "accept" }), offerId));
    const missing = await answer(await bob.offerPOST(request("/api/me/memory/offers/offer-404", "POST", { decision: "accept" }), "offer-404"));
    expect(foreign).toEqual({ body: { error: "memory_note_offer_not_found" }, status: 404 });
    expect(missing).toEqual(foreign);
    expect(await answer(await bob.offerGET(request(`/api/me/memory/offers/${offerId}`), offerId))).toEqual(foreign);
    expect(await answer(await bob.offerGET(request("/api/me/memory/offers/..%2F"), "../"))).toEqual(foreign);
    expect(test.state.offers[0]).toMatchObject({ state: "pending" });
    expect(test.state.notes.size).toBe(0);
  });
});

describe("legacy suggestions", () => {
  it("page oldest first with an opaque cursor", async () => {
    for (let index = 0; index < 101; index += 1) test.legacy("alice", `s-${String(index).padStart(3, "0")}`, `Fact ${index}.`);
    test.legacy("bob", "s-bob", "Bob's fact.");
    const routes = test.routes("alice");
    const first = memoryLegacySuggestionPageSchema.parse((await answer(await routes.legacyGET(request("/api/me/memory/legacy")))).body);
    expect(first.suggestions).toHaveLength(100);
    expect(first.suggestions[0]).toMatchObject({ id: "s-000", origin: "automatic", text: "Fact 0." });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = memoryLegacySuggestionPageSchema.parse((await answer(await routes.legacyGET(
      request(`/api/me/memory/legacy?cursor=${encodeURIComponent(first.nextCursor!)}`)))).body);
    expect(second).toEqual({ nextCursor: null, suggestions: [expect.objectContaining({ id: "s-100" })] });
    for (const query of ["?cursor=not-a-cursor", "?cursor=a&cursor=b", "?page=2"]) {
      expect((await routes.legacyGET(request(`/api/me/memory/legacy${query}`))).status, query).toBe(400);
    }
  });

  it("keep one by appending it to the note and deleting it, remove one, and remove all, only the user's own", async () => {
    test.note("alice", "Use tables.", 1);
    test.legacy("alice", "keep-me", "Works on the billing service.");
    test.legacy("alice", "drop-me", "Had a cold in March.");
    test.legacy("alice", "rest", "Something else.");
    test.legacy("bob", "bobs", "Bob's fact.");
    const routes = test.routes("alice");
    const kept = await answer(await routes.legacyItemPOST(request("/api/me/memory/legacy/keep-me", "POST", { action: "keep" }), "keep-me"));
    expect(memoryNoteSchema.parse(kept.body)).toMatchObject({ lastChangedBy: "user", revision: 2, text: "Use tables.\nWorks on the billing service." });
    const removed = await answer(await routes.legacyItemPOST(request("/api/me/memory/legacy/drop-me", "POST", { action: "remove" }), "drop-me"));
    expect(removed.body).toMatchObject({ revision: 2 });
    expect(test.state.legacy.map((row) => row.id)).toEqual(["rest", "bobs"]);
    // Bob's suggestion is not Alice's to keep, nor is a removed one.
    for (const id of ["bobs", "drop-me"]) {
      expect(await answer(await routes.legacyItemPOST(request(`/api/me/memory/legacy/${id}`, "POST", { action: "keep" }), id)))
        .toEqual({ body: { error: "memory_legacy_suggestion_not_found" }, status: 404 });
    }
    expect((await answer(await routes.legacyDELETE(request("/api/me/memory/legacy", "DELETE")))).body).toEqual({ nextCursor: null, suggestions: [] });
    expect(test.state.legacy.map((row) => row.id)).toEqual(["bobs"]);
  });

  it("refuse keeping a suggestion that does not fit the note, leaving both as they were", async () => {
    test.note("alice", "x".repeat(MEMORY_NOTE_MAX_CHARACTERS - 3), 1);
    test.legacy("alice", "long", "Works on the billing service.");
    const refused = await answer(await test.routes("alice").legacyItemPOST(request("/api/me/memory/legacy/long", "POST", { action: "keep" }), "long"));
    expect(refused).toMatchObject({ body: { error: "memory_note_too_long", limit: MEMORY_NOTE_MAX_CHARACTERS }, status: 409 });
    expect(test.state.legacy).toHaveLength(1);
    expect(test.state.notes.get("alice")).toMatchObject({ revision: 1 });
  });
});
