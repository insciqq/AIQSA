import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryNote, MemoryNoteChangeCard, MemoryNoteOfferCard } from "@/lib/contracts/memoryNote";
import { ResourceChangeCardsV2 } from "./ResourceChangeCardV2";

const NOTE = "/api/me/memory/note";
const offerPath = (id: string) => `/api/me/memory/offers/${id}`;
const note = (text: string, revision: number): MemoryNote => ({ text, revision, lastChangedBy: "agent", updatedAt: "2026-11-22T10:00:00.000Z" });

type Handler = unknown | Response;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const refusal = (code: string, status: number) => json({ error: code }, status);
function respond(routes: Record<string, Handler | Handler[]>) {
  const calls = new Map<string, number>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const route = routes[key];
    if (route === undefined) return refusal("not_found", 404);
    const index = calls.get(key) ?? 0;
    calls.set(key, index + 1);
    const value = Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route;
    return value instanceof Response ? value : json(value);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const sent = (fetchMock: ReturnType<typeof respond>, method: string) => fetchMock.mock.calls
  .filter(([, init]) => init?.method === method).map(([url, init]) => [String(url), init?.body ? JSON.parse(String(init.body)) as unknown : null]);

// Cards on one page remember outcomes by identity (the revision a change left, an offer's id): each test uses its own.
let unique = 100;
const change = (overrides: Partial<MemoryNoteChangeCard> = {}): MemoryNoteChangeCard => ({ version: 1, resource: "memory_note", action: "added",
  revision: ++unique, before: null, after: "Answer in short bullet points.", previousText: "I work on billing.", ...overrides } as MemoryNoteChangeCard);
const offer = (overrides: Partial<MemoryNoteOfferCard> = {}): MemoryNoteOfferCard => ({ version: 1, resource: "memory_note", action: "offered",
  offerId: `offer_${++unique}`, operation: "add", before: null, after: "Prices go in a table.", ...overrides } as MemoryNoteOfferCard);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("memory note change card", () => {
  it("shows what was added and undoes it once, guarded by the revision the change left", async () => {
    const card = change();
    const fetchMock = respond({ [`GET ${NOTE}`]: note("I work on billing.\nAnswer in short bullet points.", card.revision),
      [`PUT ${NOTE}`]: note("I work on billing.", card.revision + 1) });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    const item = screen.getByTestId("resource-change-card");
    expect(item).toHaveAttribute("data-resource", "memory_note");
    expect(item).toHaveAccessibleName("Added to memory");
    expect(item).toHaveTextContent("Added to memory · from your next message");
    expect(within(item).getByLabelText("Added to memory")).toHaveTextContent("AddedAnswer in short bullet points.");
    expect(within(item).getByRole("link", { name: "Open Memory" })).toHaveAttribute("href", "/?library=memory");
    await waitFor(() => expect(item).toHaveAttribute("data-state", "current"));
    fireEvent.click(within(item).getByRole("button", { name: "Undo this change to your memory" }));
    await waitFor(() => expect(within(item).getByRole("status")).toHaveTextContent("Your note is back to the previous text from your next message."));
    expect(item).toHaveAccessibleName("Change undone");
    expect(within(item).queryByRole("button")).toBeNull();
    expect(sent(fetchMock, "PUT")).toEqual([[NOTE, { text: "I work on billing.", revision: card.revision }]]);
  });

  it("shows a replacement as before and now, and refuses Undo visibly once the note changed since", async () => {
    const card = change({ action: "replaced", before: "Answer in English.", after: "Answer in Russian." });
    const fetchMock = respond({ [`GET ${NOTE}`]: note("Answer in Russian.\nMore", card.revision + 2) });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    const item = screen.getByTestId("resource-change-card");
    const passages = within(item).getByLabelText("Memory updated");
    expect(passages).toHaveTextContent("BeforeAnswer in English.NowAnswer in Russian.");
    await waitFor(() => expect(within(item).getByRole("status"))
      .toHaveTextContent("Undo is not available: your note changed after this, and that change is kept."));
    expect(within(item).queryByRole("button", { name: /Undo/u })).toBeNull();
    expect(sent(fetchMock, "PUT")).toEqual([]);
  });

  it("turns a refused Undo into the refused state, and reads nothing while the answer runs", async () => {
    const card = change({ action: "removed", before: "Old rule.", after: null });
    const fetchMock = respond({ [`GET ${NOTE}`]: note("", card.revision), [`PUT ${NOTE}`]: refusal("memory_note_conflict", 409) });
    const { rerender } = render(<ResourceChangeCardsV2 cards={[card]} live />);
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<ResourceChangeCardsV2 cards={[card]} />);
    const item = screen.getByTestId("resource-change-card");
    await waitFor(() => expect(item).toHaveAttribute("data-state", "current"));
    fireEvent.click(within(item).getByRole("button", { name: "Undo this change to your memory" }));
    await waitFor(() => expect(item).toHaveAttribute("data-state", "changed"));
    expect(within(item).getByRole("status")).toHaveTextContent("Undo is not available");
  });
});

