import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_NOTE_MAX_CHARACTERS, type MemoryLegacySuggestion, type MemoryNote, type MemorySwitches } from "@/lib/contracts/memoryNote";
import { MemoryNoteSettingsV2 } from "./MemoryNoteSettingsV2";

const NOTE = "/api/me/memory/note";
const PREFERENCES = "/api/me/memory/preferences";
const LEGACY = "/api/me/memory/legacy";

const saved = (text: string, revision: number, lastChangedBy: MemoryNote["lastChangedBy"] = "user"): MemoryNote =>
  ({ text, revision, lastChangedBy, updatedAt: "2026-11-22T10:00:00.000Z" });
const ON: MemorySwitches = { memoryEnabled: true, pastChatSearchEnabled: true, memorySuggestionsEnabled: true };
const suggestion = (id: string, text: string): MemoryLegacySuggestion =>
  ({ id, text, origin: "automatic", createdAt: "2026-10-01T10:00:00.000Z" });

type Handler = unknown | Response | ((init?: RequestInit) => unknown);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const refusal = (code: string, status: number) => json({ error: code }, status);

/** Routes by "METHOD path"; a handler list answers successive calls in turn, its last entry repeating. */
function respond(routes: Record<string, Handler | Handler[]>) {
  const calls = new Map<string, number>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const route = routes[key];
    if (route === undefined) return refusal("not_found", 404);
    const index = calls.get(key) ?? 0;
    calls.set(key, index + 1);
    const handler = Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route;
    const value = typeof handler === "function" ? (handler as (init?: RequestInit) => unknown)(init) : handler;
    return value instanceof Response ? value : json(value);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const sent = (fetchMock: ReturnType<typeof respond>, method: string) => fetchMock.mock.calls
  .filter(([, init]) => init?.method === method).map(([url, init]) => [String(url), init?.body ? JSON.parse(String(init.body)) as unknown : null]);
const page = (suggestions: MemoryLegacySuggestion[] = [], nextCursor: string | null = null) => ({ suggestions, nextCursor });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MemoryNoteSettingsV2: the note", () => {
  it("explains an empty note, counts characters as the limit does and saves the whole text with its revision", async () => {
    const fetchMock = respond({ [`GET ${NOTE}`]: { text: "", revision: 0, lastChangedBy: null, updatedAt: null },
      [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page(), [`PUT ${NOTE}`]: saved("Answer briefly 👍", 1) });
    const onDirtyChange = vi.fn();
    render(<MemoryNoteSettingsV2 onDirtyChange={onDirtyChange} />);
    const editor = await screen.findByRole("textbox", { name: "Memory note" });
    expect(editor).toHaveAccessibleDescription(/Nothing here yet/u);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(editor, { target: { value: "Answer briefly 👍" } });
    // The emoji is one character, as PostgreSQL counts it.
    expect(screen.getByTestId("memory-note-counter")).toHaveTextContent("16 / 6,000 characters");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved. Answers use it from your next message."));
    expect(sent(fetchMock, "PUT")).toEqual([[NOTE, { text: "Answer briefly 👍", revision: 0 }]]);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/Last changed by you/u)).toBeInTheDocument();
    expect(screen.queryByTestId("memory-legacy-suggestions")).toBeNull();
  });

  it("refuses to save over the limit and says why", async () => {
    const fetchMock = respond({ [`GET ${NOTE}`]: saved("short", 3), [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page() });
    render(<MemoryNoteSettingsV2 />);
    const editor = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(editor, { target: { value: "x".repeat(MEMORY_NOTE_MAX_CHARACTERS + 1) } });
    expect(screen.getByTestId("memory-note-counter")).toHaveAttribute("data-over", "true");
    expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("over its limit of 6,000 characters");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(editor, { ctrlKey: true, key: "s" });
    expect(sent(fetchMock, "PUT")).toEqual([]);
  });

  it("keeps the user's text when the note changed elsewhere, then saves over the latest revision on request", async () => {
    const fetchMock = respond({
      [`GET ${NOTE}`]: [saved("Old", 2), saved("Old\nAdded in a chat", 3, "agent")],
      [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page(),
      [`PUT ${NOTE}`]: [refusal("memory_note_conflict", 409), saved("Mine", 4)]
    });
    render(<MemoryNoteSettingsV2 />);
    const editor = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(editor, { target: { value: "Mine" } });
    fireEvent.keyDown(editor, { metaKey: true, key: "s" });
    const conflict = await screen.findByTestId("memory-note-conflict");
    expect(conflict).toHaveTextContent("The note changed elsewhere");
    await waitFor(() => expect(within(conflict).getByLabelText("Saved note")).toHaveTextContent("Added in a chat"));
    expect(editor).toHaveValue("Mine");
    fireEvent.click(within(conflict).getByRole("button", { name: "Keep my text and save over it" }));
    await waitFor(() => expect(screen.queryByTestId("memory-note-conflict")).toBeNull());
    expect(sent(fetchMock, "PUT")).toEqual([[NOTE, { text: "Mine", revision: 2 }], [NOTE, { text: "Mine", revision: 3 }]]);
    expect(editor).toHaveValue("Mine");
  });

  it("replaces the draft with the saved note when the user chooses it", async () => {
    respond({ [`GET ${NOTE}`]: [saved("Old", 2), saved("Newer", 5, "agent")], [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page(),
      [`PUT ${NOTE}`]: refusal("memory_note_conflict", 409) });
    render(<MemoryNoteSettingsV2 />);
    const editor = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(editor, { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace my text with the saved note" }));
    expect(editor).toHaveValue("Newer");
    expect(screen.queryByTestId("memory-note-conflict")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/Last changed in a chat/u)).toBeInTheDocument();
  });

  it("names a refused secret and keeps the text", async () => {
    respond({ [`GET ${NOTE}`]: saved("", 1), [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page(),
      [`PUT ${NOTE}`]: refusal("memory_note_invalid", 400) });
    render(<MemoryNoteSettingsV2 />);
    const editor = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(editor, { target: { value: "token sk-not-real" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("such as a password or key");
    expect(editor).toHaveValue("token sk-not-real");
  });

  it("shows a calm Reload after a failed read instead of an empty note", async () => {
    respond({ [`GET ${NOTE}`]: [refusal("internal", 500), saved("Back", 1)], [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page() });
    render(<MemoryNoteSettingsV2 />);
    const reload = within(await screen.findByTestId("memory-note-reload")).getByRole("button", { name: "Reload" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(reload);
    expect(await screen.findByRole("textbox", { name: "Memory note" })).toHaveValue("Back");
  });

  it("clears the note only after a confirmation", async () => {
    const fetchMock = respond({ [`GET ${NOTE}`]: saved("Something", 7), [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page(),
      [`PUT ${NOTE}`]: saved("", 8) });
    render(<MemoryNoteSettingsV2 />);
    await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.click(screen.getByRole("button", { name: "Clear note…" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear your note?" });
    expect(sent(fetchMock, "PUT")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm clear note" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(fetchMock, "PUT")).toEqual([[NOTE, { text: "", revision: 7 }]]);
    expect(screen.getByRole("textbox", { name: "Memory note" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Clear note…" })).toBeDisabled();
  });
});

describe("MemoryNoteSettingsV2: switches", () => {
  it("saves one switch at a time and disables the dependent ones while Memory is off", async () => {
    const fetchMock = respond({ [`GET ${NOTE}`]: saved("", 1), [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page(),
      [`PATCH ${PREFERENCES}`]: { ...ON, memoryEnabled: false } });
    render(<MemoryNoteSettingsV2 />);
    const master = await screen.findByRole("switch", { name: "Use Memory in answers" });
    await waitFor(() => expect(master).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("switch", { name: "Search past chats" })).toBeEnabled();
    fireEvent.click(master);
    await waitFor(() => expect(master).toHaveAttribute("aria-checked", "false"));
    expect(sent(fetchMock, "PATCH")).toEqual([[PREFERENCES, { memoryEnabled: false }]]);
    expect(screen.getByRole("switch", { name: "Search past chats" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Offer to remember" })).toBeDisabled();
    // The switches keep their values; Memory off says so without hiding the note.
    expect(screen.getByRole("switch", { name: "Offer to remember" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Memory is off, so answers do not read the note/u)).toBeInTheDocument();
  });
});

describe("MemoryNoteSettingsV2: earlier automatic memories", () => {
  it("keeps one into the note, removes another, and the section leaves with the last one", async () => {
    const fetchMock = respond({
      [`GET ${NOTE}`]: saved("Answer briefly", 1), [`GET ${PREFERENCES}`]: ON,
      [`GET ${LEGACY}`]: page([suggestion("s1", "Works on billing"), suggestion("s2", "Lives near the office")]),
      [`POST ${LEGACY}/s1`]: saved("Answer briefly\nWorks on billing", 2), [`POST ${LEGACY}/s2`]: new Response(null, { status: 204 })
    });
    render(<MemoryNoteSettingsV2 />);
    const section = await screen.findByTestId("memory-legacy-suggestions");
    expect(within(section).getByRole("heading", { name: "Earlier memories (2)" })).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Keep in note: Works on billing" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Memory note" })).toHaveValue("Answer briefly\nWorks on billing"));
    expect(within(section).getAllByTestId("memory-legacy-row")).toHaveLength(1);
    fireEvent.click(within(section).getByRole("button", { name: "Remove: Lives near the office" }));
    await waitFor(() => expect(screen.queryByTestId("memory-legacy-suggestions")).toBeNull());
    expect(sent(fetchMock, "POST")).toEqual([[`${LEGACY}/s1`, { action: "keep" }], [`${LEGACY}/s2`, { action: "remove" }]]);
  });

  it("offers Keep only while the editor holds the saved note, and says when the note has no room", async () => {
    respond({ [`GET ${NOTE}`]: saved("Full", 1), [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page([suggestion("s1", "Long fact")]),
      [`POST ${LEGACY}/s1`]: refusal("memory_note_too_long", 409) });
    render(<MemoryNoteSettingsV2 />);
    const keep = await screen.findByRole("button", { name: "Keep in note: Long fact" });
    fireEvent.change(screen.getByRole("textbox", { name: "Memory note" }), { target: { value: "Full, edited" } });
    expect(keep).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Memory note" }), { target: { value: "Full" } });
    fireEvent.click(keep);
    expect(await within(screen.getByTestId("memory-legacy-row")).findByRole("alert")).toHaveTextContent("no room in your note");
  });

  it("says a suggestion holding a credential can only be removed", async () => {
    respond({ [`GET ${NOTE}`]: saved("Note", 1), [`GET ${PREFERENCES}`]: ON, [`GET ${LEGACY}`]: page([suggestion("s1", "Fact")]),
      [`POST ${LEGACY}/s1`]: refusal("memory_note_invalid", 400) });
    render(<MemoryNoteSettingsV2 />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep in note: Fact" }));
    expect(await within(screen.getByTestId("memory-legacy-row")).findByRole("alert")).toHaveTextContent("Remove it instead");
  });

  it("removes all after a confirmation", async () => {
    const fetchMock = respond({ [`GET ${NOTE}`]: saved("", 1), [`GET ${PREFERENCES}`]: ON,
      [`GET ${LEGACY}`]: page([suggestion("s1", "One")], "cursor-2"), [`DELETE ${LEGACY}`]: new Response(null, { status: 204 }) });
    render(<MemoryNoteSettingsV2 />);
    const section = await screen.findByTestId("memory-legacy-suggestions");
    // More wait on the server: the count says so.
    expect(within(section).getByRole("heading", { name: "Earlier memories (1+)" })).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Remove all" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove all earlier memories?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm remove all" }));
    await waitFor(() => expect(screen.queryByTestId("memory-legacy-suggestions")).toBeNull());
    expect(sent(fetchMock, "DELETE")).toEqual([[LEGACY, null]]);
  });
});