describe("memory note offer card", () => {
  it("asks with the proposed text, and Remember shows the change it made with Undo", async () => {
    const card = offer();
    const made = change({ revision: 900 });
    const fetchMock = respond({ [`GET ${offerPath(card.offerId)}`]: { offerId: card.offerId, state: "pending", decidedAt: null },
      [`POST ${offerPath(card.offerId)}`]: { offer: { offerId: card.offerId, state: "accepted", decidedAt: "2026-11-22T10:01:00.000Z" }, change: made },
      [`GET ${NOTE}`]: note("I work on billing.\nPrices go in a table.", 900) });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    const item = screen.getByTestId("resource-change-card");
    expect(item).toHaveAccessibleName("Remember this for future chats?");
    expect(within(item).getByLabelText("Remember this for future chats?", { selector: "dl" })).toHaveTextContent("AddPrices go in a table.");
    const question = within(item).getByRole("group", { name: "Remember this for future chats?" });
    fireEvent.click(within(question).getByRole("button", { name: "Remember" }));
    const remembered = await screen.findByRole("listitem", { name: "Remembered" });
    expect(within(remembered).getByRole("button", { name: "Undo this change to your memory" })).toBeInTheDocument();
    expect(sent(fetchMock, "POST")).toEqual([[offerPath(card.offerId), { decision: "accept" }]]);
  });

  it("No thanks settles it as not remembered", async () => {
    const card = offer({ operation: "remove", before: "Old rule.", after: null });
    const fetchMock = respond({ [`GET ${offerPath(card.offerId)}`]: refusal("internal", 500),
      [`POST ${offerPath(card.offerId)}`]: { offer: { offerId: card.offerId, state: "dismissed", decidedAt: "2026-11-22T10:01:00.000Z" }, change: null } });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    const item = screen.getByTestId("resource-change-card");
    expect(within(item).getByLabelText("Remember this for future chats?", { selector: "dl" })).toHaveTextContent("ForgetOld rule.");
    fireEvent.click(within(item).getByRole("button", { name: "No thanks" }));
    await waitFor(() => expect(item).toHaveAccessibleName("Not remembered"));
    expect(within(item).queryByRole("button")).toBeNull();
    expect(sent(fetchMock, "POST")).toEqual([[offerPath(card.offerId), { decision: "dismiss" }]]);
  });

  it("says an offer no longer fits and links to Settings › Memory", async () => {
    const card = offer({ operation: "replace", before: "Answer in English.", after: "Answer in Russian." });
    respond({ [`POST ${offerPath(card.offerId)}`]: refusal("memory_note_offer_stale", 409) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    const item = screen.getByTestId("resource-change-card");
    expect(within(item).getByLabelText("Remember this for future chats?", { selector: "dl" }))
      .toHaveTextContent("ReplaceAnswer in English.WithAnswer in Russian.");
    fireEvent.click(within(item).getByRole("button", { name: "Remember" }));
    await waitFor(() => expect(item).toHaveAccessibleName("No longer fits"));
    expect(within(item).getByRole("status")).toHaveTextContent("Your note changed since this was offered");
    expect(within(item).getByRole("link", { name: "Open Memory" })).toHaveAttribute("href", "/?library=memory");
  });

  it("keeps the verbs with a reason when Memory is off", async () => {
    const card = offer();
    respond({ [`POST ${offerPath(card.offerId)}`]: refusal("memory_disabled", 409) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    const item = screen.getByTestId("resource-change-card");
    fireEvent.click(within(item).getByRole("button", { name: "Remember" }));
    expect(await within(item).findByRole("alert")).toHaveTextContent("Memory is off");
    expect(within(item).getByRole("button", { name: "Remember" })).toBeEnabled();
  });

  it("shows a reloaded answer's offer as the server settled it", async () => {
    const accepted = offer();
    const dismissed = offer();
    respond({ [`GET ${offerPath(accepted.offerId)}`]: { offerId: accepted.offerId, state: "accepted", decidedAt: "2026-11-22T10:01:00.000Z" },
      [`GET ${offerPath(dismissed.offerId)}`]: { offerId: dismissed.offerId, state: "dismissed", decidedAt: "2026-11-22T10:01:00.000Z" } });
    render(<ResourceChangeCardsV2 cards={[accepted, dismissed]} />);
    expect(await screen.findByRole("listitem", { name: "Remembered" })).toBeInTheDocument();
    expect(await screen.findByRole("listitem", { name: "Not remembered" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remember" })).toBeNull();
  });
});
